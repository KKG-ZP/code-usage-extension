// Snapshot cache loader tests.
//
// Stage 1 rewrote FileCacheManager from a raw-log parser into a reader of
// compact-snapshot.json. These tests cover the new contracts:
//   * getMergedEntries() surfaces a pre-written snapshot's rows as entries
//   * scanAndDiff() reloads when the snapshot mtime advances
//   * a corrupt/missing snapshot never wipes the last good entries
//   * retainEntriesForDate is a no-op (snapshot rows are already aggregated)
//
// Run with: gjs -m tests/cacheManager.test.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { FileCacheManager } from '../modules/cacheManager.js';
import { writeSnapshot, SNAPSHOT_VERSION } from '../worker/snapshot.js';

const TEXT_ENCODER = new TextEncoder();

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function snapshotPath() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(), 'code-usage-extension', 'compact-snapshot.json']);
}

function removeSnapshot() {
    try { Gio.File.new_for_path(snapshotPath()).delete(null); } catch (_e) {}
}

function delay(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

async function main() {
    removeSnapshot();
    try {
        const settings = { get_boolean: () => false };
        const manager = new FileCacheManager(settings, {});

        // 1. Before any snapshot exists, getMergedEntries is empty (not an
        //    error) — the panel shows no data, not a crash.
        assert(manager.getMergedEntries().length === 0,
            'no snapshot yet → empty entries');

        // 2. Write a snapshot and verify the loader surfaces its rows as
        //    pseudo-entries carrying the locked-in CNY cost.
        writeSnapshot({
            generatedAt: '2026-07-16T10:00:00.000Z',
            lastSuccessfulScan: '2026-07-16T10:00:00.000Z',
            agentsStatus: { codex: { status: 'ok', lastUpdated: '2026-07-16T10:00:00.000Z', error: null } },
            dailyUsage: [{
                date: '2026-07-15', agent: 'codex', raw_model: 'gpt-5.5-codex',
                inputTokens: 1000, outputTokens: 500,
                cacheReadTokens: 200, cacheCreationTokens: 0,
                requestCount: 3, cost: 1.23,
            }],
        });

        const r1 = await manager.scanAndDiff(['codex']);
        assert(r1.changed === true, 'first reload reports changed=true');
        const entries1 = manager.getMergedEntries();
        assert(entries1.length === 1, `one row → one entry; got ${entries1.length}`);
        const e = entries1[0];
        assert(e.date === '2026-07-15' && e._agent === 'codex' && e.model === 'gpt-5.5-codex',
            `entry identity: ${e.date}/${e._agent}/${e.model}`);
        assert(e.inputTokens === 1000 && e.requestCount === 3, 'counters carried through');
        assert(e._finalCostCNY === 1.23, `locked-in CNY cost carried: ${e._finalCostCNY}`);

        // 3. A second scan with no mtime change reports changed=false and
        //    keeps the same entries (no reload, no wipe).
        const r2 = await manager.scanAndDiff(['codex']);
        assert(r2.changed === false, 'unchanged snapshot → changed=false');
        assert(manager.getMergedEntries().length === 1, 'entries preserved on no-change');

        // 4. mtime advances → reload picks up the new rows.
        //    (touch the file by rewriting it after a small delay so the
        //    mtime genuinely moves.)
        await delay(20);
        writeSnapshot({
            generatedAt: '2026-07-16T11:00:00.000Z',
            lastSuccessfulScan: '2026-07-16T11:00:00.000Z',
            agentsStatus: {},
            dailyUsage: [
                { date: '2026-07-15', agent: 'codex', raw_model: 'gpt-5.5-codex',
                  inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200,
                  cacheCreationTokens: 0, requestCount: 3, cost: 1.23 },
                { date: '2026-07-16', agent: 'claude', raw_model: 'claude-opus-4',
                  inputTokens: 500, outputTokens: 250, cacheReadTokens: 0,
                  cacheCreationTokens: 0, requestCount: 1, cost: 0.5 },
            ],
        });
        const r3 = await manager.scanAndDiff(['codex']);
        assert(r3.changed === true, 'mtime advance → changed=true');
        assert(manager.getMergedEntries().length === 2,
            `two rows after reload; got ${manager.getMergedEntries().length}`);

        // 5. Corrupt the snapshot: the loader must keep the previous entries
        //    rather than treat the failure as empty data.
        GLib.file_set_contents(snapshotPath(), TEXT_ENCODER.encode('{ not valid json'));
        const r4 = await manager.scanAndDiff(['codex']);
        assert(r4.changed === false, 'corrupt snapshot → no reload (changed=false)');
        assert(manager.getMergedEntries().length === 2,
            'corrupt snapshot preserves the last good entries');

        // 6. retainEntriesForDate is a no-op on the snapshot-backed cache.
        manager.retainEntriesForDate('2026-07-15');
        assert(manager.getMergedEntries().length === 2,
            'retainEntriesForDate does not drop snapshot rows');

        // 7. clear() resets to empty.
        manager.clear();
        assert(manager.getMergedEntries().length === 0, 'clear empties the cache');

        print('cacheManager (snapshot loader) tests passed');
    } finally {
        removeSnapshot();
    }
}

// gjs -m top-level await does not drive the GLib main context; spin a loop.
const loop = GLib.MainLoop.new(null, false);
main().then(() => loop.quit())
    .catch((e) => { console.error(`cacheManager tests FAILED: ${e.message}`); loop.quit(); });
loop.run();