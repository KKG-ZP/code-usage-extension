import { CostCalculator, formatCost, formatTokens, calculateTokenAccountingForApp } from './costCalculator.js';
import { getPricingForModel } from './pricingResolver.js';
import { AGENT_APP_TYPE_MAP, AGENT_DISPLAY_NAMES } from './defaultPricing.js';

const HEATMAP_WEEK_COUNT = 16;

export class DataProcessor {
    constructor(settings) {
        this._settings = settings;
        this._heatmapCache = {
            entries: null,
            today: '',
            tokenFormat: '',
            heatmapWeeks: null,
        };
    }

    processEntries(entries) {
        const tokenFormat = this._settings.get_string('token-display-format');
        const today = _formatLocalDate(new Date());
        const heatmapWeeks = this._getTokenHeatmapWeeks(entries || [], tokenFormat, today);
        const costMultiplier = this._settings.get_double('cost-multiplier');
        const overridesJson = this._settings.get_string('price-overrides');
        const currency = this._settings.get_string('cost-currency');
        const exchangeRate = this._settings.get_double('cny-exchange-rate');
        const aliasMap = _parseAliasMap(this._settings.get_string('model-aliases'));

        if (!entries || entries.length === 0) {
            return this._emptyResult(heatmapWeeks);
        }

        const sortOrder = this._settings.get_string('sort-order');
        const modelSortBy = this._settings.get_string('model-sort-by');
        const statsMode = this._settings.get_string('stats-mode');

        let totalRequests = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCacheCreationTokens = 0;
        let totalCacheReadTokens = 0;
        let totalUsageTokens = 0;
        let totalCacheHitDenominator = 0;
        let totalCost = 0;
        let calculatedCost = 0;
        const modelStats = {};
        const dailyMap = {};

        const dateRange = this._settings.get_string('date-range-preset');
        const customSince = this._settings.get_string('custom-date-since');
        const customUntil = this._settings.get_string('custom-date-until');
        const dateFilter = this._buildDateFilter(dateRange, customSince, customUntil);

        for (const entry of entries) {
            // Entries without a parseable date (e.g. Kiro turns missing
            // timestamp fields) are dropped rather than mis-attributed.
            if (!entry.date) continue;
            if (!dateFilter(entry.date)) continue;

            const requestCount = _entryRequestCount(entry);

            const {
                agent,
                model: canonicalModel,
                pricing,
                usage,
                tokenAccounting,
                entryCost,
            } = this._entryMetrics(entry, { costMultiplier, overridesJson, exchangeRate, aliasMap });

            totalRequests += requestCount;
            totalInputTokens += usage.inputTokens;
            totalOutputTokens += usage.outputTokens;
            totalCacheCreationTokens += usage.cacheCreationTokens;
            totalCacheReadTokens += usage.cacheReadTokens;
            totalUsageTokens += tokenAccounting.totalTokens;
            totalCacheHitDenominator += tokenAccounting.cacheHitDenominator;
            totalCost += entryCost;

            const modelKey = canonicalModel || entry.model || 'unknown';
            const displayName = pricing ? (pricing.displayName || modelKey) : modelKey;
            // Grouping dimension is driven by stats-mode: 'model' merges across
            // agents (key = model), 'agent' merges across models (key = agent),
            // 'agent-model' keeps the existing composite (key = agent:model).
            const compositeKey = statsMode === 'model' ? modelKey
                : statsMode === 'agent' ? agent
                : `${agent}:${modelKey}`;

            if (!modelStats[compositeKey]) {
                const base = {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                    totalCost: 0,
                    totalTokens: 0,
                    cacheHitDenominator: 0,
                    requestCount: 0,
                };
                if (statsMode === 'agent') {
                    base.agent = agent;
                    base.agentName = AGENT_DISPLAY_NAMES[agent] || agent;
                    base.modelSet = new Set();
                } else if (statsMode === 'model') {
                    base.model = modelKey;
                    base.displayName = displayName;
                } else {
                    base.model = modelKey;
                    base.displayName = displayName;
                    base.agent = agent;
                    base.agentName = AGENT_DISPLAY_NAMES[agent] || agent;
                }
                modelStats[compositeKey] = base;
            }
            modelStats[compositeKey].inputTokens += usage.inputTokens;
            modelStats[compositeKey].outputTokens += usage.outputTokens;
            modelStats[compositeKey].cacheReadTokens += usage.cacheReadTokens;
            modelStats[compositeKey].cacheCreationTokens += usage.cacheCreationTokens;
            modelStats[compositeKey].totalCost += entryCost;
            modelStats[compositeKey].totalTokens += tokenAccounting.totalTokens;
            modelStats[compositeKey].cacheHitDenominator += tokenAccounting.cacheHitDenominator;
            modelStats[compositeKey].requestCount += requestCount;
            if (statsMode === 'agent') modelStats[compositeKey].modelSet.add(modelKey);

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
            dailyMap[entry.date].totalTokens += tokenAccounting.totalTokens;
            dailyMap[entry.date].requestCount += requestCount;
        }

        const cacheHitRate = totalCacheHitDenominator > 0
            ? totalCacheReadTokens / totalCacheHitDenominator
            : 0;

        for (const key of Object.keys(modelStats)) {
            const m = modelStats[key];
            m.cacheHitRate = m.cacheHitDenominator > 0 ? m.cacheReadTokens / m.cacheHitDenominator : 0;
        }

        const modelList = Object.values(modelStats).sort((a, b) => {
            if (modelSortBy === 'totalTokens') return b.totalTokens - a.totalTokens;
            if (modelSortBy === 'cacheHitRate') return b.cacheHitRate - a.cacheHitRate;
            if (modelSortBy === 'requestCount') return b.requestCount - a.requestCount;
            return b.totalCost - a.totalCost;
        });

        const dailyArr = Object.values(dailyMap);
        dailyArr.sort((a, b) => sortOrder === 'asc' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date));

        const totalRealTokens = totalUsageTokens;

        return {
            totalRequests,
            totalTokens: totalRealTokens,
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
            heatmapWeeks,
            modelStats: modelList.map(m => {
                const out = {
                    ...m,
                    totalTokens: m.totalTokens,
                    percentage: totalCost > 0 ? m.totalCost / totalCost : 0,
                    totalCostFormatted: formatCost(m.totalCost, currency, exchangeRate),
                    inputTokensFormatted: formatTokens(m.inputTokens, tokenFormat),
                    outputTokensFormatted: formatTokens(m.outputTokens, tokenFormat),
                    cacheReadTokensFormatted: formatTokens(m.cacheReadTokens, tokenFormat),
                    cacheCreationTokensFormatted: formatTokens(m.cacheCreationTokens, tokenFormat),
                    cacheHitRateFormatted: `${(m.cacheHitRate * 100).toFixed(1)}%`,
                    totalTokensFormatted: formatTokens(m.totalTokens, tokenFormat),
                };
                if (m.modelSet) {
                    out.modelCount = m.modelSet.size;
                    delete out.modelSet;
                }
                return out;
            }),
            daysWithUsage: dailyArr.filter(d => d.totalTokens > 0).length,
            currency,
            exchangeRate,
        };
    }

    _entryMetrics(entry, { costMultiplier, overridesJson, exchangeRate, aliasMap }) {
        const agent = entry._agent || 'claude';
        const appType = AGENT_APP_TYPE_MAP[agent] || agent;
        // Apply the user's alias→main-model map for STATISTICAL GROUPING.
        // canonicalModel drives the compositeKey so aliases merge into the
        // main model's card; pricing is also resolved on the canonical id so
        // displayName comes from the main model. entry.model itself is NOT
        // mutated — cacheManager.getMergedEntries returns cached references,
        // and rewriting them would pollute the read-only cache.
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
            // Re-injected from the daily archive: a precomputed final CNY
            // cost captured at snapshot time. Bypass the USD→CNY conversion
            // AND the cost multiplier so archived costs don't silently
            // re-value when the user later tweaks cny-exchange-rate /
            // cost-multiplier. Archived cost is shown as-recorded.
            const rawCost = Number(entry._finalCostCNY);
            if (Number.isFinite(rawCost) && rawCost > 0) {
                entryCost = rawCost;
            }
        } else if (entry.costUSD != null) {
            // Guard against string/NaN costUSD from parsers: a single
            // non-numeric value would poison every running total via
            // NaN propagation. Coerce and validate before accumulating.
            const rawCost = Number(entry.costUSD);
            if (Number.isFinite(rawCost) && rawCost > 0) {
                entryCost = rawCost * exchangeRate * costMultiplier;
            }
        } else if (pricing && hasUsageTokens) {
            const cost = CostCalculator.calculateForApp(appType, usage, pricing, costMultiplier, exchangeRate);
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

    /**
     * Compute a single entry's metrics using current settings, WITHOUT the
     * date-range filter that processEntries applies. Used by DailyArchive to
     * snapshot a past day's cost identically to how the panel computes it.
     */
    computeEntryMetrics(entry) {
        const costMultiplier = this._settings.get_double('cost-multiplier');
        const overridesJson = this._settings.get_string('price-overrides');
        const exchangeRate = this._settings.get_double('cny-exchange-rate');
        const aliasMap = _parseAliasMap(this._settings.get_string('model-aliases'));
        return this._entryMetrics(entry, { costMultiplier, overridesJson, exchangeRate, aliasMap });
    }

    _buildDateFilter(preset, customSince, customUntil) {
        const today = _formatLocalDate(new Date());

        if (preset === 'today') {
            const todayStr = today;
            return (date) => date === todayStr;
        }
        if (preset === '7d') {
            // Seven complete local calendar days: yesterday back to today - 7.
            const sinceDate = new Date();
            sinceDate.setDate(sinceDate.getDate() - 7);
            const since = _formatLocalDate(sinceDate);
            return (date) => date >= since && date < today;
        }
        if (preset === '30d') {
            // Thirty complete local calendar days: yesterday back to today - 30.
            const sinceDate = new Date();
            sinceDate.setDate(sinceDate.getDate() - 30);
            const since = _formatLocalDate(sinceDate);
            return (date) => date >= since && date < today;
        }
        if (preset === 'all') {
            return (date) => date < today;
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

    _getTokenHeatmapWeeks(entries, tokenFormat, today) {
        if (
            this._heatmapCache.entries === entries &&
            this._heatmapCache.today === today &&
            this._heatmapCache.tokenFormat === tokenFormat &&
            this._heatmapCache.heatmapWeeks
        ) {
            return this._heatmapCache.heatmapWeeks;
        }

        const todayDate = _parseLocalDate(today);
        const visibleStartDate = new Date(todayDate);
        visibleStartDate.setDate(todayDate.getDate() - todayDate.getDay() - (HEATMAP_WEEK_COUNT - 1) * 7);

        const rangeStart = _formatLocalDate(visibleStartDate);

        const dailyMap = {};
        for (const entry of entries) {
            if (!entry.date || entry.date < rangeStart || entry.date > today) continue;

            const agent = entry._agent || 'claude';
            const appType = AGENT_APP_TYPE_MAP[agent] || agent;
            const usage = {
                inputTokens: entry.inputTokens || 0,
                outputTokens: entry.outputTokens || 0,
                cacheReadTokens: entry.cacheReadTokens || 0,
                cacheCreationTokens: entry.cacheCreationTokens || 0,
            };
            const tokenAccounting = calculateTokenAccountingForApp(appType, usage);

            if (!dailyMap[entry.date]) {
                dailyMap[entry.date] = { totalTokens: 0, requestCount: 0 };
            }
            dailyMap[entry.date].totalTokens += tokenAccounting.totalTokens;
            dailyMap[entry.date].requestCount += _entryRequestCount(entry);
        }

        const heatmapWeeks = [];
        let maxTokens = 0;
        for (let week = 0; week < HEATMAP_WEEK_COUNT; week++) {
            const days = [];
            for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
                const date = new Date(visibleStartDate);
                date.setDate(visibleStartDate.getDate() + week * 7 + dayOfWeek);
                const dateKey = _formatLocalDate(date);
                const inRange = dateKey >= rangeStart && dateKey <= today;
                const stats = inRange ? (dailyMap[dateKey] || { totalTokens: 0, requestCount: 0 }) : { totalTokens: 0, requestCount: 0 };
                if (stats.totalTokens > maxTokens) maxTokens = stats.totalTokens;
                days.push({
                    date: dateKey,
                    inRange,
                    isFuture: dateKey > today,
                    totalTokens: stats.totalTokens,
                    requestCount: stats.requestCount,
                });
            }
            heatmapWeeks.push(days);
        }

        for (const week of heatmapWeeks) {
            for (const day of week) {
                day.totalTokensFormatted = formatTokens(day.totalTokens, tokenFormat);
                day.level = day.inRange ? _tokenHeatLevel(day.totalTokens, maxTokens) : -1;
            }
        }

        this._heatmapCache = {
            entries,
            today,
            tokenFormat,
            heatmapWeeks,
        };
        return heatmapWeeks;
    }

    _emptyResult(heatmapWeeks = null) {
        const currency = this._settings ? this._settings.get_string('cost-currency') : 'CNY';
        const exchangeRate = this._settings ? this._settings.get_double('cny-exchange-rate') : 7.25;
        const tokenFormat = this._settings ? this._settings.get_string('token-display-format') : 'auto';
        const weeks = heatmapWeeks || this._getTokenHeatmapWeeks([], tokenFormat, _formatLocalDate(new Date()));

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
            heatmapWeeks: weeks,
            modelStats: [],
            daysWithUsage: 0,
            currency,
            exchangeRate,
        };
    }
}

export function _parseLocalDate(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
}

function _tokenHeatLevel(tokens, maxTokens) {
    if (tokens <= 0 || maxTokens <= 0) return 0;
    const ratio = tokens / maxTokens;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
}

function _entryRequestCount(entry) {
    const count = Number(entry.requestCount);
    return Number.isFinite(count) && count > 0 ? count : 1;
}

export function _formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Parse the user's model-aliases GSetting ({ "alias": "mainModelId" }) into a
 * plain object. Malformed/empty input falls back to {} so a bad value never
 * breaks aggregation — same defensive idiom as price-overrides parsing.
 */
function _parseAliasMap(raw) {
    try {
        const parsed = JSON.parse(raw || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed;
    } catch (_e) {
        return {};
    }
}
