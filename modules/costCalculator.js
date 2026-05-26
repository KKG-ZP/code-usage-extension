// Ported from cc-switch src-tauri/src/proxy/usage/calculator.rs
// Cost calculation with cache semantics handling

const DefaultPricing = imports.misc.extensionUtils.getCurrentExtension().imports.modules.defaultPricing;
const CACHE_INCLUSIVE_APP_TYPES = DefaultPricing.CACHE_INCLUSIVE_APP_TYPES;

const MILLION = 1000000;

var CostCalculator = class CostCalculator {
    static calculate(usage, pricing, costMultiplier = 1.0) {
        return CostCalculator.calculateWithCacheSemantics(
            usage, pricing, costMultiplier, false
        );
    }

    static calculateForApp(appType, usage, pricing, costMultiplier = 1.0) {
        const inputIncludesCacheRead = CACHE_INCLUSIVE_APP_TYPES.has(appType);
        return CostCalculator.calculateWithCacheSemantics(
            usage, pricing, costMultiplier, inputIncludesCacheRead
        );
    }

    static calculateWithCacheSemantics(usage, pricing, costMultiplier, inputIncludesCacheRead) {
        let billableInputTokens = usage.inputTokens;
        if (inputIncludesCacheRead) {
            billableInputTokens = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
        }

        const inputCost = billableInputTokens * pricing.input / MILLION;
        const outputCost = usage.outputTokens * pricing.output / MILLION;
        const cacheReadCost = usage.cacheReadTokens * pricing.cacheRead / MILLION;
        const cacheWriteCost = usage.cacheCreationTokens * pricing.cacheWrite / MILLION;

        const baseTotal = inputCost + outputCost + cacheReadCost + cacheWriteCost;
        const totalCost = baseTotal * costMultiplier;

        return {
            inputCost,
            outputCost,
            cacheReadCost,
            cacheWriteCost,
            baseTotal,
            totalCost,
        };
    }

    static tryCalculateForApp(appType, usage, pricing, costMultiplier = 1.0) {
        if (!pricing) return null;
        return CostCalculator.calculateForApp(appType, usage, pricing, costMultiplier);
    }
}

function formatCost(costUSD, currency = 'USD', exchangeRate = 7.25) {
    if (currency === 'CNY') {
        const cny = costUSD * exchangeRate;
        if (cny < 0.01) return '¥0.00';
        if (cny >= 1000) return `¥${cny.toFixed(0)}`;
        if (cny >= 100) return `¥${cny.toFixed(1)}`;
        return `¥${cny.toFixed(2)}`;
    }
    if (costUSD < 0.01) return '$0.00';
    if (costUSD >= 1000) return `$${costUSD.toFixed(0)}`;
    if (costUSD >= 100) return `$${costUSD.toFixed(1)}`;
    return `$${costUSD.toFixed(2)}`;
}

function formatTokens(tokens, format = 'auto') {
    if (format === 'raw') return tokens.toLocaleString();
    if (format === 'K') return `${(tokens / 1000).toFixed(1)}K`;
    if (format === 'M') return `${(tokens / 1000000).toFixed(1)}M`;
    if (format === 'B') return `${(tokens / 1000000000).toFixed(1)}B`;
    if (tokens >= 1000000000) return `${(tokens / 1000000000).toFixed(1)}B`;
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
    return tokens.toLocaleString();
}

function calculateCacheHitRate(inputTokens, cacheCreationTokens, cacheReadTokens) {
    const denominator = inputTokens + cacheCreationTokens + cacheReadTokens;
    if (denominator === 0) return 0;
    return cacheReadTokens / denominator;
}