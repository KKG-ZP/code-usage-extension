// Ported from cc-switch src-tauri/src/proxy/usage/calculator.rs
// Cost calculation with cache semantics handling. Totals are calculated in CNY.

import { CACHE_INCLUSIVE_APP_TYPES } from './defaultPricing.js';

const MILLION = 1_000_000;
const DEFAULT_EXCHANGE_RATE = 7.25;

function _safeExchangeRate(exchangeRate) {
    return exchangeRate > 0 ? exchangeRate : DEFAULT_EXCHANGE_RATE;
}

function _pricingInCny(pricing, exchangeRate) {
    if ((pricing.currency || 'USD') === 'CNY') return pricing;

    const rate = _safeExchangeRate(exchangeRate);
    return {
        ...pricing,
        input: pricing.input * rate,
        output: pricing.output * rate,
        cacheRead: pricing.cacheRead * rate,
        cacheWrite: pricing.cacheWrite * rate,
        currency: 'CNY',
    };
}

export class CostCalculator {
    static calculate(usage, pricing, exchangeRate = DEFAULT_EXCHANGE_RATE) {
        return CostCalculator.calculateWithCacheSemantics(
            usage, pricing, false, exchangeRate
        );
    }

    static calculateForApp(appType, usage, pricing, exchangeRate = DEFAULT_EXCHANGE_RATE) {
        const inputIncludesCacheRead = CACHE_INCLUSIVE_APP_TYPES.has(appType);
        return CostCalculator.calculateWithCacheSemantics(
            usage, pricing, inputIncludesCacheRead, exchangeRate
        );
    }

    static calculateWithCacheSemantics(usage, pricing, inputIncludesCacheRead, exchangeRate = DEFAULT_EXCHANGE_RATE) {
        const cnyPricing = _pricingInCny(pricing, exchangeRate);
        let billableInputTokens = usage.inputTokens;
        if (inputIncludesCacheRead) {
            billableInputTokens = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
        }

        const inputCost = billableInputTokens * cnyPricing.input / MILLION;
        const outputCost = usage.outputTokens * cnyPricing.output / MILLION;
        const cacheReadCost = usage.cacheReadTokens * cnyPricing.cacheRead / MILLION;
        const cacheWriteCost = usage.cacheCreationTokens * cnyPricing.cacheWrite / MILLION;

        const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;

        return {
            inputCost,
            outputCost,
            cacheReadCost,
            cacheWriteCost,
            baseTotal: totalCost,
            totalCost,
        };
    }

    static tryCalculateForApp(appType, usage, pricing, exchangeRate = DEFAULT_EXCHANGE_RATE) {
        if (!pricing) return null;
        return CostCalculator.calculateForApp(appType, usage, pricing, exchangeRate);
    }
}

export function formatCost(costCNY, currency = 'CNY', exchangeRate = DEFAULT_EXCHANGE_RATE) {
    if (currency === 'USD') {
        const usd = costCNY / _safeExchangeRate(exchangeRate);
        if (usd < 0.01) return '$0.00';
        if (usd >= 1000) return '$' + usd.toFixed(0);
        if (usd >= 100) return '$' + usd.toFixed(1);
        return '$' + usd.toFixed(2);
    }

    if (costCNY < 0.01) return '¥0.00';
    if (costCNY >= 1000) return '¥' + costCNY.toFixed(0);
    if (costCNY >= 100) return '¥' + costCNY.toFixed(1);
    return '¥' + costCNY.toFixed(2);
}

export function formatTokens(tokens, format = 'auto') {
    if (format === 'raw') return tokens.toLocaleString();
    if (format === 'K') return (tokens / 1_000).toFixed(1) + 'K';
    if (format === 'M') return (tokens / 1_000_000).toFixed(1) + 'M';
    if (format === 'B') return (tokens / 1_000_000_000).toFixed(1) + 'B';
    if (tokens >= 1_000_000_000) return (tokens / 1_000_000_000).toFixed(1) + 'B';
    if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + 'M';
    if (tokens >= 1_000) return (tokens / 1_000).toFixed(1) + 'K';
    return tokens.toLocaleString();
}

export function calculateCacheHitRate(inputTokens, cacheCreationTokens, cacheReadTokens, inputIncludesCacheRead = false) {
    const denominator = inputIncludesCacheRead
        ? inputTokens + cacheCreationTokens
        : inputTokens + cacheCreationTokens + cacheReadTokens;
    if (denominator === 0) return 0;
    return cacheReadTokens / denominator;
}

export function calculateTokenAccountingForApp(appType, usage) {
    const inputTokens = usage.inputTokens || 0;
    const outputTokens = usage.outputTokens || 0;
    const cacheCreationTokens = usage.cacheCreationTokens || 0;
    const cacheReadTokens = usage.cacheReadTokens || 0;
    const inputIncludesCacheRead = CACHE_INCLUSIVE_APP_TYPES.has(appType);

    const promptInputTokens = inputIncludesCacheRead
        ? inputTokens + cacheCreationTokens
        : inputTokens + cacheCreationTokens + cacheReadTokens;

    return {
        promptInputTokens,
        totalTokens: promptInputTokens + outputTokens,
        cacheHitDenominator: promptInputTokens,
        cacheHitRate: promptInputTokens > 0 ? cacheReadTokens / promptInputTokens : 0,
    };
}
