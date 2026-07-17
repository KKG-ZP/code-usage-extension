// Per-entry metric + cost computation, shared between the Shell's
// DataProcessor and the standalone worker. Extracted so the worker can
// compute the same locked-in CNY cost a snapshot would have captured,
// without pulling in the Shell-only DataProcessor (which depends on GSettings
// for display formatting).
//
// The cost computed here is the *raw* cost in CNY using the caller-supplied
// exchange rate, price overrides, and alias map. Snapshots
// store this value so later exchange rate tweaks don't re-value past days.

import { CostCalculator, calculateTokenAccountingForApp } from './costCalculator.js';
import { getPricingForModel } from './pricingResolver.js';
import { AGENT_APP_TYPE_MAP } from './defaultPricing.js';

const BRAND_WORDS = {
    'deepseek': 'DeepSeek',
    'glm': 'GLM',
    'kimi': 'Kimi',
    'gpt': 'GPT',
    'claude': 'Claude',
    'gemini': 'Gemini',
    'qwen': 'Qwen',
    'copilot': 'Copilot',
    'codex': 'Codex',
    'kiro': 'Kiro',
    'openclaw': 'OpenClaw',
    'hermes': 'Hermes',
    'goose': 'Goose',
    'zcode': 'ZCode',
    'codepilot': 'CodePilot',
    'codebuff': 'CodeBuff',
    'amp': 'Amp',
    'pro': 'Pro',
    'sol': 'Sol',
    'mini': 'Mini',
    'max': 'Max',
    'ultra': 'Ultra',
    'lite': 'Lite',
    'plus': 'Plus',
    'turbo': 'Turbo',
    'flash': 'Flash',
    'think': 'Think',
    'vision': 'Vision',
    'preview': 'Preview',
    'opus': 'Opus',
    'sonnet': 'Sonnet',
    'haiku': 'Haiku',
    'nano': 'Nano',
};

export function formatModelDisplayName(rawName) {
    if (!rawName || typeof rawName !== 'string') return rawName || '';
    return rawName.split('-').map(part => {
        const lower = part.toLowerCase();
        const known = BRAND_WORDS[lower];
        if (known) return known;
        return part.charAt(0).toUpperCase() + part.slice(1);
    }).join(' ');
}

export const FORMATTED_BRAND_WORDS = BRAND_WORDS;

/**
 * Coerce an entry's requestCount to a positive integer, defaulting to 1
 * when missing/invalid. A single API call is the unit of "a request" when
 * the parser didn't record an explicit count.
 */
export function entryRequestCount(entry) {
    const count = Number(entry.requestCount);
    return Number.isFinite(count) && count > 0 ? count : 1;
}

/**
 * Parse a model-aliases JSON string (`{ "alias": "mainModelId" }`) into a
 * plain object. Malformed/empty input falls back to {} so a bad GSetting
 * value never breaks aggregation.
 */
export function parseAliasMap(raw) {
    try {
        const parsed = JSON.parse(raw || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed;
    } catch (_e) {
        return {};
    }
}

/**
 * Compute a single entry's metrics using the supplied settings values.
 * Returns { agent, appType, model (canonical), pricing, usage,
 * tokenAccounting, entryCost }.
 *
 * `entry._agent` is the authoritative agent; falls back to 'claude' for
 * legacy entries. The canonical model is derived via the user's alias map
 * (for statistical grouping) but entry.model itself is NOT mutated — the
 * caller (cache/worker) treats entries as read-only references.
 *
 * Cost resolution order:
 *   1. entry._finalCostCNY (re-injected from an archive snapshot) — bypass
 *      USD→CNY so archived costs aren't silently
 *      re-valued when the user later tweaks the exchange rate.
 *   2. entry.costUSD (parser-provided) — multiply by exchangeRate.
 *   3. pricing table — full CostCalculator path.
 */
export function computeEntryMetrics(entry, { overridesJson, exchangeRate, aliasMap }) {
    const agent = entry._agent || 'claude';
    const appType = AGENT_APP_TYPE_MAP[agent] || agent;
    const canonicalModel = (aliasMap && aliasMap[entry.model]) || entry.model;
    const pricing = getPricingForModel(canonicalModel, null, overridesJson);
    const usage = {
        inputTokens: entry.inputTokens || 0,
        outputTokens: entry.outputTokens || 0,
        cacheReadTokens: entry.cacheReadTokens || 0,
        cacheCreationTokens: entry.cacheCreationTokens || 0,
    };
    const tokenAccounting = calculateTokenAccountingForApp(appType, usage);
    const hasUsageTokens = usage.inputTokens > 0
        || usage.outputTokens > 0
        || usage.cacheReadTokens > 0
        || usage.cacheCreationTokens > 0;

    let entryCost = 0;
    if (entry._finalCostCNY != null) {
        const rawCost = Number(entry._finalCostCNY);
        if (Number.isFinite(rawCost) && rawCost > 0) {
            entryCost = rawCost;
        }
    } else if (entry.costUSD != null) {
        const rawCost = Number(entry.costUSD);
        if (Number.isFinite(rawCost) && rawCost > 0) {
            entryCost = rawCost * exchangeRate;
        }
    } else if (pricing && hasUsageTokens) {
        const cost = CostCalculator.calculateForApp(appType, usage, pricing, exchangeRate);
        entryCost = cost.totalCost;
    }

    return {
        agent,
        appType,
        model: canonicalModel,
        pricing,
        usage,
        tokenAccounting,
        entryCost,
    };
}