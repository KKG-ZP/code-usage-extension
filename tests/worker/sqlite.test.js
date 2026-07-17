// Stage-3 SQLite agent unit tests.
//
// Tests parseSQLiteAgent directly against temp SQLite dbs (created via the
// sqlite3 CLI), covering:
//   * full query returns all rows with correct entry shape
//   * incremental query (with lastRowId watermark) returns only new rows
//   * goose model_config field-name fix: model comes from model_config,
//     not the generic 'goose' fallback
//   * error classification: a missing table yields SCHEMA_MISMATCH, not a
//     silent empty result
//   * a legitimately empty incremental result returns errorCode=null (not
//     conflated with an error)
//
// Run with: gjs -m tests/worker/sqlite.test.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { parseSQLiteAgent, parseZCodeRolloutLine } from '../../modules/parsers.js';

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function runSqliteCli(dbPath, sql) {
    // Synchronous helper: build the db / run DDL via the sqlite3 CLI so the
    // test has a known schema before exercising parseSQLiteAgent.
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

function removeTree(path) {
    const f = Gio.File.new_for_path(path);
    if (!f.query_exists(null)) return;
    try { f.delete(null); } catch (_e) {}
}

async function main() {
    const root = GLib.dir_make_tmp('code-usage-sqlite-XXXXXX');
    try {
        // ── zcode: model_usage with status flips ──
        const zcodeDb = GLib.build_filenamev([root, 'db.sqlite']);
        // zcode schema (pk id, implicit rowid, started_at epoch-ms)
        runSqliteCli(zcodeDb,
            "CREATE TABLE model_usage (id text primary key, session_id text, started_at integer, model_id text, input_tokens integer, output_tokens integer, cache_creation_input_tokens integer, cache_read_input_tokens integer, status text);" +
            "INSERT INTO model_usage VALUES ('a1','s1',1781705462049,'GLM-5.2',1000,500,0,200,'completed');" +
            "INSERT INTO model_usage VALUES ('a2','s1',1781705576631,'GLM-5.2',2000,800,0,400,'completed');" +
            "INSERT INTO model_usage VALUES ('p3','s2',1781705600000,'GLM-5.2',300,100,0,0,'pending');");

        // 1. Full query (no watermark): returns the 2 completed rows.
        let r = await parseSQLiteAgent('zcode', zcodeDb, {});
        assert(r.errorCode === null, `zcode full errorCode: ${r.errorCode}`);
        assert(r.entries.length === 2, `zcode full rows: ${r.entries.length}`);
        assert(r.entries[0].model === 'GLM-5.2', `zcode model: ${r.entries[0].model}`);
        assert(r.entries[0].inputTokens === 1000, `zcode inputTokens: ${r.entries[0].inputTokens}`);
        assert(r.lastRowId === 2, `zcode full lastRowId: ${r.lastRowId}`);

        // 2. Incremental: flip the pending row to completed + append a new
        //    completed row. With lastRowId=2, the incremental query should
        //    return the new row (rowid 3 flipped to completed) and NOT the
        //    already-counted rows 1-2.
        runSqliteCli(zcodeDb,
            "UPDATE model_usage SET status='completed' WHERE id='p3';" +
            "INSERT INTO model_usage VALUES ('a4','s3',1781705700000,'GLM-5.2',500,200,0,50,'completed');");
        r = await parseSQLiteAgent('zcode', zcodeDb, {}, { lastRowId: 2, lastTimestamp: 1781705462049 });
        assert(r.errorCode === null, `zcode inc errorCode: ${r.errorCode}`);
        // rowid 3 (flipped) is <= lastRowId 2? No — rowid 3 > 2, so it IS
        // returned. rowid 4 is also returned. The 2 old rows (rowid 1,2) are
        // NOT returned (rowid <= lastRowId AND outside overlap window).
        assert(r.entries.length === 2, `zcode inc rows (flipped+new): ${r.entries.length}`);
        assert(r.lastRowId === 4, `zcode inc lastRowId: ${r.lastRowId}`);

        // 3. A second incremental with lastRowId=4 returns nothing legitimately.
        r = await parseSQLiteAgent('zcode', zcodeDb, {}, { lastRowId: 4, lastTimestamp: 1781705700000 });
        assert(r.errorCode === null, `zcode empty-inc errorCode: ${r.errorCode}`);
        assert(r.entries.length === 0, `zcode empty-inc rows: ${r.entries.length}`);

        // ── goose: model_config field-name fix ──
        const gooseDb = GLib.build_filenamev([root, 'sessions.db']);
        runSqliteCli(gooseDb,
            "CREATE TABLE sessions (id integer primary key, model_config text, provider_name text, created_at text, accumulated_input_tokens integer, accumulated_output_tokens integer, total_tokens integer);" +
            "INSERT INTO sessions VALUES (1, '{\"model_name\":\"claude-sonnet-4\"}', 'anthropic', '2026-07-15T10:00:00Z', 1000, 500, 1500);");
        r = await parseSQLiteAgent('goose', gooseDb, {});
        assert(r.errorCode === null, `goose errorCode: ${r.errorCode}`);
        assert(r.entries.length === 1, `goose rows: ${r.entries.length}`);
        assert(r.entries[0].model === 'claude-sonnet-4',
            `goose model should come from model_config (not 'goose' fallback): got ${r.entries[0].model}`);
        assert(r.lastRowId === 1, `goose lastRowId: ${r.lastRowId}`);

        // 4. goose incremental: append a row, query with lastRowId=1.
        runSqliteCli(gooseDb,
            "INSERT INTO sessions VALUES (2, '{\"model_name\":\"gpt-5.5\"}', 'openai', '2026-07-16T10:00:00Z', 2000, 800, 2800);");
        r = await parseSQLiteAgent('goose', gooseDb, {}, { lastRowId: 1 });
        assert(r.entries.length === 1, `goose inc rows: ${r.entries.length}`);
        assert(r.entries[0].model === 'gpt-5.5', `goose inc model: ${r.entries[0].model}`);
        assert(r.lastRowId === 2, `goose inc lastRowId: ${r.lastRowId}`);

        // ── error classification: missing table ──
        const emptyDb = GLib.build_filenamev([root, 'empty.db']);
        runSqliteCli(emptyDb, "CREATE TABLE unrelated (x);");
        r = await parseSQLiteAgent('zcode', emptyDb, {});
        assert(r.errorCode === 'SCHEMA_MISMATCH',
            `missing table should yield SCHEMA_MISMATCH; got ${r.errorCode}`);
        assert(r.entries.length === 0, `schema error entries: ${r.entries.length}`);

        // ZCode rollout fallback: reconstructs the observable payload and
        // explicitly marks the result as an estimate.
        const rollout = {
            type: 'model_io',
            requestId: 'req-1',
            completedAt: '2026-07-16T10:00:00Z',
            model: { modelId: 'glm-5.2:cloud' },
            request: {
                body: { model: 'glm-5.2:cloud', stream: true },
                messages: [{ role: 'user', content: 'fix the failing test' }],
            },
            response: { text: 'Done.', toolCalls: [] },
        };
        const fallback = parseZCodeRolloutLine(JSON.stringify(rollout));
        const expectedInput = Math.ceil(new TextEncoder().encode(JSON.stringify({
            ...rollout.request.body,
            messages: rollout.request.messages,
        })).length / 4);
        assert(fallback?.inputTokens === expectedInput,
            `rollout input estimate: ${fallback?.inputTokens}/${expectedInput}`);
        assert(fallback?.outputTokens > 0, `rollout output estimate: ${fallback?.outputTokens}`);
        assert(fallback?._usageSource === 'rollout-estimate',
            `rollout source marker: ${fallback?._usageSource}`);
        assert(fallback?._dedupeKey === 'zcode-rollout:req-1',
            `rollout dedupe key: ${fallback?._dedupeKey}`);

        print('sqlite tests passed');
    } finally {
        removeTree(root);
    }
}

const loop = GLib.MainLoop.new(null, false);
main().then(() => loop.quit())
    .catch((e) => { console.error(`sqlite tests FAILED: ${e.message}`); loop.quit(); });
loop.run();
