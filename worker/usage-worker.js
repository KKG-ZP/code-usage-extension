#!/usr/bin/env gjs -m
// Usage worker — a standalone GJS process that scans agent log sources,
// aggregates usage by (date, agent, raw_model), and writes a compact
// snapshot for the GNOME Shell extension to display.
//
// The Shell extension spawns this worker via Gio.Subprocess so heavy log
// parsing (hundreds of MB of JSONL, SQLite queries) runs in an isolated
// SpiderMonkey process — a worker GC stall or memory spike can never block
// Mutter / desktop compositing, and a Shell restart re-loads the snapshot
// without re-scanning history.
//
// Stage 1 scope: full re-parse of every changed file per scan. Stage 2 will
// add JSONL offset incrementality; stage 3 adds SQLite watermarks. The
// snapshot + file-state are JSON files (GJS has no built-in SQLite binding);
// a usage-cache.sqlite is deferred to stage 3.
//
// Invocation:
//   gjs -m usage-worker.js \
//     --extension-path <abs dir containing modules/> \
//     --agents claude,codex \
//     [--exchange-rate 7.25] \
//     [--price-overrides '{}'] [--model-aliases '{}'] \
//     [--debug] [--help]
//
// stdout: a single short status JSON line (never raw entries). Exit code 0
// on success, non-zero on failure. The snapshot file is the authoritative
// output; stdout is only for the Shell to report progress/health.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { AGENT_CONFIGS, expandHome } from '../modules/agentConfigs.js';
import {
    parseCodexLine, parseGeminiFile, parseKimiLine,
    parseOpenClawLine, parsePILine, parseQwenLine,
    parseCopilotLine, parseAmpFile, parseCodeBuffFile,
    parseKiroCliSessionFile, parseClaudeEntry, parseSQLiteAgent,
    parseZCodeRolloutLine,
    getCodexSessionModel, setCodexSessionModel, clearCodexSessionModels,
} from '../modules/parsers.js';
import { setDebugEnabled } from '../modules/parsers.js';
import {
    computeEntryMetrics, entryRequestCount, parseAliasMap,
} from '../modules/entryMetrics.js';
import { loadFileState, saveFileState, decideRefresh } from './fileState.js';
import { writeSnapshot, SNAPSHOT_VERSION, loadSnapshot, snapshotPath } from './snapshot.js';
import {
    readLegacyArchive, backupLegacyArchive, legacyArchivePath, MIGRATION_VERSION,
} from './migrate.js';

// Bump when parsers.js logic changes in a way that invalidates previously
// aggregated rows. file_state entries with an older version are forced to
// a full re-parse. Per-agent versioning is deferred; a single global
// version covers stage 1-2. v2: goose model_config field-name fix.
const PARSER_VERSION = 4;

const TEXT_DECODER = new TextDecoder('utf-8');
const READ_CHUNK_BYTES = 256 * 1024;
// Hard cap for a single JSONL line. A line longer than this is reported as
// RECORD_TOO_LARGE and skipped rather than letting it enter the JS heap
// unbounded (a single multi-MB tool result is legitimate, but 32MB is well
// past any real record).
const MAX_LINE_BYTES = 32 * 1024 * 1024;

function _debug(msg) {
    printerr(`[usage-worker] ${msg}`);
}

function _formatLocalDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// ─────────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = {
        extensionPath: null,
        agents: [],
        exchangeRate: 7.25,
        priceOverrides: '{}',
        modelAliases: '{}',
        debug: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => (i + 1 < argv.length) ? argv[++i] : null;
        switch (a) {
            case '--extension-path': opts.extensionPath = next(); break;
            case '--agents': opts.agents = (next() || '').split(',').map(s => s.trim()).filter(Boolean); break;
            case '--exchange-rate': opts.exchangeRate = Number(next()) || 7.25; break;
            case '--price-overrides': opts.priceOverrides = next() || '{}'; break;
            case '--model-aliases': opts.modelAliases = next() || '{}'; break;
            case '--debug': opts.debug = true; break;
            case '--help': case '-h': opts.help = true; break;
            default:
                if (a.startsWith('--')) {
                    printerr(`unknown option: ${a}`);
                }
        }
    }
    return opts;
}

function printHelp() {
    print(`usage: gjs -m usage-worker.js --extension-path <dir> --agents <a,b> [options]

  --extension-path DIR   absolute path to the extension dir (contains modules/)
  --agents a,b,...       comma-separated agent ids to scan
  --exchange-rate F      USD->CNY rate (default 7.25)
  --price-overrides JSON custom pricing overrides (default '{}')
  --model-aliases JSON   alias->canonical model map (default '{}')
  --debug                verbose stderr logging
  --help, -h             show this help

Writes compact-snapshot.json + file-state.json to
~/.local/share/code-usage-extension/. Prints one status JSON line to stdout.`);
}

// ─────────────────────────────────────────────────────────────────────────
// File discovery + stat
// ─────────────────────────────────────────────────────────────────────────

function _statFile(filePath) {
    const file = Gio.File.new_for_path(filePath);
    if (!file.query_exists(null)) return null;
    try {
        const info = file.query_info(
            'time::modified,time::modified-usec,standard::size,unix::inode',
            Gio.FileQueryInfoFlags.NONE,
            null,
        );
        const sec = Number(info.get_attribute_uint64('time::modified'));
        let usec = 0;
        try { usec = Number(info.get_attribute_uint32('time::modified-usec')) || 0; } catch (_e) {}
        let inode = 0;
        try { inode = Number(info.get_attribute_uint64('unix::inode')) || 0; } catch (_e) {}
        return {
            path: filePath,
            size: Number(info.get_size()),
            mtime_ns: sec * 1e9 + usec * 1000,
            inode,
        };
    } catch (_e) {
        return null;
    }
}

function _statSqliteWithSidecars(dbPath) {
    const main = _statFile(dbPath);
    if (!main) return null;
    // .db-wal mtime is a useful "may have changed" hint; .db-shm is volatile
    // in size so only its mtime matters. Stage 1 still does a full re-query
    // on any change; stage 3 will add row-id/timestamp watermarks.
    let mtimeNs = main.mtime_ns;
    let size = main.size;
    for (const suffix of ['-wal', '-shm']) {
        const side = _statFile(dbPath + suffix);
        if (!side) continue;
        if (side.mtime_ns > mtimeNs) mtimeNs = side.mtime_ns;
        if (suffix === '-wal') size += side.size; // -shm size is noise
    }
    return { path: main.path, size, mtime_ns: mtimeNs, inode: main.inode };
}

function _scanDir(dirPath, pattern, recursive, out) {
    const dir = Gio.File.new_for_path(dirPath);
    if (!dir.query_exists(null)) return;
    let enumerator;
    try {
        enumerator = dir.enumerate_children(
            'standard::name,standard::type,time::modified,time::modified-usec,standard::size,unix::inode',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null,
        );
    } catch (_e) {
        return;
    }
    try {
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const childType = info.get_file_type();
            const child = enumerator.get_child(info);
            const childPath = child.get_path();
            if (childType === Gio.FileType.DIRECTORY) {
                if (recursive) _scanDir(childPath, pattern, true, out);
            } else if (childType === Gio.FileType.REGULAR) {
                const name = info.get_name();
                if (!pattern || pattern.test(name)) {
                    const sec = Number(info.get_attribute_uint64('time::modified'));
                    let usec = 0;
                    try { usec = Number(info.get_attribute_uint32('time::modified-usec')) || 0; } catch (_e) {}
                    let inode = 0;
                    try { inode = Number(info.get_attribute_uint64('unix::inode')) || 0; } catch (_e) {}
                    out.push({
                        path: childPath,
                        size: Number(info.get_size()),
                        mtime_ns: sec * 1e9 + usec * 1000,
                        inode,
                    });
                }
            }
        }
    } catch (_e) {
        /* ignore iter errors */
    } finally {
        try { enumerator.close(null); } catch (_e) {}
    }
}

function _classifyAgent(config) {
    if (config.sqlite) return 'sqlite';
    if (config.parse === parseGeminiFile ||
        config.parse === parseAmpFile ||
        config.parse === parseCodeBuffFile ||
        config.parse === parseKiroCliSessionFile) {
        return 'whole-file';
    }
    return 'jsonl';
}

function _collectFilesForAgent(agent, config) {
    const fileType = _classifyAgent(config);
    const out = [];

    if (fileType === 'sqlite') {
        const dirs = config.dirs();
        for (const dirPath of dirs) {
            for (const dbFile of config.dbFiles) {
                const dbPath = GLib.build_filenamev([dirPath, dbFile]);
                const stat = _statSqliteWithSidecars(dbPath);
                if (stat) out.push({ ...stat, sourceType: 'sqlite' });
            }
        }
        // ZCode's database occasionally contains completed rows whose usage
        // fields are all zero.  Discover model-io rollouts as an independent
        // fallback source; source selection happens after aggregation.
        if (agent === 'zcode' && config.fallbackDirs) {
            const fallback = [];
            for (const dirPath of config.fallbackDirs()) {
                _scanDir(dirPath, config.fallbackPattern, false, fallback);
            }
            for (const info of fallback) out.push({ ...info, sourceType: 'zcode-rollout' });
        }
        return out;
    }

    for (const dirPath of config.dirs()) {
        _scanDir(dirPath, config.pattern, config.recursive, out);
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Parsing — full re-read of a changed file. Stage 2 will add offset increments.
// ─────────────────────────────────────────────────────────────────────────

function _loadContentsSync(filePath) {
    const file = Gio.File.new_for_path(filePath);
    const [ok, contents] = file.load_contents(null);
    if (!ok) return new Uint8Array(0);
    return contents;
}

function _openReadStreamAsync(file) {
    return new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_DEFAULT, null, (s, r) => {
            try { resolve(s.read_finish(r)); } catch (e) { reject(e); }
        });
    });
}
function _readBytesAsync(stream, count) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(count, GLib.PRIORITY_DEFAULT, null, (s, r) => {
            try { resolve(s.read_bytes_finish(r).toArray()); } catch (e) { reject(e); }
        });
    });
}
function _concatBytes(a, b) {
    if (!a || a.length === 0) return b ? b.slice() : new Uint8Array(0);
    if (!b || b.length === 0) return a.slice();
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
function _lastNewlineByteIndex(bytes) {
    for (let i = bytes.length - 1; i >= 0; i--) if (bytes[i] === 0x0A) return i;
    return -1;
}

/**
 * Read a JSONL file fully, parse each complete line, return entries.
 * Honours MAX_LINE_BYTES: a line exceeding the cap is reported via the
 * warnings array and skipped rather than accumulated in the heap.
 */
/**
 * Read a JSONL file from `startOffset`, parse complete lines, and return the
 * entries plus the final offset / pending-tail bytes. Shared by the full
 * read (startOffset=0) and the incremental read (startOffset=cached.offset,
 * initialPendingTail=cached.pending_tail). Honours MAX_LINE_BYTES: a line
 * exceeding the cap is reported via warnings and dropped rather than
 * accumulated in the heap.
 */
async function _readJsonlStream(filePath, parseFn, { startOffset, initialPendingTail }) {
    const file = Gio.File.new_for_path(filePath);
    const stream = await _openReadStreamAsync(file);
    const entries = [];
    const warnings = [];
    let pendingTail = initialPendingTail || new Uint8Array(0);
    let bytesRead = 0;
    try {
        if (startOffset > 0) {
            stream.seek(startOffset, GLib.SeekType.SET, null);
        }
        while (true) {
            const data = await _readBytesAsync(stream, READ_CHUNK_BYTES);
            if (data.length === 0) break;
            bytesRead += data.length;
            const combined = _concatBytes(pendingTail, data);
            const lastNl = _lastNewlineByteIndex(combined);
            if (lastNl < 0) {
                if (combined.length > MAX_LINE_BYTES) {
                    warnings.push({ code: 'RECORD_TOO_LARGE', path: filePath, bytes: combined.length });
                    pendingTail = new Uint8Array(0);
                } else {
                    pendingTail = combined;
                }
                continue;
            }
            const parseable = TEXT_DECODER.decode(combined.subarray(0, lastNl + 1));
            for (const line of parseable.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const entry = parseFn(trimmed, filePath);
                    if (entry) entries.push(entry);
                } catch (_e) {
                    warnings.push({ code: 'INVALID_JSON', path: filePath, msg: _e.message });
                }
            }
            pendingTail = combined.slice(lastNl + 1);
        }
    } finally {
        try { stream.close(null); } catch (_e) {}
    }
    return { entries, bytesRead, warnings, pendingTail };
}

async function _readJsonlFull(filePath, parseFn) {
    const r = await _readJsonlStream(filePath, parseFn, {
        startOffset: 0, initialPendingTail: new Uint8Array(0),
    });
    // Full read: any trailing partial line is the file's last incomplete
    // record; try to parse it (it may be a complete final line without a
    // trailing newline).
    let entries = r.entries;
    if (r.pendingTail.length > 0) {
        const tail = TEXT_DECODER.decode(r.pendingTail).trim();
        if (tail) {
            try {
                const entry = parseFn(tail, filePath);
                if (entry) entries.push(entry);
            } catch (_e) {
                r.warnings.push({ code: 'INVALID_JSON', path: filePath, msg: _e.message });
            }
        }
    }
    return { entries, bytesRead: r.bytesRead, warnings: r.warnings };
}

/**
 * Read only the bytes appended since cached.offset. The leftover bytes
 * from the previous read (cached.pending_tail) are prepended so a UTF-8
 * character split across two reads is decoded correctly. For Codex, the
 * per-file session model is restored from cached.parser_state before
 * parsing so appended token_count records still resolve their model.
 */
async function _readJsonlIncremental(filePath, parseFn, cached) {
    const startOffset = Number(cached.offset) || 0;
    // pending_tail is persisted as base64 (see _encodeTail); decode it back
    // to raw bytes so a multibyte UTF-8 sequence split across reads is
    // rejoined before decoding.
    const initialPending = _decodeTail(cached.pending_tail);
    const r = await _readJsonlStream(filePath, parseFn, {
        startOffset,
        initialPendingTail: initialPending,
    });
    return {
        entries: r.entries,
        bytesRead: r.bytesRead,
        warnings: r.warnings,
        pendingTail: r.pendingTail,
        offset: startOffset + r.bytesRead,
    };
}

function _parseWholeFile(content, filePath, agent, parseFn) {
    if (!content) return { entries: [], warnings: [] };
    const text = TEXT_DECODER.decode(content);
    try {
        const entries = parseFn(text, filePath, agent) || [];
        return { entries, warnings: [] };
    } catch (e) {
        return { entries: [], warnings: [{ code: 'PARSE_FAILED', path: filePath, msg: e.message }] };
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Aggregate raw entries into (date, agent, raw_model) rows with locked-in
 * CNY cost. Mirrors DataProcessor._entryMetrics via the shared
 * entryMetrics.computeEntryMetrics so cost semantics stay identical.
 *
 * Returns a Map keyed by `${date}\0${agent}\0${raw_model}` whose values are
 * the rows that go straight into the snapshot's dailyUsage array.
 */
function _aggregateEntries(entries, costCtx) {
    const map = new Map();
    for (const entry of entries) {
        if (!entry.date) continue;
        const metrics = computeEntryMetrics(entry, costCtx);
        const agent = metrics.agent;
        const rawModel = entry.model || 'unknown';
        const usageSource = entry._usageSource || 'exact';
        const key = `${entry.date}\0${agent}\0${rawModel}\0${usageSource}`;
        let row = map.get(key);
        if (!row) {
            row = {
                date: entry.date,
                agent,
                raw_model: rawModel,
                inputTokens: 0, outputTokens: 0,
                cacheReadTokens: 0, cacheCreationTokens: 0,
                requestCount: 0, cost: 0,
                usageSource,
            };
            map.set(key, row);
        }
        row.inputTokens += metrics.usage.inputTokens;
        row.outputTokens += metrics.usage.outputTokens;
        row.cacheReadTokens += metrics.usage.cacheReadTokens;
        row.cacheCreationTokens += metrics.usage.cacheCreationTokens;
        row.requestCount += entryRequestCount(entry);
        row.cost += metrics.entryCost;
    }
    return map;
}

/**
 * Merge per-file contribution rows from an incremental read into the cached
 * contributions. Append-only semantics: new rows add to existing
 * (date,agent,raw_model) buckets; rows for new keys are appended. Returns a
 * fresh array (does not mutate inputs).
 */
function _mergeContributions(cachedRows, newRows) {
    const map = new Map();
    for (const r of cachedRows) {
        map.set(`${r.date}\0${r.agent}\0${r.raw_model}\0${r.usageSource || 'exact'}`, { ...r });
    }
    for (const r of newRows) {
        const key = `${r.date}\0${r.agent}\0${r.raw_model}\0${r.usageSource || 'exact'}`;
        const existing = map.get(key);
        if (existing) {
            existing.inputTokens += r.inputTokens;
            existing.outputTokens += r.outputTokens;
            existing.cacheReadTokens += r.cacheReadTokens;
            existing.cacheCreationTokens += r.cacheCreationTokens;
            existing.requestCount += r.requestCount;
            existing.cost += r.cost;
        } else {
            map.set(key, { ...r });
        }
    }
    return [...map.values()];
}

/**
 * Prefer provider/database usage for ZCode whenever it contains real token
 * counts.  A rollout estimate is selected only for the same day/model when
 * the database row is missing or entirely zero.  Keeping the sources apart
 * until this point prevents both double-counting and a zero DB row masking
 * the useful fallback.
 */
function _selectPreferredUsageRows(rows) {
    const groups = new Map();
    const passthrough = [];
    for (const row of rows) {
        if (row.agent !== 'zcode') {
            passthrough.push(row);
            continue;
        }
        const key = `${row.date}\0${row.agent}\0${row.raw_model}`;
        let group = groups.get(key);
        if (!group) {
            group = { database: [], zero: [], estimated: [] };
            groups.set(key, group);
        }
        if (row.usageSource === 'rollout-estimate') group.estimated.push(row);
        else if (row.usageSource === 'database-zero') group.zero.push(row);
        else group.database.push(row);
    }

    for (const group of groups.values()) {
        // If even some completed DB rows are zero, a small non-zero helper
        // request (for example session_title) must not mask hundreds of
        // missing main-turn usages aggregated under the same day/model.
        if (group.zero.length > 0 && group.estimated.length > 0) {
            passthrough.push(...group.estimated.map(row => ({ ...row, estimated: true })));
        } else if (group.database.length > 0) {
            passthrough.push(...group.database, ...group.zero);
        } else if (group.estimated.length > 0) {
            passthrough.push(...group.estimated.map(row => ({ ...row, estimated: true })));
        } else {
            passthrough.push(...group.zero);
        }
    }
    return passthrough;
}

/**
 * Encode a Uint8Array pending-tail as base64 so it survives JSON
 * serialization in file-state.json. Returns null for empty buffers.
 */
function _encodeTail(bytes) {
    if (!bytes || bytes.length === 0) return null;
    // GLib.base64_encode expects a text string of bytes; we feed it the raw
    // decoded chars then encode. Easier: use TextDecoder round-trip is
    // unsafe for partial UTF-8, so use glib base64 over the byte string.
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return GLib.base64_encode(binary);
}

/** Decode a base64 pending-tail back into a Uint8Array. */
function _decodeTail(b64) {
    if (!b64) return new Uint8Array(0);
    try {
        const binary = GLib.base64_decode(b64);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
    } catch (_e) {
        return new Uint8Array(0);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Main scan
// ─────────────────────────────────────────────────────────────────────────

async function runScan(opts) {
    const costCtx = {
        overridesJson: opts.priceOverrides,
        exchangeRate: opts.exchangeRate,
        aliasMap: parseAliasMap(opts.modelAliases),
    };

    // Stage-6 migration: if no snapshot exists yet but the legacy
    // daily-usage.json does, convert it to a snapshot first so the panel
    // shows prior history on the first worker run. The migration snapshot
    // is a fallback — if real logs exist, the scan below rebuilds from them
    // and overwrites the migration data (real logs are authoritative).
    let migratedRows = null;
    let migratedAgents = null;
    const existingSnap = loadSnapshot();
    if (!existingSnap) {
        const legacy = readLegacyArchive();
        if (legacy && legacy.rows.length > 0) {
            if (backupLegacyArchive()) {
                migratedRows = legacy.rows;
                migratedAgents = legacy.agents;
                if (opts.debug) _debug(`migrated ${migratedRows.length} rows from legacy daily-usage.json`);
            } else if (opts.debug) {
                _debug('legacy migration: backup failed, skipping');
            }
        }
    }

    const prevState = loadFileState();
    const nextState = {};
    const agentsStatus = {};
    let changedFiles = 0;
    let processedBytes = 0;
    let parsedRecords = 0;
    const scanId = GLib.uuid_string_random();
    const nowIso = new Date().toISOString();

    for (const agent of opts.agents) {
        const config = AGENT_CONFIGS[agent];
        if (!config) {
            agentsStatus[agent] = { status: 'failed', lastUpdated: nowIso, error: 'UNKNOWN_AGENT' };
            continue;
        }
        const fileType = _classifyAgent(config);
        let agentOk = true;
        let agentError = null;
        const warnings = [];

        try {
            const files = _collectFilesForAgent(agent, config);
            for (const info of files) {
                const currentFileType = info.sourceType === 'zcode-rollout' ? 'jsonl' : fileType;
                const cached = prevState[info.path];
                const decision = decideRefresh(cached, info, PARSER_VERSION, currentFileType);
                nextState[info.path] = {
                    agent,
                    inode: info.inode,
                    mtime_ns: info.mtime_ns,
                    size: info.size,
                    parser_version: PARSER_VERSION,
                    offset: 0,
                    pending_tail: null,
                    parser_state: cached?.parser_state ?? null,
                    // Per-file contribution rows. On 'skip'/'incremental' we
                    // build on the cached contribution; on 'full' we overwrite.
                    contributions: cached?.contributions || [],
                };
                if (decision === 'skip') {
                    nextState[info.path].offset = Number(cached?.offset) || 0;
                    nextState[info.path].pending_tail = cached?.pending_tail ?? null;
                    continue;
                }
                changedFiles += 1;

                let entries = [];
                if (currentFileType === 'sqlite') {
                    // SQLite: full (no watermark) or incremental (row-id
                    // watermark from cached). parseSQLiteAgent now returns
                    // { entries, lastRowId, lastTimestamp, errorCode }.
                    const watermark = decision === 'incremental' && cached
                        ? { lastRowId: cached.last_row_id, lastTimestamp: cached.last_timestamp }
                        : null;
                    const qr = await parseSQLiteAgent(agent, info.path, config, watermark);
                    if (qr.errorCode) {
                        // Database locked / schema mismatch / query failed:
                        // keep the cached contributions (don't wipe on a
                        // transient error) and mark the agent failed.
                        nextState[info.path].contributions = cached?.contributions || [];
                        nextState[info.path].last_row_id = cached?.last_row_id ?? 0;
                        nextState[info.path].last_timestamp = cached?.last_timestamp ?? null;
                        agentOk = false;
                        agentError = qr.errorCode;
                        warnings.push({ code: qr.errorCode, path: info.path });
                        continue;
                    }
                    entries = qr.entries;
                    parsedRecords += entries.length;
                    processedBytes += info.size;
                    nextState[info.path].last_row_id = qr.lastRowId;
                    nextState[info.path].last_timestamp = qr.lastTimestamp;
                    // SQLite is aggregated inside this branch (before the
                    // common stamping block below), so attach the agent here
                    // or computeEntryMetrics would fall back to `claude`.
                    for (const entry of entries) entry._agent = agent;
                    // zcode incremental (overlap window) may re-return rows
                    // we've already counted; the upsert merge below handles
                    // dedup by overwriting (not adding) on full re-query of
                    // the overlap region. For a true append (new rowid), the
                    // new row accumulates. We approximate by treating SQLite
                    // incremental like JSONL incremental (merge/accumulate);
                    // since rowid is monotonic and we only ever query
                    // rowid > last, true re-returns don't happen for
                    // append-only agents. zcode's overlap re-return is
                    // handled by the worker's contribution rebuild (below).
                    const fileMap = _aggregateEntries(entries, costCtx);
                    if (decision === 'incremental' && (cached?.contributions?.length || 0) > 0) {
                        nextState[info.path].contributions =
                            _mergeContributions(nextState[info.path].contributions, [...fileMap.values()]);
                    } else {
                        nextState[info.path].contributions = [...fileMap.values()];
                    }
                    continue;  // SQLite branch handles its own aggregation above
                } else if (currentFileType === 'whole-file') {
                    const content = _loadContentsSync(info.path);
                    processedBytes += content.length;
                    const r = _parseWholeFile(content, info.path, agent, config.parse);
                    entries = r.entries;
                    warnings.push(...r.warnings);
                    parsedRecords += entries.length;
                } else if (decision === 'incremental') {
                    // JSONL append-only: read only the bytes appended since
                    // cached.offset. For Codex, restore the per-file session
                    // model first so appended records resolve their model.
                    if (agent === 'codex') {
                        setCodexSessionModel(info.path, cached?.parser_state?.model);
                    }
                    const parseFn = info.sourceType === 'zcode-rollout'
                        ? parseZCodeRolloutLine : config.parse;
                    const inc = await _readJsonlIncremental(info.path, parseFn, cached);
                    entries = inc.entries;
                    processedBytes += inc.bytesRead;
                    warnings.push(...inc.warnings);
                    parsedRecords += entries.length;
                    nextState[info.path].offset = inc.offset;
                    nextState[info.path].pending_tail = _encodeTail(inc.pendingTail);
                    if (agent === 'codex') {
                        nextState[info.path].parser_state = {
                            model: getCodexSessionModel(info.path) || cached?.parser_state?.model || null,
                        };
                    }
                } else {
                    // 'full' JSONL: cold / truncate / rotation / in-place
                    // rewrite. Reset Codex state so stale models don't leak.
                    if (agent === 'codex') setCodexSessionModel(info.path, null);
                    const parseFn = info.sourceType === 'zcode-rollout'
                        ? parseZCodeRolloutLine : config.parse;
                    const r = await _readJsonlFull(info.path, parseFn);
                    entries = r.entries;
                    processedBytes += r.bytesRead;
                    warnings.push(...r.warnings);
                    parsedRecords += entries.length;
                    nextState[info.path].offset = info.size;
                    nextState[info.path].pending_tail = null;
                    if (agent === 'codex') {
                        nextState[info.path].parser_state = {
                            model: getCodexSessionModel(info.path) || null,
                        };
                    }
                }

                // Stamp _agent and aggregate this file's entries into its
                // own contribution rows. For 'incremental', merge with the
                // cached contributions (append-only: new entries add to the
                // existing per-(date,agent,raw_model) rows). For 'full',
                // overwrite the cached contributions entirely.
                for (const entry of entries) {
                    if (entry._agent == null) entry._agent = agent;
                }
                const fileMap = _aggregateEntries(entries, costCtx);
                if (decision === 'incremental' && nextState[info.path].contributions.length > 0) {
                    nextState[info.path].contributions =
                        _mergeContributions(nextState[info.path].contributions, [...fileMap.values()]);
                } else {
                    nextState[info.path].contributions = [...fileMap.values()];
                }
            }
        } catch (e) {
            agentOk = false;
            agentError = e.message || String(e);
            if (opts.debug) _debug(`agent ${agent} failed: ${agentError}`);
        }

        agentsStatus[agent] = agentOk
            ? { status: 'ok', lastUpdated: nowIso, error: null }
            : { status: 'failed', lastUpdated: nowIso, error: agentError };
    }

    // Rebuild the snapshot from EVERY file's contributions — skipped files
    // included — so the snapshot always reflects the full set of currently
    // selected agents, not just the files changed this scan. Files that
    // disappeared (in prevState but not nextState) drop out automatically.
    const aggregated = new Map();
    for (const entry of Object.values(nextState)) {
        for (const row of entry.contributions || []) {
            const key = `${row.date}\0${row.agent}\0${row.raw_model}\0${row.usageSource || 'exact'}`;
            const existing = aggregated.get(key);
            if (existing) {
                existing.inputTokens += row.inputTokens;
                existing.outputTokens += row.outputTokens;
                existing.cacheReadTokens += row.cacheReadTokens;
                existing.cacheCreationTokens += row.cacheCreationTokens;
                existing.requestCount += row.requestCount;
                existing.cost += row.cost;
            } else {
                aggregated.set(key, { ...row });
            }
        }
    }

    // Stage-6 migration fallback: if the scan produced no rows (no real logs
    // for the selected agents — e.g. logs deleted but legacy archive kept),
    // use the migrated rows so the panel still shows historical usage. If
    // the scan DID produce rows, real logs are authoritative and the
    // migration data is discarded (it would otherwise double-count days
    // that exist in both the archive and the live logs).
    let dailyUsageRows;
    let migrationVersion = 0;
    if (aggregated.size === 0 && migratedRows && migratedRows.length > 0) {
        dailyUsageRows = migratedRows;
        migrationVersion = MIGRATION_VERSION;
        // Mark migrated agents as 'migrated' so the UI can distinguish "no
        // real logs" from a healthy scan.
        for (const a of migratedAgents || []) {
            if (!agentsStatus[a]) {
                agentsStatus[a] = { status: 'migrated', lastUpdated: nowIso, error: null };
            }
        }
    } else {
        dailyUsageRows = _selectPreferredUsageRows([...aggregated.values()]);
    }

    // Persist file state + snapshot. File state is persisted even on partial
    // failure so unchanged files stay skipped next scan; failed-agent files
    // keep their previous contributions so their data isn't lost.
    saveFileState(nextState);
    const dailyUsage = dailyUsageRows.sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 :
        a.agent < b.agent ? -1 : a.agent > b.agent ? 1 :
        a.raw_model < b.raw_model ? -1 : 1);
    const ok = writeSnapshot({
        generatedAt: nowIso,
        lastSuccessfulScan: nowIso,
        agentsStatus,
        dailyUsage,
        migrationVersion,
    });

    return {
        scanId,
        status: ok ? 'complete' : 'snapshot_write_failed',
        changedFiles,
        processedBytes,
        parsedRecords,
        agents: agentsStatus,
    };
}

// ─────────────────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────────────────

async function main() {
    const opts = parseArgs(ARGV);
    if (opts.help) {
        printHelp();
        return 0;
    }
    if (opts.debug) setDebugEnabled(true);
    if (!opts.extensionPath) {
        printerr('missing --extension-path');
        return 2;
    }
    // Note: an empty --agents list is allowed so a first run can still perform
    // the stage-6 legacy migration (which fills the snapshot from
    // daily-usage.json when no agents are selected / no real logs exist).
    try {
        const result = await runScan(opts);
        // Single short status line on stdout. The Shell reads this for
        // health reporting; raw entries never cross the process boundary.
        print(JSON.stringify(result));
        return result.status === 'complete' ? 0 : 1;
    } catch (e) {
        printerr(`[usage-worker] fatal: ${e.message}`);
        print(JSON.stringify({ scanId: null, status: 'failed', error: e.message }));
        return 1;
    }
}

const exitCode = await main();
// In gjs ES-module mode there is no `System` global and no portable
// spawn_exit_with_code; a non-zero exit would require a C helper. For stage 1
// the Shell keys off the stdout status JSON, not the process exit code, so
// returning normally (exit 0) is acceptable. We keep the value for tests.
if (exitCode !== 0) {
    printerr(`[usage-worker] exiting with non-zero status ${exitCode} (reported via status JSON)`);
}
