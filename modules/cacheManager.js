// File-level cache + change detection for agent log sources.
//
// Responsibility split:
//   * scanAndDiff(agents): walk every selected agent's directories, compare
//     each file's (mtime, size) against the cache, re-parse only the files
//     whose stat changed. Reports whether anything changed plus the most
//     recent mtime seen, which feeds the active/idle state machine.
//   * getMergedEntries(): return the flattened entries array (with `_agent`
//     injected per entry) used by DataProcessor. Reuses a memoised array
//     until the next file-level change invalidates it.
//
// Task 1 baseline: every changed file is fully re-read and fully re-parsed.
// Task 2 will add incremental jsonl reads (offset + pendingTail). Task 3
// will harden the SQLite path with WAL/SHM mtime tracking and result reuse.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    parseGeminiFile, parseAmpFile, parseCodeBuffFile, parseKiroCliSessionFile, parseSQLiteAgent,
} from './parsers.js';

export const IDLE_THRESHOLD_MS = 120 * 1000;

const TEXT_DECODER = new TextDecoder('utf-8');
const TEXT_ENCODER = new TextEncoder();
const EMPTY_BYTES = new Uint8Array(0);

/**
 * Concatenate two Uint8Arrays into a fresh copy. Used by the incremental
 * jsonl reader to glue the leftover bytes from the previous read with the
 * newly-read bytes before decoding — we must decode the whole multibyte
 * sequence at once, otherwise a UTF-8 character split across two reads is
 * permanently corrupted into U+FFFD on both sides.
 */
function _concatBytes(a, b) {
    if (!a || a.length === 0) return b ? b.slice() : EMPTY_BYTES.slice();
    if (!b || b.length === 0) return a.slice();
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/**
 * Find the byte index of the last 0x0A (newline) in a UTF-8 byte buffer.
 * This is safe to do on raw bytes because 0x0A never appears inside a
 * multibyte UTF-8 continuation/lead byte (they are all >= 0x80), so a byte
 * match unambiguously identifies a line boundary.
 */
function _lastNewlineByteIndex(bytes) {
    for (let i = bytes.length - 1; i >= 0; i--) {
        if (bytes[i] === 0x0A) return i;
    }
    return -1;
}

/**
 * Classify an agent config into one of three IO strategies. The classification
 * decides how the file's bytes turn into entries on a cache miss.
 *
 *   'sqlite'     — query the database via parseSQLiteAgent.
 *   'whole-file' — single JSON document parsed as one unit (Gemini/Amp/CodeBuff).
 *   'jsonl'      — one entry per line (everything else).
 */
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

export class FileCacheManager {
    constructor(settings, agentConfigs) {
        this._settings = settings;
        this._agentConfigs = agentConfigs;
        // filePath -> { agent, fileType, mtime, size, offset, pendingTailBytes, entries }
        this._fileCache = new Map();
        this._mergedEntries = null;
        this._mergedDirty = true;
        this._lastActivityAt = 0;
        // Serialise concurrent scanAndDiff calls. Without this, two async
        // scans (e.g. a timer tick + a settings-change-triggered rescan)
        // would interleave their mutations of _fileCache / _mergedEntries
        // and corrupt each other. Each call awaits the previous one's tail.
        this._scanChain = Promise.resolve();
    }

    _debug(msg) {
        if (this._settings.get_boolean('debug-mode')) {
            console.log(`Code Usage: ${msg}`);
        }
    }

    /**
     * Walk the selected agents, refresh cache entries for files whose
     * (mtime, size) differs from what we already cached, and prune entries
     * for files that have disappeared.
     *
     * Returns { changed, lastActivityAt } where lastActivityAt is the maximum
     * mtime (in ms) observed across every file the cache currently tracks
     * after this scan. The caller uses it to decide whether the user is
     * actively producing logs or has gone idle.
     */
    async scanAndDiff(agents) {
        // Queue this scan behind any in-flight one. The body mutates shared
        // cache state (_fileCache, _mergedEntries) so concurrent execution
        // would lose updates; serialising via a promise chain is enough
        // because GJS is single-threaded and the body only awaits on the
        // sqlite subprocess, not on any IO that could benefit from overlap.
        const run = () => this._scanAndDiffImpl(agents);
        this._scanChain = this._scanChain.then(run, run);
        return this._scanChain;
    }

    async _scanAndDiffImpl(agents) {
        const seenPaths = new Set();
        let anyChanged = false;
        let maxMtimeMs = 0;
        let bytesRead = 0;
        let filesParsed = 0;
        let incrementalCount = 0;

        for (const agent of agents) {
            const config = this._agentConfigs[agent];
            if (!config) continue;

            const defaultFileType = _classifyAgent(config);
            const files = this._collectFilesForAgent(agent, config, defaultFileType);

            for (const info of files) {
                const fileType = info.fileType || defaultFileType;
                const parserConfig = info.config || config;

                seenPaths.add(info.path);
                if (info.mtimeMs > maxMtimeMs) maxMtimeMs = info.mtimeMs;

                const cached = this._fileCache.get(info.path);
                const decision = this._decideRefresh(cached, info, fileType, agent);
                if (decision === 'skip') continue;

                anyChanged = true;
                filesParsed += 1;

                try {
                    if (fileType === 'sqlite') {
                        const entries = await parseSQLiteAgent(agent, info.path, parserConfig);
                        this._fileCache.set(info.path, {
                            agent,
                            fileType,
                            mtimeMs: info.mtimeMs,
                            size: info.size,
                            offset: 0,
                            pendingTailBytes: null,
                            entries,
                        });
                    } else if (decision === 'incremental') {
                        const result = this._readJsonlIncremental(cached, info, agent, parserConfig);
                        bytesRead += result.bytesRead;
                        if (result.mode === 'incremental') incrementalCount += 1;
                        // Mutate the cache entry in place; entries array is owned
                        // by the cache and merged-flat is rebuilt on demand.
                        cached.entries = result.entries;
                        cached.offset = result.offset;
                        cached.pendingTailBytes = result.pendingTailBytes;
                        cached.mtimeMs = info.mtimeMs;
                        cached.size = info.size;
                    } else {
                        // 'full': cold load, whole-file agent, truncation, or
                        // in-place rewrite where size matches but mtime advanced.
                        const content = this._readWholeFile(info.path);
                        bytesRead += content.byteLength;
                        const parsed = this._parseSnapshot(content.text, info.path, agent, parserConfig, fileType);
                        this._fileCache.set(info.path, {
                            agent,
                            fileType,
                            mtimeMs: info.mtimeMs,
                            size: info.size,
                            offset: content.byteLength,
                            pendingTailBytes: parsed.pendingTailBytes,
                            entries: parsed.entries,
                        });
                    }
                } catch (e) {
                    this._debug(`refresh failed ${info.path}: ${e.message}`);
                }
            }
        }

        // Prune cache entries for files that no longer exist or are no longer
        // covered by the selected agents.
        for (const [path, _e] of this._fileCache.entries()) {
            if (!seenPaths.has(path)) {
                this._fileCache.delete(path);
                anyChanged = true;
            }
        }

        if (anyChanged) {
            this._mergedDirty = true;
            this._debug(
                `scan: ${filesParsed} refreshed (${incrementalCount} incremental), ` +
                `${bytesRead} bytes read, ${this._fileCache.size} cached`,
            );
        }
        this._lastActivityAt = maxMtimeMs;

        return { changed: anyChanged, lastActivityAt: this._lastActivityAt };
    }

    /**
     * Decide which refresh strategy applies to a single file based on the
     * cached state and the freshly-stat'd info.
     *
     *   'skip'        — cache is up to date, nothing to do.
     *   'incremental' — append-only growth on a jsonl file; safe to read tail.
     *   'full'        — cold cache miss, whole-file agent, sqlite, truncation,
     *                   or in-place edit (size unchanged but mtime advanced).
     */
    _decideRefresh(cached, info, fileType, agent) {
        if (!cached) return 'full';
        if (cached.agent !== agent || cached.fileType !== fileType) return 'full';
        if (cached.mtimeMs === info.mtimeMs && cached.size === info.size) return 'skip';
        if (fileType !== 'jsonl') return 'full';
        // Append-only growth → safe to incrementally read the tail.
        if (info.size > cached.size && info.mtimeMs >= cached.mtimeMs) {
            return 'incremental';
        }
        // Truncation, rotation, or in-place edit → reload whole file.
        return 'full';
    }

    /**
     * Flatten cached entries into a single array. Memoised until the next
     * cache invalidation. Each returned entry has `_agent` set so downstream
     * processing can attribute usage to the correct agent.
     */
    getMergedEntries() {
        if (this._mergedEntries !== null && !this._mergedDirty) {
            return this._mergedEntries;
        }
        const all = [];
        const seenDedupeKeys = new Set();
        for (const cached of this._fileCache.values()) {
            for (const entry of cached.entries) {
                if (entry._dedupeKey) {
                    if (seenDedupeKeys.has(entry._dedupeKey)) continue;
                    seenDedupeKeys.add(entry._dedupeKey);
                }
                entry._agent = cached.agent;
                all.push(entry);
            }
        }
        this._mergedEntries = all;
        this._mergedDirty = false;
        return all;
    }

    /**
     * Drop parsed records outside the active local day while keeping each
     * file's offset and stat metadata. Subsequent JSONL refreshes continue
     * from the current tail, so the normal polling path no longer retains a
     * full historical copy after that history has been archived.
     */
    retainEntriesForDate(date) {
        let changed = false;
        for (const cached of this._fileCache.values()) {
            const retained = cached.entries.filter(entry => entry.date === date);
            if (retained.length !== cached.entries.length) {
                cached.entries = retained;
                changed = true;
            }
        }
        if (changed) {
            this._mergedEntries = null;
            this._mergedDirty = true;
        }
    }

    /** Drop all cached state. Used when the cache structure must be rebuilt. */
    clear() {
        this._fileCache.clear();
        this._mergedEntries = null;
        this._mergedDirty = true;
        this._lastActivityAt = 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    // private helpers
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Resolve a list of {path, mtimeMs, size} entries that this agent's config
     * currently exposes. SQLite agents enumerate db files explicitly; file-based
     * agents recurse via the scanner.
     */
    _collectFilesForAgent(agent, config, fileType) {
        const out = [];
        const dirs = config.dirs();

        if (fileType === 'sqlite') {
            if (config.dbPaths) {
                for (const dbPath of config.dbPaths()) {
                    const stat = this._statSqliteWithSidecars(dbPath);
                    if (stat) {
                        out.push({ path: dbPath, mtimeMs: stat.mtimeMs, size: stat.size });
                    }
                }
            }

            for (const dirPath of dirs) {
                for (const dbFile of config.dbFiles) {
                    const dbPath = GLib.build_filenamev([dirPath, dbFile]);
                    const stat = this._statSqliteWithSidecars(dbPath);
                    if (stat) {
                        out.push({ path: dbPath, mtimeMs: stat.mtimeMs, size: stat.size });
                    }
                }
            }

            if (config.archiveDirs && config.archiveParse) {
                const archiveConfig = { parse: config.archiveParse };
                const archiveFiles = [];
                for (const dirPath of config.archiveDirs()) {
                    this._scanDir(
                        dirPath,
                        config.archivePattern || /\.json$/,
                        config.archiveRecursive || false,
                        archiveFiles,
                    );
                }
                for (const archive of archiveFiles) {
                    out.push({
                        ...archive,
                        fileType: 'whole-file',
                        config: archiveConfig,
                    });
                }
            }

            return out;
        }

        for (const dirPath of dirs) {
            this._scanDir(dirPath, config.pattern, config.recursive, out);
        }
        return out;
    }

    /**
     * SQLite databases in WAL mode often leave the main .db file's mtime
     * untouched while writes accumulate in the .db-wal sidecar. Treat the
     * (mtime, size) tuple as the union over .db, .db-wal, and .db-shm so
     * change detection still fires when the user has been actively writing.
     *
     * Returns null if the main .db file does not exist.
     */
    _statSqliteWithSidecars(dbPath) {
        const main = this._statFile(dbPath);
        if (!main) return null;

        let mtimeMs = main.mtimeMs;
        let size = main.size;
        for (const suffix of ['-wal', '-shm']) {
            const side = this._statFile(dbPath + suffix);
            if (!side) continue;
            if (side.mtimeMs > mtimeMs) mtimeMs = side.mtimeMs;
            // Sum sidecar sizes into the signature so a growing WAL trips
            // the cache without needing a separate field; this number is a
            // change-detection key, not a literal file size.
            size += side.size;
        }
        return { mtimeMs, size };
    }

    _scanDir(dirPath, pattern, recursive, out) {
        const dir = Gio.File.new_for_path(dirPath);
        if (!dir.query_exists(null)) return;

        let enumerator;
        try {
            enumerator = dir.enumerate_children(
                'standard::name,standard::type,time::modified,time::modified-usec,standard::size',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null,
            );
        } catch (e) {
            this._debug(`enumerate failed ${dirPath}: ${e.message}`);
            return;
        }

        try {
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const childType = info.get_file_type();
                const child = enumerator.get_child(info);
                const childPath = child.get_path();

                if (childType === Gio.FileType.DIRECTORY) {
                    if (recursive) this._scanDir(childPath, pattern, true, out);
                } else if (childType === Gio.FileType.REGULAR) {
                    const name = info.get_name();
                    if (!pattern || pattern.test(name)) {
                        out.push({
                            path: childPath,
                            mtimeMs: _mtimeMsFromInfo(info),
                            size: Number(info.get_size()),
                        });
                    }
                }
            }
        } catch (e) {
            this._debug(`iter failed ${dirPath}: ${e.message}`);
        } finally {
            try { enumerator.close(null); } catch (_e) { /* ignore */ }
        }
    }

    _statFile(filePath) {
        const file = Gio.File.new_for_path(filePath);
        if (!file.query_exists(null)) return null;
        try {
            const info = file.query_info(
                'time::modified,time::modified-usec,standard::size',
                Gio.FileQueryInfoFlags.NONE,
                null,
            );
            return {
                mtimeMs: _mtimeMsFromInfo(info),
                size: Number(info.get_size()),
            };
        } catch (e) {
            this._debug(`stat failed ${filePath}: ${e.message}`);
            return null;
        }
    }

    _readWholeFile(filePath) {
        try {
            const file = Gio.File.new_for_path(filePath);
            const [ok, contents] = file.load_contents(null);
            if (!ok) return { text: '', byteLength: 0 };
            return {
                text: TEXT_DECODER.decode(contents),
                byteLength: contents.length,
            };
        } catch (e) {
            this._debug(`read failed ${filePath}: ${e.message}`);
            return { text: '', byteLength: 0 };
        }
    }

    /**
     * Read the tail bytes of a jsonl file that have been appended since the
     * last scan, parse newly-completed lines, and stash any unfinished
     * trailing line (as raw UTF-8 bytes, to survive multibyte splits) in
     * pendingTailBytes for the next call. The caller is responsible for
     * committing the returned values back to the cache.
     *
     * Returns { entries, offset, pendingTailBytes, bytesRead, mode } where mode is:
     *   'incremental'      — normal append-only path, only new bytes read.
     *   'truncate-reload'  — file shrank or mtime regressed; full reload done.
     *   'fallback-reload'  — incremental read failed; fell back to full reload.
     */
    _readJsonlIncremental(cached, info, agent, config) {
        // Defensive: if size went backwards or mtime regressed, the file was
        // truncated/rotated. Discard cached state and reload from scratch.
        if (info.size < cached.size || info.mtimeMs < cached.mtimeMs) {
            this._debug(`truncation detected ${info.path} (size ${cached.size}->${info.size})`);
            const content = this._readWholeFile(info.path);
            const parsed = this._parseSnapshot(content.text, info.path, agent, config, 'jsonl');
            return {
                entries: parsed.entries,
                offset: content.byteLength,
                pendingTailBytes: parsed.pendingTailBytes,
                bytesRead: content.byteLength,
                mode: 'truncate-reload',
            };
        }

        const newBytes = info.size - cached.offset;
        if (newBytes <= 0) {
            // Size matches our offset; nothing actually new even though stat
            // claimed a change (e.g. mtime touched without write). Keep state.
            return {
                entries: cached.entries,
                offset: cached.offset,
                pendingTailBytes: cached.pendingTailBytes,
                bytesRead: 0,
                mode: 'incremental',
            };
        }

        let data;
        try {
            const file = Gio.File.new_for_path(info.path);
            const stream = file.read(null);
            try {
                if (cached.offset > 0) {
                    stream.skip(cached.offset, null);
                }
                const bytes = stream.read_bytes(newBytes, null);
                data = bytes.toArray();
            } finally {
                try { stream.close(null); } catch (_e) { /* ignore */ }
            }
        } catch (e) {
            this._debug(`incremental read failed ${info.path}: ${e.message}; falling back to full reload`);
            const content = this._readWholeFile(info.path);
            const parsed = this._parseSnapshot(content.text, info.path, agent, config, 'jsonl');
            return {
                entries: parsed.entries,
                offset: content.byteLength,
                pendingTailBytes: parsed.pendingTailBytes,
                bytesRead: content.byteLength,
                mode: 'fallback-reload',
            };
        }

        // Glue the leftover bytes from the previous read (which may end in
        // the middle of a multibyte UTF-8 character) with the newly-read
        // bytes, then find the last newline *on the raw byte stream* — 0x0A
        // never appears inside a multibyte UTF-8 sequence, so this is a safe
        // line boundary. Everything up to and including that newline is
        // decodable as complete text; the bytes after it become the new
        // pendingTailBytes, preserved verbatim for the next cycle.
        const combinedBytes = _concatBytes(cached.pendingTailBytes, data);
        const lastNewline = _lastNewlineByteIndex(combinedBytes);

        let parseable, newPendingTailBytes;
        if (lastNewline < 0) {
            parseable = '';
            // Copy so we don't pin the whole combinedBytes buffer alive.
            newPendingTailBytes = combinedBytes.slice();
        } else {
            parseable = TEXT_DECODER.decode(combinedBytes.subarray(0, lastNewline + 1));
            newPendingTailBytes = combinedBytes.slice(lastNewline + 1);
            if (newPendingTailBytes.length === 0) newPendingTailBytes = null;
        }

        const entries = cached.entries;
        if (parseable) {
            const lines = parseable.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const entry = config.parse(trimmed, info.path);
                    if (entry) entries.push(entry);
                } catch (_e) {
                    /* skip malformed line */
                }
            }
        }

        return {
            entries,
            offset: info.size,
            pendingTailBytes: newPendingTailBytes,
            bytesRead: newBytes,
            mode: 'incremental',
        };
    }

    /**
     * Full re-parse of a file snapshot. JSONL snapshots preserve an
     * unfinished trailing line so the next incremental read can complete it.
     */
    _parseSnapshot(content, filePath, agent, config, fileType) {
        if (!content) return { entries: [], pendingTailBytes: null };
        if (fileType === 'whole-file') {
            try {
                return { entries: config.parse(content, filePath, agent) || [], pendingTailBytes: null };
            } catch (e) {
                this._debug(`whole-file parse failed ${filePath}: ${e.message}`);
                return { entries: [], pendingTailBytes: null };
            }
        }

        return this._parseJsonlSnapshot(content, filePath, config);
    }

    _parseJsonlSnapshot(content, filePath, config) {
        const out = [];
        let parseable = content;
        let pendingTail = '';

        const lastNewline = content.lastIndexOf('\n');
        if (lastNewline < 0) {
            parseable = this._looksLikeCompleteJsonLine(content) ? content : '';
            pendingTail = parseable ? '' : content;
        } else if (lastNewline < content.length - 1) {
            const tail = content.slice(lastNewline + 1);
            if (!this._looksLikeCompleteJsonLine(tail)) {
                parseable = content.slice(0, lastNewline);
                pendingTail = tail;
            }
        }

        // jsonl: one entry per line.
        const lines = parseable.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const entry = config.parse(trimmed, filePath);
                if (entry) out.push(entry);
            } catch (_e) {
                /* skip malformed line */
            }
        }
        // Encode the trailing partial line back to raw UTF-8 bytes so the
        // incremental reader can concatenate it with the next read's bytes
        // and decode the whole multibyte sequence at once.
        const pendingTailBytes = pendingTail ? TEXT_ENCODER.encode(pendingTail) : null;
        return { entries: out, pendingTailBytes };
    }

    _looksLikeCompleteJsonLine(line) {
        const trimmed = line.trim();
        if (!trimmed) return true;
        try {
            JSON.parse(trimmed);
            return true;
        } catch (_e) {
            return false;
        }
    }
}

/**
 * Convert a Gio.FileInfo's modification time into milliseconds since epoch.
 * Combines seconds + microseconds when the latter is available so that two
 * writes within the same wall-clock second still register as distinct mtimes.
 */
function _mtimeMsFromInfo(info) {
    const sec = Number(info.get_attribute_uint64('time::modified'));
    let usec = 0;
    try {
        usec = Number(info.get_attribute_uint32('time::modified-usec')) || 0;
    } catch (_e) {
        usec = 0;
    }
    return sec * 1000 + Math.floor(usec / 1000);
}
