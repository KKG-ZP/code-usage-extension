// Atomic read/write of compact-snapshot.json — the only file the GNOME Shell
// extension touches at runtime. The worker writes the snapshot; the Shell
// only ever reads it. Writes go through a temp file + g_file_set_contents
// (which itself does write→fsync→rename) so a crash mid-write leaves the
// previous valid snapshot intact.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const TEXT_DECODER = new TextDecoder('utf-8');
const TEXT_ENCODER = new TextEncoder('utf-8');

export const SNAPSHOT_VERSION = 1;

export function snapshotPath() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'code-usage-extension',
        'compact-snapshot.json',
    ]);
}

/**
 * Load and validate the snapshot. Returns null if the file is missing,
 * corrupt, or fails schema validation — callers must treat null as "no
 * data yet" and NOT as "empty data", so a failed/missing worker run can
 * never wipe the UI back to zero on the next Shell restart.
 */
export function loadSnapshot() {
    const path = snapshotPath();
    try {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null)) return null;
        const [ok, contents] = file.load_contents(null);
        if (!ok) return null;
        const parsed = JSON.parse(TEXT_DECODER.decode(contents));
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof parsed.schemaVersion !== 'number') return null;
        return parsed;
    } catch (_e) {
        return null;
    }
}

/**
 * Atomically write the snapshot. Builds the full payload, serialises to
 * JSON, and writes via GLib.file_set_contents (temp file + rename, so a
 * crash never leaves a half-written file visible to readers).
 *
 * `agentsStatus` is a map of agent -> { status, lastUpdated, error } so the
 * Shell can show per-agent health without re-running any scan.
 * `dailyUsage` is an array of { date, agent, raw_model, ...counters } rows
 * already aggregated by (date, agent, raw_model).
 */
export function writeSnapshot({ generatedAt, lastSuccessfulScan, agentsStatus, dailyUsage, migrationVersion }) {
    const payload = {
        schemaVersion: SNAPSHOT_VERSION,
        generatedAt,
        lastSuccessfulScan,
        agentsStatus: agentsStatus || {},
        dailyUsage: dailyUsage || [],
        migrationVersion: Number(migrationVersion) || 0,
    };
    const path = snapshotPath();
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        GLib.file_set_contents(path, TEXT_ENCODER.encode(JSON.stringify(payload, null, 2)));
        return true;
    } catch (_e) {
        return false;
    }
}