// Worker integration tests.
//
// Spawns the standalone usage-worker.js as a subprocess against a temp
// directory of fake agent logs, then asserts on the snapshot + file-state
// the worker writes. Covers the stage-1 contracts:
//   * snapshot is produced from a JSONL log
//   * a second run with unchanged files skips re-parsing (changedFiles=0)
//   * appending bytes triggers an incremental re-parse
//   * a worker failure (missing --agents) leaves the previous snapshot intact
//
// Run with: gjs -m tests/worker/worker.test.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const TEXT_ENCODER = new TextEncoder();
// import.meta.url is a percent-encoded file:// URI; Gio.File.new_for_uri
// decodes it (new_for_path leaves %E9... escapes in place, which then fail
// to resolve on disk). tests/worker/worker.test.js → repo root = 3 hops.
const _src = Gio.File.new_for_uri(import.meta.url);
const REPO_ROOT = _src.get_parent().get_parent().get_parent().get_path();
const WORKER_SCRIPT = GLib.build_filenamev([REPO_ROOT, 'worker', 'usage-worker.js']);
const SNAPSHOT_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'code-usage-extension']);

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function write(path, content) {
    GLib.file_set_contents(path, TEXT_ENCODER.encode(content));
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

function runWorker(args, env = {}) {
    // In gjs -m mode, top-level `await` drives the GLib main loop, so a plain
    // Promise resolved from communicate_utf8_async's callback works without
    // us spinning our own loop (spinning a nested loop actually deadlocks
    // against the outer loop gjs runs for top-level await).
    const argv = ['gjs', '-m', WORKER_SCRIPT, ...args];
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    for (const [k, v] of Object.entries(env)) {
        launcher.setenv(k, v, true);
    }
    let proc;
    try {
        proc = launcher.spawnv(argv);
    } catch (e) {
        return Promise.resolve({ ok: false, stdout: '', stderr: e.message, status: null });
    }
    return new Promise((resolve) => {
        proc.communicate_utf8_async(null, null, (p, r) => {
            let out = { ok: false, stdout: '', stderr: '', status: p.get_exit_status() };
            try {
                const [ok, stdout, stderr] = p.communicate_utf8_finish(r);
                out = { ok, stdout: stdout.trim(), stderr: stderr.trim(), status: p.get_exit_status() };
            } catch (e) {
                out.stderr = e.message;
            }
            resolve(out);
        });
    });
}

// Codex-format JSONL lines.
function codexLine(date, model, input, output, cached) {
    const obj = {
        type: 'event_msg',
        timestamp: `${date}T10:00:00Z`,
        payload: {
            type: 'token_count',
            info: {
                last_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached },
                model,
            },
        },
    };
    return JSON.stringify(obj);
}

async function main() {
    const root = GLib.dir_make_tmp('code-usage-worker-test-XXXXXX');
    try {
        const codexHome = GLib.build_filenamev([root, 'codex']);
        const sessionsDir = GLib.build_filenamev([codexHome, 'sessions']);
        GLib.mkdir_with_parents(sessionsDir, 0o755);
        const logPath = GLib.build_filenamev([sessionsDir, 'rollout-test.jsonl']);

        write(logPath, codexLine('2026-07-14', 'gpt-5.5-codex', 120000, 3000, 20000) + '\n');

        const workerEnv = { CODEX_HOME: codexHome };

        // 1. First scan produces a snapshot with the expected row.
        let r = await runWorker([
            '--extension-path', REPO_ROOT,
            '--agents', 'codex',
            '--exchange-rate', '7.25',
        ], workerEnv);
        assert(r.ok, `first scan should succeed; stderr=${r.stderr}`);
        const status1 = JSON.parse(r.stdout);
        assert(status1.status === 'complete', `first scan status: ${status1.status}`);
        assert(status1.changedFiles === 1, `first scan changedFiles: ${status1.changedFiles}`);
        assert(status1.agents.codex.status === 'ok', 'codex agent ok');

        const snap1 = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'compact-snapshot.json']));
        assert(snap1 && snap1.schemaVersion === 1, 'snapshot written with schemaVersion 1');
        assert(snap1.dailyUsage.length === 1, `dailyUsage rows: ${snap1.dailyUsage.length}`);
        const row = snap1.dailyUsage[0];
        assert(row.date === '2026-07-14' && row.agent === 'codex' && row.raw_model === 'gpt-5.5-codex',
            `row identity: ${row.date}/${row.agent}/${row.raw_model}`);
        assert(row.inputTokens === 120000, `inputTokens: ${row.inputTokens}`);
        assert(row.requestCount === 1, `requestCount: ${row.requestCount}`);

        // 2. Second scan with unchanged file skips re-parse.
        r = await runWorker([
            '--extension-path', REPO_ROOT, '--agents', 'codex', '--exchange-rate', '7.25',
        ], workerEnv);
        const status2 = JSON.parse(r.stdout);
        assert(status2.changedFiles === 0, `second scan should skip unchanged; changedFiles=${status2.changedFiles}`);
        const snap2 = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'compact-snapshot.json']));
        assert(snap2.dailyUsage.length === 1, 'unchanged scan preserves the row');

        // 3. Appending a new record triggers re-parse of the changed file.
        write(logPath,
            codexLine('2026-07-14', 'gpt-5.5-codex', 120000, 3000, 20000) + '\n' +
            codexLine('2026-07-15', 'gpt-5.5-codex', 35000, 800, 4000) + '\n');
        r = await runWorker([
            '--extension-path', REPO_ROOT, '--agents', 'codex', '--exchange-rate', '7.25',
        ], workerEnv);
        const status3 = JSON.parse(r.stdout);
        assert(status3.changedFiles === 1, `append should re-parse; changedFiles=${status3.changedFiles}`);
        const snap3 = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'compact-snapshot.json']));
        assert(snap3.dailyUsage.length === 2, `two dates after append; rows=${snap3.dailyUsage.length}`);

        // 4. A failing worker (missing --agents) does NOT overwrite the
        //    previous snapshot: failure must never pollute the last good
        //    result. The worker prints an error to stderr and returns early
        //    without running a scan, so the snapshot stays as it was. We
        //    trigger a real arg error (missing --extension-path); an empty
        //    --agents is no longer an error since stage 6 (it allows the
        //    legacy migration fallback to run).
        r = await runWorker(['--agents', 'codex', '--exchange-rate', '7.25'], workerEnv);
        assert(r.stderr && r.stderr.includes('missing --extension-path'),
            `bad-args run should report error; stderr=${r.stderr.slice(0,120)}`);
        const snap4 = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'compact-snapshot.json']));
        assert(snap4 && snap4.dailyUsage.length === 2,
            `previous snapshot preserved after failed run; rows=${snap4?.dailyUsage?.length}`);

        print('worker tests passed');
    } finally {
        removeTree(root);
        // Clean the snapshot+file-state we wrote so the test is idempotent.
        for (const f of ['compact-snapshot.json', 'file-state.json']) {
            try { Gio.File.new_for_path(GLib.build_filenamev([SNAPSHOT_DIR, f])).delete(null); } catch (_e) {}
        }
    }
}

// gjs -m top-level await does NOT drive the GLib main context, but the
// worker subprocess uses communicate_utf8_async which needs one. Spin a
// loop here and quit it when main() settles.
const loop = GLib.MainLoop.new(null, false);
let _exited = false;
main().then(() => { _exited = true; loop.quit(); })
    .catch((e) => { _exited = true; console.error(`worker tests FAILED: ${e.message}`); loop.quit(); });
loop.run();
if (!_exited) console.error('worker tests: loop exited before main() settled');