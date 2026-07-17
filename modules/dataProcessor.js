import { CostCalculator, formatCost, formatTokens, calculateTokenAccountingForApp } from './costCalculator.js';
import { AGENT_APP_TYPE_MAP, AGENT_DISPLAY_NAMES } from './defaultPricing.js';
import {
    computeEntryMetrics,
    entryRequestCount as _entryRequestCount,
    parseAliasMap as _parseAliasMap,
} from './entryMetrics.js';

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

    _entryMetrics(entry, ctx) {
        return computeEntryMetrics(entry, ctx);
    }

    /**
     * Stage 4: consume the snapshot's pre-aggregated dailyUsage rows
     * directly, bypassing the per-entry cost/token loop in processEntries.
     * The rows are already aggregated by (date, agent, raw_model) with a
     * locked-in CNY cost, so we only apply: date-range filter, stats-mode
     * grouping, and alias-based display merging. Output shape matches
     * processEntries so the panel/UI code is unchanged.
     */
    processAggregatedRows(rows) {
        const tokenFormat = this._settings.get_string('token-display-format');
        const today = _formatLocalDate(new Date());
        const heatmapWeeks = this._getHeatmapFromRows(rows || [], tokenFormat, today);
        const currency = this._settings.get_string('cost-currency');
        const exchangeRate = this._settings.get_double('cny-exchange-rate');
        const aliasMap = _parseAliasMap(this._settings.get_string('model-aliases'));

        if (!rows || rows.length === 0) {
            return this._emptyResult(heatmapWeeks);
        }

        const sortOrder = this._settings.get_string('sort-order');
        const modelSortBy = this._settings.get_string('model-sort-by');
        const statsMode = this._settings.get_string('stats-mode');
        const dateRange = this._settings.get_string('date-range-preset');
        const customSince = this._settings.get_string('custom-date-since');
        const customUntil = this._settings.get_string('custom-date-until');
        const dateFilter = this._buildDateFilter(dateRange, customSince, customUntil);

        let totalRequests = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCacheCreationTokens = 0;
        let totalCacheReadTokens = 0;
        let totalUsageTokens = 0;
        let totalCacheHitDenominator = 0;
        let totalCost = 0;
        let hasEstimatedUsage = false;
        const modelStats = {};
        const dailyMap = {};

        for (const row of rows) {
            if (!row.date || !dateFilter(row.date)) continue;
            const agent = row.agent || 'claude';
            const appType = AGENT_APP_TYPE_MAP[agent] || agent;
            const usage = {
                inputTokens: row.inputTokens || 0,
                outputTokens: row.outputTokens || 0,
                cacheReadTokens: row.cacheReadTokens || 0,
                cacheCreationTokens: row.cacheCreationTokens || 0,
            };
            const tokenAccounting = calculateTokenAccountingForApp(appType, usage);
            const requests = Number(row.requestCount) || 1;
            // cost is already locked-in CNY from the worker; use as-is.
            const rowCost = Number(row.cost) || 0;
            const isEstimated = row.estimated === true || row.usageSource === 'rollout-estimate';
            hasEstimatedUsage ||= isEstimated;

            totalRequests += requests;
            totalInputTokens += usage.inputTokens;
            totalOutputTokens += usage.outputTokens;
            totalCacheCreationTokens += usage.cacheCreationTokens;
            totalCacheReadTokens += usage.cacheReadTokens;
            totalUsageTokens += tokenAccounting.totalTokens;
            totalCacheHitDenominator += tokenAccounting.cacheHitDenominator;
            totalCost += rowCost;

            // Alias applies at the display/grouping layer only; raw_model is
            // the stored identity.
            const canonicalModel = (aliasMap && aliasMap[row.raw_model]) || row.raw_model || 'unknown';
            const compositeKey = statsMode === 'model' ? canonicalModel
                : statsMode === 'agent' ? agent
                : `${agent}:${canonicalModel}`;

            if (!modelStats[compositeKey]) {
                const base = {
                    inputTokens: 0, outputTokens: 0,
                    cacheReadTokens: 0, cacheCreationTokens: 0,
                    totalCost: 0, totalTokens: 0,
                    cacheHitDenominator: 0, requestCount: 0,
                    estimated: false,
                };
                if (statsMode === 'agent') {
                    base.agent = agent;
                    base.agentName = AGENT_DISPLAY_NAMES[agent] || agent;
                    base.modelSet = new Set();
                } else if (statsMode === 'model') {
                    base.model = canonicalModel;
                    base.displayName = canonicalModel;
                } else {
                    base.model = canonicalModel;
                    base.displayName = canonicalModel;
                    base.agent = agent;
                    base.agentName = AGENT_DISPLAY_NAMES[agent] || agent;
                }
                modelStats[compositeKey] = base;
            }
            const m = modelStats[compositeKey];
            m.inputTokens += usage.inputTokens;
            m.outputTokens += usage.outputTokens;
            m.cacheReadTokens += usage.cacheReadTokens;
            m.cacheCreationTokens += usage.cacheCreationTokens;
            m.totalCost += rowCost;
            m.totalTokens += tokenAccounting.totalTokens;
            m.cacheHitDenominator += tokenAccounting.cacheHitDenominator;
            m.requestCount += requests;
            m.estimated ||= isEstimated;
            if (statsMode === 'agent') m.modelSet.add(row.raw_model);

            if (!dailyMap[row.date]) {
                dailyMap[row.date] = {
                    date: row.date, inputTokens: 0, outputTokens: 0,
                    cacheCreationTokens: 0, cacheReadTokens: 0,
                    cost: 0, totalTokens: 0, requestCount: 0,
                    estimated: false,
                };
            }
            const d = dailyMap[row.date];
            d.inputTokens += usage.inputTokens;
            d.outputTokens += usage.outputTokens;
            d.cacheCreationTokens += usage.cacheCreationTokens;
            d.cacheReadTokens += usage.cacheReadTokens;
            d.cost += rowCost;
            d.totalTokens += tokenAccounting.totalTokens;
            d.requestCount += requests;
            d.estimated ||= isEstimated;
        }

        const cacheHitRate = totalCacheHitDenominator > 0
            ? totalCacheReadTokens / totalCacheHitDenominator : 0;
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

        return {
            totalRequests,
            totalTokens: totalUsageTokens,
            totalRealTokens: totalUsageTokens,
            totalCost,
            hasEstimatedUsage,
            totalCostFormatted: formatCost(totalCost, currency, exchangeRate),
            totalInputTokens, totalOutputTokens,
            totalCacheCreationTokens, totalCacheReadTokens,
            totalInputFormatted: _formatPossiblyEstimated(totalInputTokens, tokenFormat, hasEstimatedUsage),
            totalOutputFormatted: _formatPossiblyEstimated(totalOutputTokens, tokenFormat, hasEstimatedUsage),
            totalRealTokensFormatted: _formatPossiblyEstimated(totalUsageTokens, tokenFormat, hasEstimatedUsage),
            cacheHitRate,
            cacheHitRateFormatted: `${(cacheHitRate * 100).toFixed(1)}%`,
            daily: dailyArr,
            heatmapWeeks,
            modelStats: modelList.map(m => {
                const out = {
                    ...m,
                    percentage: totalCost > 0 ? m.totalCost / totalCost : 0,
                    totalCostFormatted: formatCost(m.totalCost, currency, exchangeRate),
                    inputTokensFormatted: _formatPossiblyEstimated(m.inputTokens, tokenFormat, m.estimated),
                    outputTokensFormatted: _formatPossiblyEstimated(m.outputTokens, tokenFormat, m.estimated),
                    cacheReadTokensFormatted: _formatPossiblyEstimated(m.cacheReadTokens, tokenFormat, m.estimated),
                    cacheCreationTokensFormatted: _formatPossiblyEstimated(m.cacheCreationTokens, tokenFormat, m.estimated),
                    cacheHitRateFormatted: `${(m.cacheHitRate * 100).toFixed(1)}%`,
                    totalTokensFormatted: _formatPossiblyEstimated(m.totalTokens, tokenFormat, m.estimated),
                };
                if (m.modelSet) { out.modelCount = m.modelSet.size; delete out.modelSet; }
                return out;
            }),
            daysWithUsage: dailyArr.filter(d => d.totalTokens > 0).length,
            currency, exchangeRate,
        };
    }

    /**
     * Heatmap from pre-aggregated rows. Same windowing as
     * _getTokenHeatmapWeeks but consumes (date, agent, *Tokens) rows
     * instead of per-entry records.
     */
    _getHeatmapFromRows(rows, tokenFormat, today) {
        if (
            this._heatmapCache.entries === rows &&
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
        for (const row of rows) {
            if (!row.date || row.date < rangeStart || row.date > today) continue;
            const agent = row.agent || 'claude';
            const appType = AGENT_APP_TYPE_MAP[agent] || agent;
            const usage = {
                inputTokens: row.inputTokens || 0,
                outputTokens: row.outputTokens || 0,
                cacheReadTokens: row.cacheReadTokens || 0,
                cacheCreationTokens: row.cacheCreationTokens || 0,
            };
            const tokenAccounting = calculateTokenAccountingForApp(appType, usage);
            if (!dailyMap[row.date]) dailyMap[row.date] = { totalTokens: 0, requestCount: 0 };
            dailyMap[row.date].totalTokens += tokenAccounting.totalTokens;
            dailyMap[row.date].requestCount += Number(row.requestCount) || 1;
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
                    date: dateKey, inRange, isFuture: dateKey > today,
                    totalTokens: stats.totalTokens, requestCount: stats.requestCount,
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
        this._heatmapCache = { entries: rows, today, tokenFormat, heatmapWeeks };
        return heatmapWeeks;
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
            hasEstimatedUsage: false,
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

function _formatPossiblyEstimated(tokens, format, estimated) {
    const value = formatTokens(tokens, format);
    return estimated ? `≈${value}` : value;
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

export function _formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
