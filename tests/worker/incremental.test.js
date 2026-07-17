// Stage-2 JSONL incremental-read integration tests.
//
// Spawns usage-worker.js against a temp CODEX_HOME and asserts the
// offset-incremental contracts:
//   * an append triggers an incremental read (processedBytes reflects only
//     the appended bytes, not the whole file)
//   * appended records accumulate into the existing per-day contribution
//     (no double-count, no loss)
//   * a truncate forces a full re-parse (contributions overwritten, not
//     merged on top of stale data)
//   * Codex per-file session model survives across an incremental read:
//     an appended token_count record without an explicit model field
//     inherits the model from the file's earlier turn_context via the
//     persisted parser_state (does NOT fall back to the generic 'codex')
//
// Run with: gjs -m tests/worker/incremental.test.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const TEXT_ENCODER = new TextEncoder();
const _src = Gio.File.new_for_uri(import.meta.url);
const REPO_ROOT = _src.get_parent().get_parent().get_parent().get_path();
const WORKER_SCRIPT = GLib.build_filenamev([REPO_ROOT, 'worker', 'usage-worker.js']);
const SNAPSHOT_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'code-usage-extension']);

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function write(path, content) {
    GLib.file_set_contents(path, TEXT_ENCODER.encode(content));
}
function append(path, content) {
    // True append via Gio (preserves inode so decideRefresh sees append-only
    // growth, not a rewrite that changes inode and forces a full re-parse).
    const f = Gio.File.new_for_path(path);
    const stream = f.append_to(Gio.FileCreateFlags.NONE, null);
    stream.write_all(TEXT_ENCODER.encode(content), null);
    stream.close(null);
}
function readJson(path) {
    const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(contents));
}
function removeTree(path) {
    const f = Gio.File.new_for_path(path);
    if (!f.query_exists(null)) return;
    try {
        const info = f.query_info('standard::type', Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            const en = f.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let child;
            try { while ((child = en.next_file(null)) !== null) removeTree(f.get_child(child.get_name()).get_path()); }
            finally { en.close(null); }
        }
    } catch (_e) {}
    try { f.delete(null); } catch (_e) {}
}
function cleanArtifacts() {
    for (const f of ['compact-snapshot.json', 'file-state.json']) {
        try { Gio.File.new_for_path(GLib.build_filenamev([SNAPSHOT_DIR, f])).delete(null); } catch (_e) {}
    }
}

function runWorker(args, env) {
    const argv = ['gjs', '-m', WORKER_SCRIPT, ...args];
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    for (const [k, v] of Object.entries(env || {})) launcher.setenv(k, v, true);
    let proc;
    try { proc = launcher.spawnv(argv); }
    catch (e) { return Promise.resolve({ ok: false, stdout: '', stderr: e.message }); }
    return new Promise((resolve) => {
        proc.communicate_utf8_async(null, null, (p, r) => {
            let out = { ok: false, stdout: '', stderr: '' };
            try {
                const [ok, stdout, stderr] = p.communicate_utf8_finish(r);
                out = { ok, stdout: stdout.trim(), stderr: stderr.trim() };
            } catch (e) { out.stderr = e.message; }
            resolve(out);
        });
    });
}

// Codex-format lines.
function ctx(model) {
    return JSON.stringify({ type: 'turn_context', payload: { type: 'turn_context', model } });
}
function tc(date, model, input, output, cached) {
    const info = { last_token_usage: { input_tokens: input, output_tokens: output } };
    if (cached != null) info.last_token_usage.cached_input_tokens = cached;
    if (model) info.model = model;
    return JSON.stringify({ type: 'event_msg', timestamp: `${date}T10:00:00Z`, payload: { type: 'token_count', info } });
}

async function main() {
    const root = GLib.dir_make_tmp('code-usage-inc-XXXXXX');
    try {
        const codexHome = GLib.build_filenamev([root, 'codex']);
        const sessionsDir = GLib.build_filenamev([codexHome, 'sessions']);
        GLib.mkdir_with_parents(sessionsDir, 0o755);
        const logPath = GLib.build_filenamev([sessionsDir, 'rollout-inc.jsonl']);
        const env = { CODEX_HOME: codexHome };
        const args = ['--extension-path', REPO_ROOT, '--agents', 'codex', '--exchange-rate', '7.25'];

        // 1. Full scan: two records on 2026-07-15.
        write(logPath, ctx('gpt-5.5-codex') + '\n' +
            tc('2026-07-15', 'gpt-5.5-codex', 1000, 500, 200) + '\n' +
            tc('2026-07-15', 'gpt-5.5-codex', 2000, 800, 400) + '\n');
        let r = await runWorker(args, env);
        assert(r.ok, `scan1 failed; stderr=${r.stderr}`);
        const st1 = JSON.parse(r.stdout);
        assert(st1.changedFiles === 1 && st1.parsedRecords === 2, `scan1 changed/parsed: ${st1.changedFiles}/${st1.parsedRecords}`);
        const snap1 = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'compact-snapshot.json']));
        assert(snap1.dailyUsage.length === 1, `scan1 rows: ${snap1.dailyUsage.length}`);
        assert(snap1.dailyUsage[0].inputTokens === 3000, `scan1 inputTokens: ${snap1.dailyUsage[0].inputTokens}`);
        assert(snap1.dailyUsage[0].raw_model === 'gpt-5.5-codex', `scan1 model: ${snap1.dailyUsage[0].raw_model}`);

        // 2. Append a record on 2026-07-16. Must be incremental: only the
        //    appended bytes are read, and the new record accumulates (the
        //    2026-07-15 row is preserved, a 2026-07-16 row is added).
        const appendedLine = tc('2026-07-16', 'gpt-5.5-codex', 500, 200, 50);
        append(logPath, appendedLine + '\n');
        r = await runWorker(args, env);
        const st2 = JSON.parse(r.stdout);
        assert(st2.changedFiles === 1, `scan2 changed: ${st2.changedFiles}`);
        assert(st2.processedBytes < 250, `scan2 should read only appended bytes; got ${st2.processedBytes}`);
        assert(st2.parsedRecords === 1, `scan2 should parse only the 1 appended record; got ${st2.parsedRecords}`);
        const snap2 = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'compact-snapshot.json']));
        assert(snap2.dailyUsage.length === 2, `scan2 rows: ${snap2.dailyUsage.length}`);
        const jul15 = snap2.dailyUsage.find(x => x.date === '2026-07-15');
        const jul16 = snap2.dailyUsage.find(x => x.date === '2026-07-16');
        assert(jul15 && jul15.inputTokens === 3000, `scan2 jul15 preserved: ${jul15?.inputTokens}`);
        assert(jul16 && jul16.inputTokens === 500, `scan2 jul16 added: ${jul16?.inputTokens}`);
        assert(jul16.raw_model === 'gpt-5.5-codex', `scan2 jul16 model: ${jul16?.raw_model}`);

        // 3. Truncate back to a single 2026-07-15 record. Must trigger a
        //    full re-parse (not incremental merge), so the 2026-07-16 row
        //    disappears and 2026-07-15 reflects only the surviving record.
        write(logPath, ctx('gpt-5.5-codex') + '\n' +
            tc('2026-07-15', 'gpt-5.5-codex', 1000, 500, 200) + '\n');
        r = await runWorker(args, env);
        const st3 = JSON.parse(r.stdout);
        assert(st3.changedFiles === 1, `scan3 changed: ${st3.changedFiles}`);
        const snap3 = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'compact-snapshot.json']));
        assert(snap3.dailyUsage.length === 1, `scan3 rows after truncate: ${snap3.dailyUsage.length}`);
        assert(snap3.dailyUsage[0].date === '2026-07-15' && snap3.dailyUsage[0].inputTokens === 1000,
            `scan3 should reflect only the surviving record; got ${snap3.dailyUsage[0].date}/${snap3.dailyUsage[0].inputTokens}`);

        // 4. Codex parser_state continuity. Use a FRESH codex home so the
        //    earlier tests' log files don't contribute rows here.
        cleanArtifacts();
        const codexHome2 = GLib.build_filenamev([root, 'codex2']);
        const sessions2 = GLib.build_filenamev([codexHome2, 'sessions']);
        GLib.mkdir_with_parents(sessions2, 0o755);
        const env2 = { CODEX_HOME: codexHome2 };
        const log2 = GLib.build_filenamev([sessions2, 'rollout-state.jsonl']);
        write(log2, ctx('codex-special-model') + '\n' +
            tc('2026-07-14', null, 100, 50) + '\n');
        await runWorker(args, env2);
        const snap4a = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'compact-snapshot.json']));
        // append a model-less token_count; model should be inherited
        append(log2, tc('2026-07-14', null, 200, 80) + '\n');
        await runWorker(args, env2);
        const snap4 = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'compact-snapshot.json']));
        if (snap4.dailyUsage.length !== 1) {
            printerr(`[state-test] rows=${snap4.dailyUsage.length}; ${JSON.stringify(snap4.dailyUsage)}`);
        }
        assert(snap4.dailyUsage.length === 1, `state-test rows: ${snap4.dailyUsage.length}`);
        assert(snap4.dailyUsage[0].raw_model === 'codex-special-model',
            `appended model-less record should inherit codex-special-model via parser_state; got ${snap4.dailyUsage[0].raw_model}`);
        assert(snap4.dailyUsage[0].inputTokens === 300, `state-test tokens: ${snap4.dailyUsage[0].inputTokens}`);

        print('incremental tests passed');
    } finally {
        removeTree(root);
        cleanArtifacts();
    }
}

const loop = GLib.MainLoop.new(null, false);
main().then(() => loop.quit())
    .catch((e) => { console.error(`incremental tests FAILED: ${e.message}`); loop.quit(); });
loop.run();