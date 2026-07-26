// Regression test for the SQLite null-watermark double-count bug.
//
// When file-state's cached.last_row_id is null/undefined (lost state from a
// prior version or migration gap), decideRefresh still returns 'incremental'
// for a SQLite db whose stat changed. parseSQLiteAgent falls back to a
// full-table query (no `rowid > ?` clause), and the worker's incremental merge
// path accumulates the full result on top of the cached contributions —
// multiplying the totals by the number of scans.
//
// The fix in usage-worker.js downgrades the decision to 'full' when the
// watermark is null, so contributions are overwritten instead of merged. This
// test reproduces the original failure and guards the fix.
//
// Run with: gjs -m tests/worker/sqlite-watermark.test.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const TEXT_ENCODER = new TextEncoder();
const _src = Gio.File.new_for_uri(import.meta.url);
const REPO_ROOT = _src.get_parent().get_parent().get_parent().get_path();
const WORKER_SCRIPT = GLib.build_filenamev([REPO_ROOT, 'worker', 'usage-worker.js']);
const SNAPSHOT_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'code-usage-extension']);

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function runSqliteCli(dbPath, sql) {
    const sqlite3 = _findSqlite3Path();
    if (!sqlite3) throw new Error('sqlite3 not found');
    const argv = [sqlite3, dbPath, sql];
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [ok, stdout, stderr] = proc.communicate_utf8(null, null);
    if (stderr && stderr.trim()) throw new Error(`sqlite3 cli: ${stderr.trim()}`);
}

let _sqlite3Path = null;
function _findSqlite3Path() {
    if (_sqlite3Path !== null) return _sqlite3Path;
    const candidates = ['/usr/bin/sqlite3', '/usr/local/bin/sqlite3'];
    const pathEnv = GLib.getenv('PATH') || '';
    for (const p of pathEnv.split(':')) {
        if (p) candidates.push(GLib.build_filenamev([p.trim(), 'sqlite3']));
    }
    for (const c of candidates) {
        if (Gio.File.new_for_path(c).query_exists(null)) { _sqlite3Path = c; break; }
    }
    return _sqlite3Path;
}

function readJson(path) {
    const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(contents));
}

function writeJson(path, obj) {
    GLib.file_set_contents(path, TEXT_ENCODER.encode(JSON.stringify(obj, null, 2)));
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

// An opencode message row: assistant role with token usage.
function opencodeMessage(model, input, output, cacheRead, cacheWrite) {
    const data = {
        role: 'assistant',
        time: { created: '2026-07-14T10:00:00Z' },
        modelID: model,
        tokens: { input, output, cache: { read: cacheRead, write: cacheWrite } },
    };
    // Escape single quotes for sqlite shell SQL.
    const s = JSON.stringify(data).replace(/'/g, "''");
    return `('${s}')`;
}

function runWorker(args, env = {}) {
    const argv = ['gjs', '-m', WORKER_SCRIPT, ...args];
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    for (const [k, v] of Object.entries(env)) launcher.setenv(k, v, true);
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

async function main() {
    const root = GLib.dir_make_tmp('code-usage-sqlite-wm-XXXXXX');
    try {
        const opencodeDataDir = GLib.build_filenamev([root, 'opencode']);
        GLib.mkdir_with_parents(opencodeDataDir, 0o755);
        const dbPath = GLib.build_filenamev([opencodeDataDir, 'opencode.db']);

        // Build the opencode message table with a single assistant row.
        runSqliteCli(dbPath,
            "CREATE TABLE message (id text primary key, data text);" +
            `INSERT INTO message (data) VALUES ${opencodeMessage('glm-5.1', 1000, 100, 5000, 0)};`);

        const workerEnv = { OPENCODE_DATA_DIR: opencodeDataDir };

        // 1. First scan: establishes file-state with a real last_row_id and a
        //    single contribution row totalling 1 request, 1000 input tokens.
        let r = await runWorker([
            '--extension-path', REPO_ROOT, '--agents', 'opencode', '--exchange-rate', '7.25',
        ], workerEnv);
        assert(r.ok, `first scan should succeed; stderr=${r.stderr}`);
        const status1 = JSON.parse(r.stdout);
        assert(status1.status === 'complete', `first scan status: ${status1.status}`);
        assert(status1.agents.opencode.status === 'ok',
            `opencode ok; got ${status1.agents.opencode.status}`);

        const snap1 = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'compact-snapshot.json']));
        assert(snap1.dailyUsage.length === 1, `first scan rows: ${snap1.dailyUsage.length}`);
        const row1 = snap1.dailyUsage[0];
        assert(row1.inputTokens === 1000, `first scan input: ${row1.inputTokens}`);
        assert(row1.requestCount === 1, `first scan req: ${row1.requestCount}`);

        const state1 = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'file-state.json']));
        const fsEntry = state1.files[dbPath];
        assert(fsEntry && fsEntry.last_row_id != null && Number(fsEntry.last_row_id) > 0,
            `file-state last_row_id should be a real rowid; got ${fsEntry?.last_row_id}`);

        // 2. CORRUPT the watermark: set last_row_id to null, simulating the lost
        //    state from a prior version / migration gap. Leave contributions
        //    intact (the bug is the combination: null watermark + present
        //    contributions + an incremental decision). Append a row so the db
        //    stat changes and decideRefresh returns 'incremental'.
        state1.files[dbPath].last_row_id = null;
        writeJson(GLib.build_filenamev([SNAPSHOT_DIR, 'file-state.json']), state1);

        runSqliteCli(dbPath,
            `INSERT INTO message (data) VALUES ${opencodeMessage('glm-5.1', 2000, 200, 6000, 0)};`);

        // 3. Second scan: WITHOUT the fix this would re-add the FULL table (both
        //    rows = 3000 input, 2 req) on top of the cached contribution (1000
        //    input, 1 req) → 4000 input, 3 req (double-counted). WITH the fix,
        //    the null watermark downgrades to 'full', overwriting contributions
        //    → 3000 input, 2 req (correct).
        r = await runWorker([
            '--extension-path', REPO_ROOT, '--agents', 'opencode', '--exchange-rate', '7.25',
        ], workerEnv);
        assert(r.ok, `second scan should succeed; stderr=${r.stderr}`);
        const snap2 = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'compact-snapshot.json']));
        assert(snap2.dailyUsage.length === 1, `second scan rows: ${snap2.dailyUsage.length}`);
        const row2 = snap2.dailyUsage[0];
        assert(row2.inputTokens === 3000,
            `second scan input must be 3000 (no double-count); got ${row2.inputTokens}`);
        assert(row2.requestCount === 2,
            `second scan req must be 2 (no double-count); got ${row2.requestCount}`);
        assert(row2.cacheReadTokens === 11000,
            `second scan cacheRead must be 11000; got ${row2.cacheReadTokens}`);

        // 4. The file-state watermark is restored to a real rowid by the scan.
        const state2 = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'file-state.json']));
        const fsEntry2 = state2.files[dbPath];
        assert(fsEntry2.last_row_id != null && Number(fsEntry2.last_row_id) > 0,
            `watermark restored to real rowid; got ${fsEntry2.last_row_id}`);

        // 5. A THIRD scan with a valid watermark + another append increments
        //    normally (accumulate, not overwrite) — proves the downgrade only
        //    triggers on a null watermark.
        runSqliteCli(dbPath,
            `INSERT INTO message (data) VALUES ${opencodeMessage('glm-5.1', 4000, 300, 7000, 0)};`);
        r = await runWorker([
            '--extension-path', REPO_ROOT, '--agents', 'opencode', '--exchange-rate', '7.25',
        ], workerEnv);
        assert(r.ok, `third scan should succeed; stderr=${r.stderr}`);
        const snap3 = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'compact-snapshot.json']));
        const row3 = snap3.dailyUsage[0];
        assert(row3.inputTokens === 7000,
            `third scan input must be 7000 (accumulate from 3000); got ${row3.inputTokens}`);
        assert(row3.requestCount === 3,
            `third scan req must be 3; got ${row3.requestCount}`);

        print('sqlite-watermark tests passed');
    } finally {
        removeTree(root);
        for (const f of ['compact-snapshot.json', 'file-state.json']) {
            try { Gio.File.new_for_path(GLib.build_filenamev([SNAPSHOT_DIR, f])).delete(null); } catch (_e) {}
        }
    }
}

const loop = GLib.MainLoop.new(null, false);
let _exited = false;
main().then(() => { _exited = true; loop.quit(); })
    .catch((e) => { _exited = true; console.error(`sqlite-watermark tests FAILED: ${e.message}`); loop.quit(); });
loop.run();
if (!_exited) console.error('sqlite-watermark tests: loop exited before main() settled');