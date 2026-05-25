import { CostCalculator, formatCost, formatTokens, calculateCacheHitRate } from './costCalculator.js';
import { getPricingForModel } from './pricingResolver.js';
import { AGENT_APP_TYPE_MAP, AGENT_DISPLAY_NAMES } from './defaultPricing.js';

export class DataProcessor {
    constructor(settings) {
        this._settings = settings;
    }

    processEntries(entries) {
        if (!entries || entries.length === 0) {
            return this._emptyResult();
        }

        const costMultiplier = this._settings.get_double('cost-multiplier');
        const overridesJson = this._settings.get_string('price-overrides');
        const currency = this._settings.get_string('cost-currency');
        const exchangeRate = this._settings.get_double('cny-exchange-rate');
        const tokenFormat = this._settings.get_string('token-display-format');
        const sortOrder = this._settings.get_string('sort-order');

        let totalRequests = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCacheCreationTokens = 0;
        let totalCacheReadTokens = 0;
        let totalCost = 0;
        let calculatedCost = 0;
        const modelStats = {};
        const dailyMap = {};

        const dateRange = this._settings.get_string('date-range-preset');
        const customSince = this._settings.get_string('custom-date-since');
        const customUntil = this._settings.get_string('custom-date-until');
        const dateFilter = this._buildDateFilter(dateRange, customSince, customUntil);

        for (const entry of entries) {
            if (!dateFilter(entry.date)) continue;

            const agent = entry._agent || 'claude';
            const appType = AGENT_APP_TYPE_MAP[agent] || agent;

            const pricing = getPricingForModel(entry.model, null, overridesJson);

            const usage = {
                inputTokens: entry.inputTokens || 0,
                outputTokens: entry.outputTokens || 0,
                cacheReadTokens: entry.cacheReadTokens || 0,
                cacheCreationTokens: entry.cacheCreationTokens || 0,
            };

            let entryCost = 0;
            if (pricing) {
                const cost = CostCalculator.calculateForApp(appType, usage, pricing, costMultiplier);
                entryCost = cost.totalCost;
            } else if (entry.costUSD != null) {
                entryCost = entry.costUSD * costMultiplier;
            }

            totalRequests += 1;
            totalInputTokens += usage.inputTokens;
            totalOutputTokens += usage.outputTokens;
            totalCacheCreationTokens += usage.cacheCreationTokens;
            totalCacheReadTokens += usage.cacheReadTokens;
            totalCost += entryCost;

            const modelKey = entry.model || 'unknown';
            const displayName = pricing ? (pricing.displayName || modelKey) : modelKey;
            const compositeKey = `${agent}:${modelKey}`;

            if (!modelStats[compositeKey]) {
                modelStats[compositeKey] = {
                    model: modelKey,
                    displayName,
                    agent,
                    agentName: AGENT_DISPLAY_NAMES[agent] || agent,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                    totalCost: 0,
                    requestCount: 0,
                };
            }
            modelStats[compositeKey].inputTokens += usage.inputTokens;
            modelStats[compositeKey].outputTokens += usage.outputTokens;
            modelStats[compositeKey].cacheReadTokens += usage.cacheReadTokens;
            modelStats[compositeKey].cacheCreationTokens += usage.cacheCreationTokens;
            modelStats[compositeKey].totalCost += entryCost;
            modelStats[compositeKey].requestCount += 1;

            if (!dailyMap[entry.date]) {
                dailyMap[entry.date] = {
                    date: entry.date,
                    inputTokens: 0, outputTokens: 0,
                    cacheCreationTokens: 0, cacheReadTokens: 0,
                    cost: 0, totalTokens: 0, requestCount: 0,
                };
            }
            dailyMap[entry.date].inputTokens += usage.inputTokens;
            dailyMap[entry.date].outputTokens += usage.outputTokens;
            dailyMap[entry.date].cacheCreationTokens += usage.cacheCreationTokens;
            dailyMap[entry.date].cacheReadTokens += usage.cacheReadTokens;
            dailyMap[entry.date].cost += entryCost;
            dailyMap[entry.date].totalTokens += usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
            dailyMap[entry.date].requestCount += 1;
        }

        const cacheHitRate = calculateCacheHitRate(
            totalInputTokens, totalCacheCreationTokens, totalCacheReadTokens
        );

        const modelList = Object.values(modelStats).sort((a, b) => b.totalCost - a.totalCost);
        const maxModelCost = modelList.length > 0 ? modelList[0].totalCost : 1;

        const dailyArr = Object.values(dailyMap);
        dailyArr.sort((a, b) => sortOrder === 'asc' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date));

        const totalRealTokens = totalInputTokens + totalOutputTokens + totalCacheCreationTokens + totalCacheReadTokens;

        return {
            totalRequests,
            totalTokens: totalInputTokens + totalOutputTokens,
            totalRealTokens,
            totalCost,
            totalCostFormatted: formatCost(totalCost, currency, exchangeRate),
            totalInputTokens,
            totalOutputTokens,
            totalCacheCreationTokens,
            totalCacheReadTokens,
            totalInputFormatted: formatTokens(totalInputTokens, tokenFormat),
            totalOutputFormatted: formatTokens(totalOutputTokens, tokenFormat),
            totalRealTokensFormatted: formatTokens(totalRealTokens, tokenFormat),
            cacheHitRate,
            cacheHitRateFormatted: `${(cacheHitRate * 100).toFixed(1)}%`,
            daily: dailyArr,
            modelStats: modelList.map(m => ({
                ...m,
                totalTokens: m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens,
                percentage: maxModelCost > 0 ? m.totalCost / maxModelCost : 0,
                totalCostFormatted: formatCost(m.totalCost, currency, exchangeRate),
                inputTokensFormatted: formatTokens(m.inputTokens, tokenFormat),
                outputTokensFormatted: formatTokens(m.outputTokens, tokenFormat),
                cacheReadTokensFormatted: formatTokens(m.cacheReadTokens, tokenFormat),
                cacheCreationTokensFormatted: formatTokens(m.cacheCreationTokens, tokenFormat),
            })),
            daysWithUsage: dailyArr.filter(d => d.totalTokens > 0).length,
            currency,
            exchangeRate,
        };
    }

    _buildDateFilter(preset, customSince, customUntil) {
        const today = new Date().toISOString().slice(0, 10);

        if (preset === 'today') {
            const todayStr = today;
            return (date) => date >= todayStr;
        }
        if (preset === '7d') {
            const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
            return (date) => date >= since;
        }
        if (preset === '30d') {
            const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
            return (date) => date >= since;
        }
        if (preset === 'custom' && (customSince || customUntil)) {
            const since = customSince || '';
            const until = customUntil || '';
            return (date) => {
                if (since && date < since) return false;
                if (until && date > until) return false;
                return true;
            };
        }
        return () => true;
    }

    _emptyResult() {
        const currency = this._settings ? this._settings.get_string('cost-currency') : 'CNY';
        const exchangeRate = this._settings ? this._settings.get_double('cny-exchange-rate') : 7.25;
        const tokenFormat = this._settings ? this._settings.get_string('token-display-format') : 'auto';

        return {
            totalRequests: 0,
            totalTokens: 0,
            totalRealTokens: 0,
            totalCost: 0,
            totalCostFormatted: formatCost(0, currency, exchangeRate),
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheCreationTokens: 0,
            totalCacheReadTokens: 0,
            totalInputFormatted: formatTokens(0, tokenFormat),
            totalOutputFormatted: formatTokens(0, tokenFormat),
            totalRealTokensFormatted: formatTokens(0, tokenFormat),
            cacheHitRate: 0,
            cacheHitRateFormatted: '0.0%',
            daily: [],
            modelStats: [],
            daysWithUsage: 0,
            currency,
            exchangeRate,
        };
    }
}