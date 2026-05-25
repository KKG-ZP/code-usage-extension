// Parsers for all supported agent log formats
// Each parser returns: { date, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, costUSD }

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

let _sqlite3Path = null;
let _sqlite3Checked = false;

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

export function parseCodexLine(line, filePath) {
    try {
        const raw = JSON.parse(line);

        if (raw.type === 'session_meta') {
            const model = raw.payload?.model_provider || raw.payload?.model || raw.payload?.cli_version;
            if (model) _codexSessionModels.set(filePath, model);
            return null;
        }

        if (raw.payload?.type === 'turn_context') return null;

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

        if (typeof timestamp === 'number') {
            timestamp = new Date(timestamp).toISOString();
        }

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
export function parseKimiLine(line, filePath) {
    try {
        const raw = JSON.parse(line);
        if (!raw.message || raw.message.type !== 'StatusUpdate') return null;
        const payload = raw.message.payload;
        if (!payload?.token_usage) return null;

        const tu = payload.token_usage;
        return {
            date: _extractDate(raw.timestamp),
            model: 'kimi',
            inputTokens: (tu.input_other || 0) + (tu.input_cache_read || 0) + (tu.input_cache_creation || 0),
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
// SQLite agents (OpenCode, Goose, Hermes, Kilo)
// ═══════════════════════════════════════
export async function parseSQLiteAgent(agent, dbPath, config) {
    return new Promise((resolve) => {
        try {
            const sqlite3 = _findSqlite3();
            if (!sqlite3) {
                resolve([]);
                return;
            }

            let sql;

            if (agent === 'opencode' || agent === 'kilo') {
                sql = "SELECT data FROM message WHERE json_extract(data, '$.role') = 'assistant'";
            } else if (agent === 'goose') {
                sql = 'SELECT id, model_config_json, provider_name, created_at, accumulated_input_tokens, accumulated_output_tickets, total_tokens FROM sessions';
            } else if (agent === 'hermes') {
                sql = 'SELECT id, model, started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, actual_cost_usd FROM sessions';
            } else {
                resolve([]);
                return;
            }

            const argv = [sqlite3, '-json', dbPath, sql];

            const subprocess = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            subprocess.communicate_utf8_async(null, null, (proc, result) => {
                try {
                    const [ok, stdout, stderr] = proc.communicate_utf8_finish(result);
                    if (!ok || !stdout) { resolve([]); return; }

                    const rows = JSON.parse(stdout.trim());
                    const entries = [];

                    for (const row of rows) {
                        const entry = _parseSQLiteRow(agent, row);
                        if (entry) entries.push(entry);
                    }

                    resolve(entries);
                } catch (e) {
                    resolve([]);
                }
            });
        } catch (e) {
            resolve([]);
        }
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
            const config = typeof row.model_config_json === 'string'
                ? JSON.parse(row.model_config_json) : row.model_config_json;
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

    return null;
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
    if (!timestamp) return new Date().toISOString().slice(0, 10);

    if (typeof timestamp === 'number') {
        const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
        return new Date(ms).toISOString().slice(0, 10);
    }

    if (Array.isArray(timestamp)) {
        const seconds = timestamp[0] || 0;
        const nanos = timestamp[1] || 0;
        return new Date(seconds * 1000 + nanos / 1e6).toISOString().slice(0, 10);
    }

    if (typeof timestamp === 'string') {
        try {
            return new Date(timestamp).toISOString().slice(0, 10);
        } catch {
            return timestamp.slice(0, 10);
        }
    }

    return new Date().toISOString().slice(0, 10);
}