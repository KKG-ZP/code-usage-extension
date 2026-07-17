// ZCode hybrid-source integration test.
//
// A zero-token model_usage row must fall back to the local model-io rollout.
// Once the database contains non-zero provider usage, that exact row must
// replace (not add to) the estimate for the same day/model.
//
// Run with: gjs -m tests/worker/zcode-fallback.test.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const TEXT_ENCODER = new TextEncoder();
const _src = Gio.File.new_for_uri(import.meta.url);
const REPO_ROOT = _src.get_parent().get_parent().get_parent().get_path();
const WORKER_SCRIPT = GLib.build_filenamev([REPO_ROOT, 'worker', 'usage-worker.js']);

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function write(path, content) { GLib.file_set_contents(path, TEXT_ENCODER.encode(content)); }
function readJson(path) {
    const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
    return ok ? JSON.parse(new TextDecoder().decode(contents)) : null;
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
function sqlite(dbPath, sql) {
    const candidates = ['/usr/bin/sqlite3', '/usr/local/bin/sqlite3'];
    for (const dir of (GLib.getenv('PATH') || '').split(':')) {
        if (dir) candidates.push(GLib.build_filenamev([dir, 'sqlite3']));
    }
    const sqlite3 = candidates.find(path => Gio.File.new_for_path(path).query_exists(null));
    if (!sqlite3) throw new Error('sqlite3 not found');
    const proc = Gio.Subprocess.new([sqlite3, dbPath, sql],
        Gio.SubprocessFlags.STDERR_PIPE);
    const [ok, stdout, stderr] = proc.communicate_utf8(null, null);
    if (!ok || (stderr || '').trim()) throw new Error(`sqlite: ${(stderr || '').trim()}`);
}
function runWorker(zcodeHome, dataHome) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    launcher.setenv('ZCODE_HOME', zcodeHome, true);
    launcher.setenv('XDG_DATA_HOME', dataHome, true);
    const proc = launcher.spawnv([
        'gjs', '-m', WORKER_SCRIPT,
        '--extension-path', REPO_ROOT,
        '--agents', 'zcode',
        '--exchange-rate', '7.25',
    ]);
    return new Promise((resolve) => {
        proc.communicate_utf8_async(null, null, (p, result) => {
            const [ok, stdout, stderr] = p.communicate_utf8_finish(result);
            resolve({
                ok: ok && p.get_exit_status() === 0,
                stdout: (stdout || '').trim(),
                stderr: (stderr || '').trim(),
                status: p.get_exit_status(),
            });
        });
    });
}

async function main() {
    const root = GLib.dir_make_tmp('code-usage-zcode-fallback-XXXXXX');
    try {
        const dataHome = GLib.build_filenamev([root, 'data']);
        const snapshotPath = GLib.build_filenamev([
            dataHome, 'code-usage-extension', 'compact-snapshot.json',
        ]);
        const dbDir = GLib.build_filenamev([root, 'db']);
        const rolloutDir = GLib.build_filenamev([root, 'rollout']);
        GLib.mkdir_with_parents(dbDir, 0o755);
        GLib.mkdir_with_parents(rolloutDir, 0o755);
        const dbPath = GLib.build_filenamev([dbDir, 'db.sqlite']);
        sqlite(dbPath,
            "CREATE TABLE model_usage (id text primary key, started_at integer, model_id text, input_tokens integer, output_tokens integer, cache_creation_input_tokens integer, cache_read_input_tokens integer, status text);" +
            "INSERT INTO model_usage VALUES ('req-1',1784188800000,'glm-5.2:cloud',0,0,0,0,'completed');");

        const rollout = {
            type: 'model_io', requestId: 'req-1',
            completedAt: '2026-07-16T10:00:00Z',
            model: { modelId: 'glm-5.2:cloud' },
            request: {
                body: { model: 'glm-5.2:cloud', tools: [{ type: 'function', name: 'Read' }] },
                messages: [{ role: 'user', content: 'A'.repeat(4000) }],
            },
            response: { text: 'fixed', toolCalls: [] },
        };
        write(GLib.build_filenamev([rolloutDir, 'model-io-session.jsonl']), JSON.stringify(rollout) + '\n');

        let result = await runWorker(root, dataHome);
        assert(result.ok, `fallback scan failed (${result.status}): ${result.stderr}; ${result.stdout}`);
        let snapshot = readJson(snapshotPath);
        assert(snapshot.dailyUsage.length === 1,
            `fallback rows: ${snapshot.dailyUsage.length}; data=${JSON.stringify(snapshot.dailyUsage)}; status=${result.stdout}`);
        let row = snapshot.dailyUsage[0];
        assert(row.estimated === true && row.usageSource === 'rollout-estimate',
            `fallback marker: ${row.estimated}/${row.usageSource}`);
        assert(row.inputTokens > 1000, `fallback input estimate: ${row.inputTokens}`);
        assert(row.requestCount === 1, `fallback requests: ${row.requestCount}`);

        sqlite(dbPath,
            "UPDATE model_usage SET input_tokens=1200, output_tokens=300 WHERE id='req-1';");
        // Use a cold cache for the source-preference assertion; SQLite can
        // preserve file size and sub-second mtime across an in-place UPDATE.
        const exactDataHome = GLib.build_filenamev([root, 'exact-data']);
        const exactSnapshotPath = GLib.build_filenamev([
            exactDataHome, 'code-usage-extension', 'compact-snapshot.json',
        ]);
        result = await runWorker(root, exactDataHome);
        assert(result.ok, `exact scan failed: ${result.stderr}`);
        snapshot = readJson(exactSnapshotPath);
        assert(snapshot.dailyUsage.length === 1, `exact rows: ${snapshot.dailyUsage.length}`);
        row = snapshot.dailyUsage[0];
        assert(row.usageSource === 'database' && row.estimated !== true,
            `exact marker: ${row.usageSource}/${row.estimated}`);
        assert(row.inputTokens === 1200 && row.outputTokens === 300,
            `exact tokens must replace estimate: ${row.inputTokens}/${row.outputTokens}`);

        print('zcode fallback tests passed');
    } finally {
        removeTree(root);
    }
}

const loop = GLib.MainLoop.new(null, false);
main().then(() => loop.quit())
    .catch((e) => { console.error(`zcode fallback tests FAILED: ${e.message}`); loop.quit(); });
loop.run();
