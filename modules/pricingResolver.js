// Ported from cc-switch pricing resolution logic
// Multi-step model matching: exact -> alias -> namespace strip -> suffix strip -> prefix -> fallback

import { DEFAULT_PRICING, MODEL_PRICING_ALIASES } from './defaultPricing.js';

const NAMESPACE_PREFIXES = [
    'openai', 'anthropic', 'bedrock', 'vertex', 'google', 'gitcorp', 'azure',
    'openrouter', 'xai', 'x-ai', 'deepseek', 'moonshotai', 'moonshot', 'zai',
    'qwen', 'dashscope', 'mistral', 'cohere', 'minimax', 'volcengine', 'doubao',
];

const REGION_PROVIDER_PREFIX_PATTERN = /^(?:us|eu|global|apac)\.(?:anthropic|openai|google|meta|mistral|cohere|xai|x-ai)\./;
const MODEL_PATH_PATTERN = /(?:^|\/)models\/([^/]+)$/;
const DATE_SUFFIX_PATTERNS = [
    /-\d{8}$/,
    /-\d{4}-\d{2}-\d{2}$/,
    /-\d{2}-\d{2}$/,
    /-\d{6}$/,
    /-\d{4}$/,
];
const TRIM_SUFFIXES = [
    '.latest', '-latest', '-stable', '-beta', '-alpha', '-experimental', '-exp',
    '-preview', '-thinking', '-reasoning', '-non-reasoning', '-instruct',
    '-online', '-search', '-turbo',
];
const REASONING_SUFFIXES = ['-low', '-medium', '-high', '-xhigh', '-minimal'];

function _normalizeRawModelId(modelId) {
    return String(modelId)
        .trim()
        .toLowerCase()
        .replace(/^['"]|['"]$/g, '')
        .replace(/\s+/g, '-')
        .replace(/_/g, '-');
}

function _lookupPricing(allPricing, candidate) {
    if (!candidate) return null;
    if (allPricing[candidate]) return allPricing[candidate];

    const alias = MODEL_PRICING_ALIASES[candidate];
    if (alias && allPricing[alias]) return allPricing[alias];

    return null;
}

function _enqueueCandidate(queue, seen, value) {
    if (!value || typeof value !== 'string') return;
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/^['"]|['"]$/g, '')
        .replace(/\s+/g, '-')
        .replace(/_/g, '-')
        .replace(/^\/+|\/+$/g, '');

    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    queue.push(normalized);
}

function _expandCandidate(queue, seen, value) {
    const modelPathMatch = value.match(MODEL_PATH_PATTERN);
    if (modelPathMatch) _enqueueCandidate(queue, seen, modelPathMatch[1]);

    if (value.startsWith('models/')) {
        _enqueueCandidate(queue, seen, value.slice('models/'.length));
    }

    const publisherModels = value.match(/publishers\/[^/]+\/models\/([^/]+)$/);
    if (publisherModels) _enqueueCandidate(queue, seen, publisherModels[1]);

    const deploymentModels = value.match(/deployments\/([^/]+)$/);
    if (deploymentModels) _enqueueCandidate(queue, seen, deploymentModels[1]);

    for (const prefix of NAMESPACE_PREFIXES) {
        for (const separator of ['.', '/', ':']) {
            const namespaced = `${prefix}${separator}`;
            if (value.startsWith(namespaced)) {
                _enqueueCandidate(queue, seen, value.slice(namespaced.length));
            }
        }
    }

    const regionProvider = value.replace(REGION_PROVIDER_PREFIX_PATTERN, '');
    if (regionProvider !== value) _enqueueCandidate(queue, seen, regionProvider);

    if (value.includes('/')) {
        const parts = value.split('/').filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
            _enqueueCandidate(queue, seen, parts.slice(i).join('/'));
        }
        _enqueueCandidate(queue, seen, parts[parts.length - 1]);
    }

    if (value.includes(':')) {
        const parts = value.split(':').filter(Boolean);
        _enqueueCandidate(queue, seen, parts[parts.length - 1]);
        _enqueueCandidate(queue, seen, parts[0]);
    }

    const atIndex = value.indexOf('@');
    if (atIndex > 0) _enqueueCandidate(queue, seen, value.slice(0, atIndex));

    for (const suffix of [...REASONING_SUFFIXES, ...TRIM_SUFFIXES]) {
        if (value.endsWith(suffix)) {
            _enqueueCandidate(queue, seen, value.slice(0, -suffix.length));
        }
    }

    for (const pattern of DATE_SUFFIX_PATTERNS) {
        const stripped = value.replace(pattern, '');
        if (stripped !== value) _enqueueCandidate(queue, seen, stripped);
    }
}

function _buildModelCandidates(modelId) {
    const queue = [];
    const seen = new Set();
    _enqueueCandidate(queue, seen, _normalizeRawModelId(modelId));

    for (let i = 0; i < queue.length && i < 300; i++) {
        _expandCandidate(queue, seen, queue[i]);
    }

    return queue;
}

function _prefixMatch(allPricing, candidates) {
    const keys = Object.keys(allPricing);

    for (const candidate of candidates) {
        const segments = candidate.split('-').filter(Boolean);
        const prefixes = [];
        for (let size = Math.min(segments.length, 5); size >= 2; size--) {
            prefixes.push(segments.slice(0, size).join('-'));
        }

        for (const prefix of prefixes) {
            const matches = keys
                .filter(key => key.startsWith(prefix) && key.length > prefix.length)
                .sort((a, b) => a.length - b.length || a.localeCompare(b));
            if (matches.length > 0) return allPricing[matches[0]];
        }
    }

    return null;
}

export function resolvePricing(modelId, requestModel = null, overrides = {}) {
    if (!modelId) return null;

    const allPricing = { ...DEFAULT_PRICING, ...overrides };
    const candidates = _buildModelCandidates(modelId);

    for (const candidate of candidates) {
        const pricing = _lookupPricing(allPricing, candidate);
        if (pricing) return pricing;
    }

    const prefixPricing = _prefixMatch(allPricing, candidates);
    if (prefixPricing) return prefixPricing;

    if (requestModel && requestModel !== modelId) {
        return resolvePricing(requestModel, null, overrides);
    }

    return null;
}

export function getPricingForModel(modelId, requestModel = null, overridesJson = '{}') {
    // Pricing resolution is pure (same modelId + overrides always yields the
    // same result) but expensive: each call normalises the id, BFS-expands up
    // to 300 candidates, and prefix-matches against 90+ keys. With thousands
    // of entries per refresh but only a handful of distinct models, a Map
    // keyed on (modelId|overridesJson) collapses N calls into a few.
    const cacheKey = `${modelId}\0${overridesJson}`;
    if (_pricingCache.has(cacheKey)) {
        return _pricingCache.get(cacheKey);
    }

    let overrides = {};
    try {
        overrides = JSON.parse(overridesJson);
    } catch (e) {
        // ignore parse errors
    }

    const pricing = resolvePricing(modelId, requestModel, overrides);
    let result = null;
    if (pricing) {
        result = {
            displayName: pricing.displayName,
            currency: pricing.currency || 'USD',
            input: pricing.input ?? pricing.inputCostPerMillion ?? 0,
            output: pricing.output ?? pricing.outputCostPerMillion ?? 0,
            cacheRead: pricing.cacheRead ?? pricing.cacheReadCostPerMillion ?? 0,
            cacheWrite: pricing.cacheWrite ?? pricing.cacheCreationCostPerMillion ?? pricing.cacheWriteCostPerMillion ?? 0,
        };
    }

    // Cap the cache to avoid unbounded growth if an adversary feeds thousands
    // of distinct model ids; in practice the set is tiny (a dozen or so).
    if (_pricingCache.size > 512) _pricingCache.clear();
    _pricingCache.set(cacheKey, result);
    return result;
}

const _pricingCache = new Map();
