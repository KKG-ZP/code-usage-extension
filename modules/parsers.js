// Parsers for all supported agent log formats
// Each parser returns: { date, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, costUSD }

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

let _sqlite3Path = null;
let _sqlite3Checked = false;

// Mirrors the extension's `debug-mode` setting so parser-layer failures
// (which are otherwise swallowed to keep the panel alive) become visible.
// Toggled via setDebugEnabled() from panelIndicator.
let _debugEnabled = false;
export function setDebugEnabled(enabled) {
    _debugEnabled = !!enabled;
}
function _debug(msg) {
    if (_debugEnabled) {
        console.log(`Code Usage: ${msg}`);
    }
}

// Hard cap for a single sqlite3 subprocess. Without it a corrupted/locked
// database can hang the communicate_utf8 callback forever, which blocks the
// serialised refresh pipeline and silently stops all updates.
const SQLITE_TIMEOUT_MS = 10000;

function _findSqlite3() {
    if (_sqlite3Checked) return _sqlite3Path;
    _sqlite3Checked = true;

    const homeDir = GLib.get_home_dir();
    const candidates = new Set();

    const systemPaths = [
        '/usr/bin/sqlite3',
        '/usr/local/bin/sqlite3',
        '/opt/homebrew/bin/sqlite3',
        '/home/linuxbrew/.linuxbrew/bin/sqlite3',
    ];
    for (const p of systemPaths) candidates.add(p);

    const pathEnv = GLib.getenv('PATH') || '';
    for (const p of pathEnv.split(':')) {
        if (p && p.trim()) {
            candidates.add(GLib.build_filenamev([p.trim(), 'sqlite3']));
        }
    }

    const homeBinPaths = [
        GLib.build_filenamev([homeDir, '.local', 'bin', 'sqlite3']),
        GLib.build_filenamev([homeDir, 'bin', 'sqlite3']),
    ];
    for (const p of homeBinPaths) candidates.add(p);

    const homeSubdirs = [
        'miniconda3', 'anaconda3', 'miniforge3', 'mambaforge',
        'APP/miniconda3', 'APP/anaconda3', 'APP/miniforge3',
    ];
    for (const sub of homeSubdirs) {
        candidates.add(GLib.build_filenamev([homeDir, sub, 'bin', 'sqlite3']));
    }

    for (const candidate of candidates) {
        const file = Gio.File.new_for_path(candidate);
        if (file.query_exists(null)) {
            _sqlite3Path = candidate;
            break;
        }
    }

    return _sqlite3Path;
}

// ═══════════════════════════════════════
// Claude Code
// ═══════════════════════════════════════
export function parseClaudeEntry(line, filePath) {
    try {
        const raw = JSON.parse(line);
        const entry = raw;

        if (raw.data && raw.data.message) {
            const inner = raw.data.message;
            return _extractClaudeUsage(inner, inner.costUSD || raw.data.costUSD);
        }

        if (raw.message && raw.message.usage) {
            return _extractClaudeUsage(raw, raw.costUSD);
        }

        return null;
    } catch {
        return null;
    }
}

function _extractClaudeUsage(raw, costUSD) {
    const usage = raw.message ? raw.message.usage : raw.usage;
    if (!usage) return null;

    const inputTokens = usage.inputTokens || usage.input_tokens || 0;
    const outputTokens = usage.outputTokens || usage.output_tokens || 0;
    if (!inputTokens && !outputTokens) return null;

    const model = raw.message ? (raw.message.model || raw.model) : raw.model;
    const timestamp = raw.timestamp || raw.message?.timestamp;

    return {
        date: _extractDate(timestamp),
        model: model || 'claude',
        inputTokens,
        outputTokens,
        cacheCreationTokens: usage.cacheCreationInputTokens || usage.cache_creation_input_tokens || 0,
        cacheReadTokens: usage.cacheReadInputTokens || usage.cache_read_input_tokens || 0,
        costUSD: costUSD != null ? costUSD : null,
    };
}

const _codexSessionModels = new Map();

/**
 * Read/write the Codex per-file session model used by parseCodexLine.
 * Exported so the worker can persist this state across incremental reads:
 * an offset-based read starting mid-file would otherwise miss the
 * `turn_context` line that seeded the model, making appended token_count
 * records fall back to the generic 'codex' model id.
 */
export function getCodexSessionModel(filePath) {
    return _codexSessionModels.get(filePath);
}

export function setCodexSessionModel(filePath, model) {
    if (model) _codexSessionModels.set(filePath, model);
    else _codexSessionModels.delete(filePath);
}

/** Clear all Codex session-model state. Used by the worker before a full
 *  re-parse of a Codex file so stale models from a prior run don't leak. */
export function clearCodexSessionModels() {
    _codexSessionModels.clear();
}

export function parseCodexLine(line, filePath) {
    try {
        const raw = JSON.parse(line);

        if (raw.type === 'session_meta') {
            return null;
        }

        if (raw.type === 'turn_context' || raw.payload?.type === 'turn_context') {
            const model = raw.payload?.model;
            if (model) _codexSessionModels.set(filePath, model);
            return null;
        }

        let usage = null;
        let model = null;
        let timestamp = null;

        if (raw.type === 'event_msg' && raw.payload?.type === 'token_count') {
            const info = raw.payload.info;
            if (!info) return null;
            usage = info.last_token_usage || info.total_token_usage;
            model = info.model || info.model_name || raw.payload.model || _codexSessionModels.get(filePath);
            timestamp = raw.timestamp;
        } else if (raw.type === 'turn.completed' && raw.usage) {
            usage = raw.usage;
            model = raw.model || _codexSessionModels.get(filePath);
            timestamp = raw.timestamp;
        } else if (raw.type === 'result' && raw.data) {
            usage = raw.data.usage;
            model = raw.data.model_name || raw.data.model || _codexSessionModels.get(filePath);
            timestamp = raw.data.timestamp;
        }

        if (!usage) return null;

        return {
            date: _extractDate(timestamp),
            model: model || 'codex',
            inputTokens: _pick(usage, ['input_tokens', 'prompt_tokens', 'input']) || 0,
            outputTokens: _pick(usage, ['output_tokens', 'completion_tokens', 'output']) || 0,
            cacheCreationTokens: 0,
            cacheReadTokens: _pick(usage, ['cached_input_tokens', 'cache_read_input_tokens', 'cached_tokens']) || 0,
            costUSD: null,
        };
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════
// Gemini
// ═══════════════════════════════════════
export function parseGeminiFile(content, filePath, agent) {
    const entries = [];

    try {
        if (filePath.endsWith('.jsonl')) {
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const entry = _parseGeminiJSON(trimmed);
                if (entry) entries.push(entry);
            }
        } else {
            const parsed = JSON.parse(content);
            const result = _parseGeminiJSONObj(parsed);
            if (result) {
                if (Array.isArray(result)) entries.push(...result);
                else entries.push(result);
            }
        }
    } catch {
        // try JSONL
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const entry = _parseGeminiJSON(trimmed);
                if (entry) entries.push(entry);
            } catch { /* skip */ }
        }
    }

    return entries;
}

function _parseGeminiJSON(line) {
    try {
        const raw = JSON.parse(line);
        return _parseGeminiJSONObj(raw);
    } catch {
        return null;
    }
}

function _parseGeminiJSONObj(raw) {
    // Shape 3: stats-based
    if (raw.stats?.models) {
        const entries = [];
        for (const [model, data] of Object.entries(raw.stats.models)) {
            const tokens = data.tokens || {};
            entries.push({
                date: _extractDate(raw.timestamp),
                model,
                inputTokens: _pick(tokens, ['input', 'prompt', 'input_tokens', 'prompt_tokens']) || 0,
                outputTokens: _pick(tokens, ['output', 'candidates', 'output_tokens', 'candidates_tokens']) || 0,
                cacheCreationTokens: 0,
                cacheReadTokens: _pick(tokens, ['cached', 'cached_tokens']) || 0,
                costUSD: null,
            });
        }
        return entries;
    }

    // Shape 1: session with messages array
    if (raw.messages && Array.isArray(raw.messages)) {
        const entries = [];
        for (const msg of raw.messages) {
            if (!msg.tokens && !msg.token_usage) continue;
            const t = msg.tokens || msg.token_usage || {};
            entries.push({
                date: _extractDate(msg.timestamp || raw.startTime),
                model: msg.model || raw.model || 'gemini',
                inputTokens: _pick(t, ['input', 'prompt', 'input_tokens', 'prompt_tokens']) || 0,
                outputTokens: _pick(t, ['output', 'candidates', 'output_tokens', 'candidates_tokens']) || 0,
                cacheCreationTokens: 0,
                cacheReadTokens: _pick(t, ['cached', 'cached_tokens']) || 0,
                costUSD: null,
            });
        }
        return entries;
    }

    // Shape 2: direct event
    if (raw.type === 'gemini' && (raw.tokens || raw.token_usage)) {
        const t = raw.tokens || raw.token_usage || {};
        return {
            date: _extractDate(raw.timestamp),
            model: raw.model || 'gemini',
            inputTokens: _pick(t, ['input', 'prompt', 'input_tokens']) || 0,
            outputTokens: _pick(t, ['output', 'candidates', 'output_tokens']) || 0,
            cacheCreationTokens: 0,
            cacheReadTokens: _pick(t, ['cached', 'cached_tokens']) || 0,
            costUSD: null,
        };
    }

    return null;
}

// ═══════════════════════════════════════
// Kimi
// ═══════════════════════════════════════
// The active model is NOT in the per-line payload — Kimi writes it to
// <kimi_root>/config.json as {"model":"kimi-k3"}. Mirror the Rust adapter
// (ccusage src/adapter/kimi/parser.rs read_model_from_config): walk four
// parents up from wire.jsonl (session/group/sessions/root) to the kimi root,
// read config.json's `model`, cache per file. Falls back to 'kimi' (the
// generic alias → kimi-k2-0905) when config is unreadable, preserving legacy
// behaviour so K2 users keep their existing pricing.
const _kimiModelCache = new Map();
const KIMI_DEFAULT_MODEL = 'kimi';

function _readKimiModelForWireFile(filePath) {
    const cached = _kimiModelCache.get(filePath);
    if (cached !== undefined) return cached;

    let model = KIMI_DEFAULT_MODEL;
    try {
        const wireFile = Gio.File.new_for_path(filePath);
        // wire.jsonl → session → group → sessions → kimi root
        const rootFile = wireFile.get_parent()?.get_parent()?.get_parent()?.get_parent();
        if (rootFile) {
            const configFile = rootFile.get_child('config.json');
            if (configFile.query_exists(null)) {
                const [ok, bytes] = configFile.load_contents(null);
                if (ok && bytes && bytes.length) {
                    const text = new TextDecoder().decode(bytes);
                    const cfg = JSON.parse(text);
                    if (typeof cfg.model === 'string' && cfg.model.trim()) {
                        model = cfg.model.trim();
                    }
                }
            }
        }
    } catch (e) {
        _debug(`Kimi config.json read failed (${filePath}): ${e?.message || e}`);
    }

    _kimiModelCache.set(filePath, model);
    return model;
}

export function parseKimiLine(line, filePath) {
    try {
        const raw = JSON.parse(line);
        if (!raw.message || raw.message.type !== 'StatusUpdate') return null;
        const payload = raw.message.payload;
        if (!payload?.token_usage) return null;

        const tu = payload.token_usage;
        return {
            date: _extractDate(raw.timestamp),
            model: _readKimiModelForWireFile(filePath),
            inputTokens: tu.input_other || 0,
            outputTokens: tu.output || 0,
            cacheCreationTokens: tu.input_cache_creation || 0,
            cacheReadTokens: tu.input_cache_read || 0,
            costUSD: null,
        };
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════
// OpenClaw
// ═══════════════════════════════════════
export function parseOpenClawLine(line, filePath) {
    try {
        const raw = JSON.parse(line);
        if (raw.type === 'model_change' || raw.type === 'custom') return null;
        if (!raw.message && raw.type !== 'message') return null;

        const msg = raw.message || raw;
        if (msg.role !== 'assistant') return null;

        const usage = msg.usage || msg.message?.usage;
        if (!usage) return null;

        return {
            date: _extractDate(raw.timestamp || msg.timestamp),
            model: msg.modelId || msg.model || raw.data?.modelId || 'openclaw',
            inputTokens: _pick(usage, ['input', 'input_tokens', 'prompt_tokens']) || 0,
            outputTokens: _pick(usage, ['output', 'output_tokens', 'completion_tokens']) || 0,
            cacheCreationTokens: _pick(usage, ['cacheWrite', 'cache_write', 'cache_creation']) || 0,
            cacheReadTokens: _pick(usage, ['cacheRead', 'cache_read', 'cache_read_tokens']) || 0,
            costUSD: usage.cost?.total ?? null,
        };
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════
// PI Agent
// ═══════════════════════════════════════
export function parsePILine(line, filePath) {
    try {
        const raw = JSON.parse(line);
        if (!raw.message || raw.message.role !== 'assistant') return null;
        const usage = raw.message.usage;
        if (!usage) return null;

        return {
            date: _extractDate(raw.timestamp || raw.message.timestamp),
            model: raw.message.model || 'pi',
            inputTokens: _pick(usage, ['input', 'input_tokens', 'prompt_tokens']) || 0,
            outputTokens: _pick(usage, ['output', 'output_tokens', 'completion_tokens']) || 0,
            cacheCreationTokens: _pick(usage, ['cacheWrite', 'cache_write', 'cache_creation']) || 0,
            cacheReadTokens: _pick(usage, ['cacheRead', 'cache_read', 'cache_read_tokens']) || 0,
            costUSD: usage.cost?.total ?? null,
        };
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════
// Qwen
// ═══════════════════════════════════════
export function parseQwenLine(line, filePath) {
    try {
        const raw = JSON.parse(line);
        if (raw.type !== 'assistant') return null;
        const meta = raw.usageMetadata;
        if (!meta) return null;

        return {
            date: _extractDate(raw.timestamp),
            model: raw.model || 'qwen',
            inputTokens: meta.promptTokenCount || meta.input_tokens || 0,
            outputTokens: meta.candidatesTokenCount || meta.output_tokens || 0,
            cacheCreationTokens: 0,
            cacheReadTokens: meta.cachedContentTokenCount || meta.cached_tokens || 0,
            costUSD: null,
        };
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════
// GitHub Copilot CLI
// ═══════════════════════════════════════
export function parseCopilotLine(line, filePath) {
    try {
        const raw = JSON.parse(line);

        const attrs = raw.attributes || raw;
        const opName = attrs['gen_ai.operation.name'] || attrs['event.name'];

        if (opName === 'invoke_agent') return null;
        if (!attrs['gen_ai.usage.input_tokens'] && !attrs['gen_ai.usage.output_tokens']) return null;

        return {
            date: _extractDate(raw.startTime || raw.timestamp),
            model: attrs['gen_ai.response.model'] || attrs['request.model'] || 'copilot',
            inputTokens: attrs['gen_ai.usage.input_tokens'] || 0,
            outputTokens: attrs['gen_ai.usage.output_tokens'] || 0,
            cacheCreationTokens: attrs['gen_ai.usage.cache_write.input_tokens'] || attrs['gen_ai.usage.cache_creation'] || 0,
            cacheReadTokens: attrs['gen_ai.usage.cache_read.input_tokens'] || attrs['gen_ai.usage.cache_read_tokens'] || 0,
            costUSD: null,
        };
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════
// Amp
// ═══════════════════════════════════════
export function parseAmpFile(content, filePath, agent) {
    const entries = [];
    try {
        const raw = JSON.parse(content);
        const ledger = raw.usageLedger || {};
        const events = ledger.events || [];
        const messages = raw.messages || [];

        const cacheMap = {};
        for (const msg of messages) {
            if (msg.usage && msg.messageId != null) {
                cacheMap[msg.messageId] = msg.usage;
            }
        }

        for (const event of events) {
            if (!event.tokens) continue;
            const cache = cacheMap[event.toMessageId] || {};
            entries.push({
                date: _extractDate(event.timestamp),
                model: event.model || 'amp',
                inputTokens: event.tokens.input || 0,
                outputTokens: event.tokens.output || 0,
                cacheCreationTokens: cache.cacheCreationInputTokens || 0,
                cacheReadTokens: cache.cacheReadInputTokens || 0,
                costUSD: event.credits != null ? event.credits : null,
            });
        }
    } catch { /* skip */ }
    return entries;
}

// ═══════════════════════════════════════
// CodeBuff
// ═══════════════════════════════════════
export function parseCodeBuffFile(content, filePath, agent) {
    const entries = [];
    try {
        const raw = JSON.parse(content);
        const messages = Array.isArray(raw) ? raw : [raw];

        for (const msg of messages) {
            const role = msg.variant || msg.role;
            if (role !== 'ai' && role !== 'agent' && role !== 'assistant') continue;

            const usage = msg.metadata?.usage || msg.metadata?.codebuff?.usage;
            if (!usage) continue;

            entries.push({
                date: _extractDate(msg.timestamp),
                model: msg.metadata?.model || msg.metadata?.codebuff?.model || 'codebuff',
                inputTokens: _pick(usage, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']) || 0,
                outputTokens: _pick(usage, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']) || 0,
                cacheCreationTokens: _pick(usage, ['cacheCreationInputTokens', 'cache_creation_input_tokens', 'cacheCreationTokens', 'cache_creation_tokens']) || 0,
                cacheReadTokens: _pick(usage, ['cacheReadInputTokens', 'cache_read_input_tokens', 'cachedTokens', 'cached_tokens']) || 0,
                costUSD: msg.credits != null ? msg.credits : null,
            });
        }
    } catch { /* skip */ }
    return entries;
}

// ═══════════════════════════════════════
// Kiro CLI sessions
// ═══════════════════════════════════════
export function parseKiroCliSessionFile(content, filePath, agent) {
    try {
        const session = JSON.parse(content);
        const metadata = session.session_state?.conversation_metadata;
        const turns = Array.isArray(metadata?.user_turn_metadatas)
            ? metadata.user_turn_metadatas : [];
        if (turns.length === 0) return [];

        const modelInfo = session.session_state?.rts_model_state?.model_info || {};
        const rawModel = modelInfo.model_id || modelInfo.model_name || 'kiro-cli-credit';
        const model = _kiroCreditModel(rawModel);
        const sessionId = _kiroSessionIdFromPath(filePath);
        const entries = [];

        for (let index = 0; index < turns.length; index++) {
            const turn = turns[index] || {};
            const credit = _kiroMeteringValue(turn.metering_usage, 'credit');
            const inputTokens = turn.input_token_count || 0;
            const outputTokens = turn.output_token_count || 0;
            const timestamp = turn.end_timestamp || turn.result?.Ok?.meta?.timestamp ||
                session.updated_at || session.created_at;

            if (!credit && !inputTokens && !outputTokens) continue;

            entries.push({
                date: _extractDate(timestamp),
                model,
                inputTokens,
                outputTokens: outputTokens || credit,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                costUSD: null,
                meteringCredits: credit,
                _dedupeKey: `kiro:${sessionId}:${index}:${timestamp || ''}`,
            });
        }

        return entries;
    } catch (e) {
        _debug(`parseKiroCliSessionFile failed ${filePath}: ${e.message}`);
        return [];
    }
}

function _kiroMeteringValue(items, unit) {
    if (!Array.isArray(items)) return 0;
    let total = 0;
    for (const item of items) {
        if (!item || item.unit !== unit) continue;
        const value = Number(item.value);
        if (Number.isFinite(value)) total += value;
    }
    return total;
}

function _kiroCreditModel(rawModel) {
    const suffix = rawModel ? String(rawModel) : 'kiro';
    return `kiro-cli-credit/${suffix}`;
}

function _kiroSessionIdFromPath(filePath) {
    if (!filePath) return 'kiro';
    const base = String(filePath).split('/').pop() || 'kiro';
    return base.replace(/\.json$/, '') || 'kiro';
}

// ═══════════════════════════════════════
// SQLite agents (OpenCode, Goose, Hermes, Kilo, ZCode)
// ═══════════════════════════════════════
//
// parseSQLiteAgent accepts an optional watermark { lastRowId, lastTimestamp,
// overlapMs } so the worker can query only newly-appended rows instead of
// the whole table. Returns { entries, lastRowId, lastTimestamp, errorCode }
// where errorCode is null on success or one of:
//   DATABASE_LOCKED / QUERY_TIMEOUT / SCHEMA_MISMATCH / QUERY_FAILED
// A legitimately empty result (no new rows) returns entries=[] with
// errorCode=null — the caller must not conflate the two.

export async function parseSQLiteAgent(agent, dbPath, config, watermark) {
    const sqlite3 = _findSqlite3();
    if (!sqlite3) return { entries: [], lastRowId: 0, lastTimestamp: null, errorCode: 'SQLITE3_NOT_FOUND' };

    const wm = watermark;
    const isIncremental = !!wm && wm.lastRowId != null;
    const lastRowId = Number(wm?.lastRowId) || 0;
    const lastTimestamp = wm?.lastTimestamp || null;

    let sql, params;
    if (agent === 'opencode' || agent === 'kilo') {
        // message is append-only; rowid is the implicit monotonic PK.
        sql = isIncremental
            ? "SELECT rowid, data FROM message WHERE json_extract(data, '$.role') = 'assistant' AND rowid > ?"
            : "SELECT rowid, data FROM message WHERE json_extract(data, '$.role') = 'assistant'";
        params = isIncremental ? [lastRowId] : [];
    } else if (agent === 'goose') {
        sql = isIncremental
            ? 'SELECT id, model_config, provider_name, created_at, accumulated_input_tokens, accumulated_output_tokens, total_tokens FROM sessions WHERE id > ?'
            : 'SELECT id, model_config, provider_name, created_at, accumulated_input_tokens, accumulated_output_tokens, total_tokens FROM sessions';
        params = isIncremental ? [lastRowId] : [];
    } else if (agent === 'hermes') {
        sql = isIncremental
            ? 'SELECT id, model, started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, actual_cost_usd FROM sessions WHERE id > ?'
            : 'SELECT id, model, started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, actual_cost_usd FROM sessions';
        params = isIncremental ? [lastRowId] : [];
    } else if (agent === 'zcode') {
        // model_usage rows are written with a terminal status (completed/error)
        // in practice; status flips are rare. Use a pure rowid watermark so
        // incremental reads are simple append-only (no overlap/upsert). The
        // low-frequency reconciliation (stage 5) catches any missed flip.
        sql = isIncremental
            ? "SELECT rowid, started_at, model_id, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM model_usage WHERE status = 'completed' AND rowid > ?"
            : "SELECT rowid, started_at, model_id, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM model_usage WHERE status = 'completed'";
        params = isIncremental ? [lastRowId] : [];
    } else {
        return { entries: [], lastRowId: 0, lastTimestamp: null, errorCode: null };
    }

    const qr = await _querySqliteRows(sqlite3, dbPath, sql, params);
    if (qr.errorCode) {
        return { entries: [], lastRowId, lastTimestamp, errorCode: qr.errorCode };
    }
    const entries = [];
    let maxRowId = lastRowId;
    let maxTimestamp = lastTimestamp;
    for (const row of qr.rows) {
        const entry = _parseSQLiteRow(agent, row);
        if (entry) entries.push(entry);
        const rowId = _rowIdForAgent(agent, row);
        if (rowId != null && Number(rowId) > maxRowId) maxRowId = Number(rowId);
        const ts = _rowTimestampForAgent(agent, row);
        if (ts && (maxTimestamp == null || ts > maxTimestamp)) maxTimestamp = ts;
    }
    return { entries, lastRowId: maxRowId, lastTimestamp: maxTimestamp, errorCode: null };
}

function _rowIdForAgent(agent, row) {
    if (agent === 'opencode' || agent === 'kilo' || agent === 'zcode') return row.rowid;
    if (agent === 'goose' || agent === 'hermes') return row.id;
    return null;
}

function _rowTimestampForAgent(agent, row) {
    if (agent === 'zcode') return row.started_at;
    return null; // opencode/kilo/goose/hermes track rowid, not timestamp
}

function _querySqliteRows(sqlite3, dbPath, sql, params) {
    return new Promise((resolve) => {
        let settled = false;
        let timeoutId = 0;
        // Bind params into the SQL string. Params are from our own
        // file-state (numbers / ISO timestamps), not user input, but we
        // still escape single quotes defensively.
        let boundSql = sql;
        if (params) {
            let i = 0;
            boundSql = sql.replace(/\?/g, () => {
                const p = params[i++];
                if (p == null) return 'NULL';
                if (typeof p === 'number') return String(p);
                // string: wrap in single quotes, escape embedded quotes
                return "'" + String(p).replace(/'/g, "''") + "'";
            });
        }

        const finish = (value) => {
            if (settled) return;
            settled = true;
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                timeoutId = 0;
            }
            resolve(value);
        };

        let subprocess;
        try {
            const argv = [sqlite3, '-json', dbPath, boundSql];
            subprocess = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (e) {
            _debug(`sqlite3 spawn failed ${dbPath}: ${e.message}`);
            finish({ rows: [], errorCode: 'QUERY_FAILED' });
            return;
        }

        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SQLITE_TIMEOUT_MS, () => {
            timeoutId = 0;
            try { subprocess.force_exit(); } catch (_e) { /* ignore */ }
            _debug(`sqlite3 timed out after ${SQLITE_TIMEOUT_MS}ms ${dbPath}`);
            finish({ rows: [], errorCode: 'QUERY_TIMEOUT' });
            return GLib.SOURCE_REMOVE;
        });

        subprocess.communicate_utf8_async(null, null, (proc, result) => {
            try {
                const [ok, stdout, stderr] = proc.communicate_utf8_finish(result);
                const errText = (stderr || '').trim();
                // Classify errors from stderr before treating empty stdout
                // as "no rows". sqlite3 prints "Error: database is locked"
                // or "Error: no such column: ..." to stderr and exits
                // non-zero; a legitimate empty result prints "[]\n" to
                // stdout with empty stderr.
                if (errText) {
                    const lower = errText.toLowerCase();
                    if (lower.includes('database is locked') || lower.includes('database table is locked')) {
                        finish({ rows: [], errorCode: 'DATABASE_LOCKED' });
                        return;
                    }
                    if (lower.includes('no such column') || lower.includes('no such table')) {
                        _debug(`sqlite3 schema error ${dbPath}: ${errText}`);
                        finish({ rows: [], errorCode: 'SCHEMA_MISMATCH' });
                        return;
                    }
                    _debug(`sqlite3 stderr ${dbPath}: ${errText}`);
                    finish({ rows: [], errorCode: 'QUERY_FAILED' });
                    return;
                }
                if (!ok || !stdout) {
                    finish({ rows: [], errorCode: null });
                    return;
                }
                const parsed = JSON.parse(stdout.trim());
                if (!Array.isArray(parsed)) {
                    _debug(`sqlite3 returned non-array ${dbPath}: ${typeof parsed}`);
                    finish({ rows: [], errorCode: 'QUERY_FAILED' });
                    return;
                }
                finish({ rows: parsed, errorCode: null });
            } catch (e) {
                _debug(`sqlite3 result parse failed ${dbPath}: ${e.message}`);
                finish({ rows: [], errorCode: 'QUERY_FAILED' });
            }
        });
    });
}

function _parseSQLiteRow(agent, row) {
    if (agent === 'opencode' || agent === 'kilo') {
        try {
            const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
            if (!data) return null;
            const tokens = data.tokens || {};
            return {
                date: _extractDate(data.time?.created),
                model: data.modelID || data.providerID || agent,
                inputTokens: tokens.input || tokens.input_tokens || 0,
                outputTokens: tokens.output || tokens.output_tokens || 0,
                cacheCreationTokens: tokens.cache?.write || tokens.cache_write || 0,
                cacheReadTokens: tokens.cache?.read || tokens.cache_read || 0,
                costUSD: data.cost != null ? data.cost : null,
            };
        } catch {
            return null;
        }
    }

    if (agent === 'goose') {
        let model = 'goose';
        try {
            // The goose sessions table column is `model_config` (not
            // `model_config_json` — the SQL SELECTs `model_config` at the
            // query layer). Reading the wrong name left model stuck at the
            // generic 'goose' fallback for every row.
            const config = typeof row.model_config === 'string'
                ? JSON.parse(row.model_config) : row.model_config;
            model = config?.model_name || model;
        } catch { /* use default */ }

        return {
            date: _extractDate(row.created_at),
            model,
            inputTokens: row.accumulated_input_tokens || row.input_tokens || 0,
            outputTokens: row.accumulated_output_tokens || row.output_tokens || 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            costUSD: null,
        };
    }

    if (agent === 'hermes') {
        return {
            date: _extractDate(row.started_at),
            model: row.model || 'hermes',
            inputTokens: row.input_tokens || 0,
            outputTokens: row.output_tokens || 0,
            cacheCreationTokens: row.cache_write_tokens || 0,
            cacheReadTokens: row.cache_read_tokens || 0,
            costUSD: row.actual_cost_usd ?? row.estimated_cost_usd ?? null,
        };
    }

    if (agent === 'zcode') {
        const hasTokens = (row.input_tokens || 0) > 0 ||
            (row.output_tokens || 0) > 0 ||
            (row.cache_creation_input_tokens || 0) > 0 ||
            (row.cache_read_input_tokens || 0) > 0;
        return {
            date: _extractDate(row.started_at),
            model: row.model_id || 'zcode',
            inputTokens: row.input_tokens || 0,
            outputTokens: row.output_tokens || 0,
            cacheCreationTokens: row.cache_creation_input_tokens || 0,
            cacheReadTokens: row.cache_read_input_tokens || 0,
            costUSD: null,
            _usageSource: hasTokens ? 'database' : 'database-zero',
        };
    }

    return null;
}

// ZCode 3.x can complete model requests while persisting zero/empty usage in
// model_usage.  Its model-io rollout is the next-best local source: it keeps
// the exact outbound messages/tool schema and the observable response, but
// not the provider's token counts.  Estimate those payloads conservatively
// and mark the entry so callers never mistake it for billing-grade data.
export function parseZCodeRolloutLine(line) {
    try {
        const raw = JSON.parse(line);
        if (raw.type !== 'model_io' || !raw.requestId) return null;

        const request = raw.request || {};
        const response = raw.response || {};
        const inputPayload = {
            ...(request.body && typeof request.body === 'object' ? request.body : {}),
            messages: Array.isArray(request.messages) ? request.messages : [],
        };
        const outputPayload = {
            text: typeof response.text === 'string' ? response.text : '',
            toolCalls: Array.isArray(response.toolCalls) ? response.toolCalls : [],
        };

        return {
            date: _extractDate(raw.completedAt || raw.startedAt),
            model: raw.model?.modelId || response.modelId || 'zcode',
            inputTokens: _estimateZCodeTokens(inputPayload),
            outputTokens: _estimateZCodeTokens(outputPayload),
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            costUSD: null,
            _dedupeKey: `zcode-rollout:${raw.requestId}`,
            _usageSource: 'rollout-estimate',
        };
    } catch {
        return null;
    }
}

function _estimateZCodeTokens(value) {
    const text = JSON.stringify(value);
    if (!text || text === '{}' || text === '[]') return 0;
    // GLM's exact chat template/tokenizer is not shipped with ZCode.  Four
    // UTF-8 bytes per token is a deliberately simple, reproducible estimate
    // for the observed mixed source-code/English/Chinese payloads.  The UI
    // receives the source marker above so this can remain distinguishable
    // from exact provider/database usage.
    return Math.ceil(new TextEncoder().encode(text).length / 4);
}

// ═══════════════════════════════════════
// Utilities
// ═══════════════════════════════════════
function _pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const key of keys) {
        if (obj[key] != null) return obj[key];
    }
    return undefined;
}

function _extractDate(timestamp) {
    // No timestamp at all: return null so the caller can decide whether to
    // drop the entry or attribute it to a known date. Defaulting to "today"
    // silently inflates today's stats with historical entries that happen
    // to lack a timestamp field.
    if (!timestamp) return null;

    if (typeof timestamp === 'number') {
        const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
        return _formatLocalDate(new Date(ms));
    }

    if (Array.isArray(timestamp)) {
        const seconds = timestamp[0] || 0;
        const nanos = timestamp[1] || 0;
        return _formatLocalDate(new Date(seconds * 1000 + nanos / 1e6));
    }

    if (typeof timestamp === 'string') {
        // date-only ISO strings (e.g. "2024-01-01") are parsed by the spec
        // as UTC midnight. Using new Date() on them and then reading local
        // getFullYear/getDate shifts the date by a day in any timezone west
        // of UTC. Detect this form and construct a local date directly.
        const dateOnly = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (dateOnly) {
            return timestamp.slice(0, 10);
        }
        const parsed = new Date(timestamp);
        if (!Number.isNaN(parsed.getTime())) {
            return _formatLocalDate(parsed);
        }
        return timestamp.slice(0, 10);
    }

    return null;
}

function _formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
