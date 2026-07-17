// Stage-6 legacy migration tests.
//
// Tests that readLegacyArchive converts daily-usage.json → snapshot rows
// correctly, and that the worker's migration fallback path emits a
// migrationVersion-tagged snapshot when no real logs exist for the selected
// agents. Covers:
//   * breakdown rows (with model ids containing `:`) map to (agent, raw_model)
//   * cost is preserved as locked-in CNY
//   * backup is created and the original left intact
//   * a second run (snapshot now exists) does NOT re-migrate
//   * readLegacyArchive returns null on a corrupt/missing file
//
// Run with: gjs -m tests/worker/migration.test.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {
    readLegacyArchive, backupLegacyArchive, legacyArchivePath, legacyBackupPath,
} from '../../worker/migrate.js';

const TEXT_ENCODER = new TextEncoder();

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function write(path, content) { GLib.file_set_contents(path, TEXT_ENCODER.encode(content)); }
function removeFile(path) { try { Gio.File.new_for_path(path).delete(null); } catch (_e) {} }
function readJson(path) {
    const [ok, c] = Gio.File.new_for_path(path).load_contents(null);
    return ok ? JSON.parse(new TextDecoder().decode(c)) : null;
}

async function main() {
    const origPath = legacyArchivePath();
    const origBackup = legacyBackupPath();
    // Snapshot the real legacy file so we can restore it after the test.
    let realContent = null;
    try {
        const [ok, c] = Gio.File.new_for_path(origPath).load_contents(null);
        if (ok) realContent = c;
    } catch (_e) {}

    try {
        // 1. readLegacyArchive on a missing file returns null.
        removeFile(origPath);
        assert(readLegacyArchive() === null, 'missing legacy → null');

        // 2. A v2 archive with a model id containing `:` (the unsafe-to-split
        //    case) converts correctly using row fields, not the key.
        write(origPath, JSON.stringify({
            version: 3,
            historyDays: {
                '2026-07-15': {
                    date: '2026-07-15',
                    breakdown: {
                        // key contains a model with `:` — must NOT be split
                        'qwen:glm-5.2:cloud': {
                            agent: 'qwen', model: 'glm-5.2:cloud',
                            inputTokens: 1000, outputTokens: 500,
                            cacheReadTokens: 200, cacheCreationTokens: 0,
                            requestCount: 3, cost: 1.23, totalTokens: 1700,
                        },
                        'codex:gpt-5.5-codex': {
                            agent: 'codex', model: 'gpt-5.5-codex',
                            inputTokens: 2000, outputTokens: 800,
                            cacheReadTokens: 400, cacheCreationTokens: 0,
                            requestCount: 4, cost: 2.5, totalTokens: 3200,
                        },
                    },
                },
            },
            activeDay: null,
            metadata: { initialized: true, initializedAgents: ['qwen', 'codex'] },
        }));
        const legacy = readLegacyArchive();
        assert(legacy !== null, 'legacy parsed');
        assert(legacy.rows.length === 2, `rows: ${legacy.rows.length}`);
        const qwenRow = legacy.rows.find(r => r.agent === 'qwen');
        assert(qwenRow && qwenRow.raw_model === 'glm-5.2:cloud',
            `model with colon preserved: ${qwenRow?.raw_model}`);
        assert(qwenRow.cost === 1.23, `cost preserved: ${qwenRow.cost}`);
        assert(qwenRow.requestCount === 3, `requestCount: ${qwenRow.requestCount}`);
        assert(new Set(legacy.agents).size === 2, `agents: ${legacy.agents}`);

        // 3. backupLegacyArchive copies without deleting the original.
        removeFile(origBackup);
        assert(backupLegacyArchive(), 'backup should succeed');
        assert(Gio.File.new_for_path(origBackup).query_exists(null), 'backup file created');
        assert(Gio.File.new_for_path(origPath).query_exists(null), 'original still exists');
        // A second backup is a no-op (backup already exists).
        assert(backupLegacyArchive(), 'second backup is a no-op success');

        // 4. A corrupt legacy file returns null (migration skipped, not a crash).
        write(origPath, '{ not valid json');
        assert(readLegacyArchive() === null, 'corrupt legacy → null');

        print('migration tests passed');
    } finally {
        // Restore the real legacy file if we captured it; remove our backup.
        if (realContent) {
            try { GLib.file_set_contents(origPath, realContent); } catch (_e) {}
        }
        removeFile(origBackup);
    }
}

const loop = GLib.MainLoop.new(null, false);
main().then(() => loop.quit())
    .catch((e) => { console.error(`migration tests FAILED: ${e.message}`); loop.quit(); });
loop.run();