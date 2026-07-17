// Persistent per-file scan watermarks + contributions.
//
// Lets the worker skip unchanged files across restarts AND still rebuild a
// complete snapshot: each file's entry carries its aggregated `contributions`
// rows, so a skipped file's usage is re-included in the snapshot without
// re-parsing its bytes. Stage 2 will add an `offset` field for incremental
// JSONL reads (parsing only appended bytes); stage 1 re-parses the whole
// file but caches its contributions so unchanged files stay cheap.
//
// File-state is JSON (GJS has no built-in SQLite binding); a usage-cache
// sqlite is deferred to stage 3 for SQLite-agent watermarks.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const TEXT_DECODER = new TextDecoder('utf-8');
const TEXT_ENCODER = new TextEncoder('utf-8');

export const FILE_STATE_VERSION = 1;

function _statePath() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'code-usage-extension',
        'file-state.json',
    ]);
}

/**
 * Load the persisted file-state map. Returns {} if missing/corrupt (a cold
 * start re-scans everything). Shape: { [path]: entry } where entry is:
 *   { agent, inode, mtime_ns, size, parser_version, offset, pending_tail,
 *     parser_state, last_row_id, last_timestamp, schema_version,
 *     contributions }
 * `parser_state` is per-file parser context (stage 2): Codex stores
 * `{ model: "..." }` so an incremental read starting mid-file still knows
 * the session's model. Other agents leave it null.
 * `last_row_id` / `last_timestamp` are SQLite-agent watermarks (stage 3):
 * the worker queries only rows with id/rowid > last_row_id. `schema_version`
 * is a hash of the table's column names from PRAGMA table_info; a change
 * forces a full re-query.
 */
export function loadFileState() {
    try {
        const file = Gio.File.new_for_path(_statePath());
        if (!file.query_exists(null)) return {};
        const [ok, contents] = file.load_contents(null);
        if (!ok) return {};
        const parsed = JSON.parse(TEXT_DECODER.decode(contents));
        if (!parsed || typeof parsed !== 'object') return {};
        return parsed.files || {};
    } catch (_e) {
        return {};
    }
}

/**
 * Atomically persist the file-state map.
 */
export function saveFileState(files) {
    const payload = {
        version: FILE_STATE_VERSION,
        files: files || {},
    };
    const path = _statePath();
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        GLib.file_set_contents(path, TEXT_ENCODER.encode(JSON.stringify(payload, null, 2)));
        return true;
    } catch (_e) {
        return false;
    }
}

/**
 * Decide whether a file needs re-parsing given its current stat and the
 * persisted state entry. Returns 'skip' | 'full' | 'incremental'.
 *
 *   'skip'        — cache is up to date, nothing to do.
 *   'incremental' — JSONL append-only growth; safe to read only the bytes
 *                   appended since cached.offset. Requires the file to be
 *                   a JSONL source (caller passes fileType='jsonl'), the
 *                   inode unchanged, mtime not regressed, and size grown.
 *   'full'        — cold cache miss, whole-file agent, sqlite, truncation,
 *                   rotation, in-place edit, or parser_version bump.
 *
 * A file is skipped only when inode + mtime_ns + size + parser_version all
 * match. Truncate (size < offset), inode change, or mtime regression always
 * forces 'full' because the cached offset/contributions no longer apply.
 */
export function decideRefresh(cached, info, parserVersion, fileType) {
    if (!cached) return 'full';
    if (Number(cached.parser_version) !== parserVersion) return 'full';
    if (Number(cached.inode) !== info.inode) return 'full';
    if (Number(cached.mtime_ns) !== info.mtime_ns && Number(cached.mtime_ns) > info.mtime_ns) {
        // mtime regressed (clock skew or in-place rewrite to an older mtime):
        // cached offset is unreliable, reload whole file.
        return 'full';
    }
    if (Number(cached.size) === info.size && Number(cached.mtime_ns) === info.mtime_ns) {
        return 'skip';
    }
    // Size or mtime changed. JSONL append-only growth → incremental; SQLite
    // stat change (wal/shm grew) → incremental with row-id watermark; whole-
    // file agents → full. Truncate (size < cached.size) → full.
    if (fileType === 'jsonl' && info.size > Number(cached.size)) {
        return 'incremental';
    }
    if (fileType === 'sqlite' && Number(cached.size) > 0) {
        // SQLite: any stat change means new rows may exist. Use incremental
        // with the cached row-id watermark. (A size shrink on a WAL db is
        // normal after checkpoint; we still re-query with the watermark so
        // no rows are missed, and the worker dedups by rowid.)
        return 'incremental';
    }
    // Truncation (size < cached.size), in-place rewrite (same size, mtime up),
    // or non-JSONL/non-SQLite file with a stat change → reload whole file.
    return 'full';
}