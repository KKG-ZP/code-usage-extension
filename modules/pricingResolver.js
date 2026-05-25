// Ported from cc-switch pricing resolution logic
// Multi-step model matching: exact → namespace strip → date strip → reasoning strip → prefix → fallback

import { DEFAULT_PRICING } from './defaultPricing.js';

const NAMESPACE_PREFIXES = ['openai', 'anthropic', 'bedrock', 'vertex', 'gitcorp', 'azure'];
const DATE_SUFFIX_PATTERN = /-\d{8}$/;
const REASONING_SUFFIXES = ['-low', '-medium', '-high', '-xhigh', '-minimal'];

export function resolvePricing(modelId, requestModel = null, overrides = {}) {
    if (!modelId) return null;

    const allPricing = { ...DEFAULT_PRICING, ...overrides };

    // Step 1: Exact match
    if (allPricing[modelId]) {
        return allPricing[modelId];
    }

    // Step 2: Remove namespace prefix
    let stripped = modelId;
    for (const prefix of NAMESPACE_PREFIXES) {
        if (stripped.startsWith(`${prefix}.`)) {
            stripped = stripped.slice(prefix.length + 1);
            break;
        }
    }
    if (allPricing[stripped]) {
        return allPricing[stripped];
    }

    // Step 3: Remove date suffix
    const noDate = stripped.replace(DATE_SUFFIX_PATTERN, '');
    if (noDate !== stripped && allPricing[noDate]) {
        return allPricing[noDate];
    }

    // Step 4: Remove reasoning effort suffix
    let noReasoning = noDate;
    for (const suffix of REASONING_SUFFIXES) {
        if (noReasoning.endsWith(suffix)) {
            noReasoning = noReasoning.slice(0, -suffix.length);
            break;
        }
    }
    if (noReasoning !== noDate && allPricing[noReasoning]) {
        return allPricing[noReasoning];
    }

    // Step 5: Prefix match (first 3 segments)
    const prefixKey = noReasoning.split('-').slice(0, 3).join('-');
    if (prefixKey && prefixKey.length < noReasoning.length) {
        for (const key of Object.keys(allPricing)) {
            if (key.startsWith(prefixKey)) {
                return allPricing[key];
            }
        }
    }

    // Step 6: Fallback to request model
    if (requestModel && requestModel !== modelId) {
        return resolvePricing(requestModel, null, overrides);
    }

    return null;
}

export function getPricingForModel(modelId, requestModel = null, overridesJson = '{}') {
    let overrides = {};
    try {
        overrides = JSON.parse(overridesJson);
    } catch (e) {
        // ignore parse errors
    }

    const pricing = resolvePricing(modelId, requestModel, overrides);
    if (!pricing) return null;

    return {
        input: pricing.input ?? pricing.inputCostPerMillion ?? 0,
        output: pricing.output ?? pricing.outputCostPerMillion ?? 0,
        cacheRead: pricing.cacheRead ?? pricing.cacheReadCostPerMillion ?? 0,
        cacheWrite: pricing.cacheWrite ?? pricing.cacheCreationCostPerMillion ?? pricing.cacheWriteCostPerMillion ?? 0,
    };
}