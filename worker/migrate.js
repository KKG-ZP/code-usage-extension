// Stage-6 legacy archive migration: daily-usage.json → compact-snapshot.json.
//
// The legacy DailyArchive persisted per-day records with a `breakdown` map
// keyed by `${agent}:${model}`. The new snapshot stores flat `dailyUsage`
// rows keyed by (date, agent, raw_model) with locked-in CNY cost. This
// module reads the legacy file and emits snapshot rows, preserving history
// when the user upgrades from the pre-worker extension.
//
// Migration rules:
//   * Use the breakdown ROW's `agent`/`model` fields, NOT the key string —
//     model ids may contain `:` (e.g. `glm-5.2:cloud`), so splitting the key
//     on `:` is unsafe.
//   * `cost` is already CNY (locked in at the original scan time); copy it
//     directly — no re-valuation.
//   * Both `historyDays` and `activeDay` contribute rows.
//   * On any error, return null so the caller keeps the prior snapshot
//     (migration failure must never wipe data).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const TEXT_DECODER = new TextDecoder('utf-8');
export const MIGRATION_VERSION = 1;

export function legacyArchivePath() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(), 'code-usage-extension', 'daily-usage.json']);
}

export function legacyBackupPath() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(), 'code-usage-extension', 'daily-usage.json.v3.bak']);
}

/**
 * Read the legacy daily-usage.json and convert it to an array of snapshot
 * dailyUsage rows. Returns null if the file is missing or unparseable so the
 * caller can skip migration cleanly. Returns { rows, agents } on success
 * where `agents` is the set of agent ids seen (for agentsStatus).
 */
export function readLegacyArchive() {
    const path = legacyArchivePath();
    try {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null)) return null;
        const [ok, contents] = file.load_contents(null);
        if (!ok) return null;
        const parsed = JSON.parse(TEXT_DECODER.decode(contents));
        if (!parsed || typeof parsed !== 'object') return null;

        // v1 used `days`; v2/v3 use `historyDays` + `activeDay`.
        const historyDays = parsed.version >= 2
            ? (parsed.historyDays || {})
            : (parsed.days || {});
        const activeDay = parsed.version >= 2 ? parsed.activeDay : null;

        const rows = [];
        const agents = new Set();

        const convertRecord = (record) => {
            if (!record || typeof record !== 'object') return;
            const date = record.date;
            if (!date) return;
            const breakdown = record.breakdown || {};
            for (const row of Object.values(breakdown)) {
                if (!row || typeof row !== 'object') continue;
                // Use row fields, NOT the breakdown key (model may contain `:`).
                rows.push({
                    date,
                    agent: row.agent || 'unknown',
                    raw_model: row.model || 'unknown',
                    inputTokens: Number(row.inputTokens) || 0,
                    outputTokens: Number(row.outputTokens) || 0,
                    cacheReadTokens: Number(row.cacheReadTokens) || 0,
                    cacheCreationTokens: Number(row.cacheCreationTokens) || 0,
                    requestCount: Number(row.requestCount) || 0,
                    cost: Number(row.cost) || 0, // already CNY, locked-in
                });
                agents.add(row.agent || 'unknown');
            }
        };

        for (const record of Object.values(historyDays)) convertRecord(record);
        if (activeDay) convertRecord(activeDay);

        return { rows, agents: [...agents] };
    } catch (_e) {
        return null;
    }
}

/**
 * Back up the legacy daily-usage.json to .v3.bak so a migration failure (or a
 * user wanting to downgrade) can recover. Returns true on success (or if the
 * backup already exists / source missing — both non-fatal).
 */
export function backupLegacyArchive() {
    const src = legacyArchivePath();
    const dst = legacyBackupPath();
    try {
        const srcFile = Gio.File.new_for_path(src);
        if (!srcFile.query_exists(null)) return true;
        const dstFile = Gio.File.new_for_path(dst);
        if (dstFile.query_exists(null)) return true; // already backed up
        // Copy (not move): the original is left intact for a downgrade path.
        return srcFile.copy(dstFile, Gio.FileCopyFlags.NONE, null, null);
    } catch (_e) {
        return false;
    }
}