import { CostCalculator, formatCost, formatTokens, calculateTokenAccountingForApp } from './costCalculator.js';
import { getPricingForModel } from './pricingResolver.js';
import { AGENT_APP_TYPE_MAP, AGENT_DISPLAY_NAMES } from './defaultPricing.js';

let _ = (s) => s;

export function setGettext(fn) {
    _ = fn;
}

const HEATMAP_WEEK_COUNT = 16;
const ACHIEVEMENT_HISTORY_WEEKS = 8;

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
        const weeklyReport = this._getWeeklyReport(entries || [], {
            tokenFormat,
            costMultiplier,
            overridesJson,
            currency,
            exchangeRate,
            today,
        });
        const achievements = this._getAchievements(weeklyReport);

        if (!entries || entries.length === 0) {
            return this._emptyResult(heatmapWeeks, weeklyReport, achievements);
        }

        const sortOrder = this._settings.get_string('sort-order');
        const modelSortBy = this._settings.get_string('model-sort-by');

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
            if (!entry._fromArchive && !dateFilter(entry.date)) continue;

            const {
                agent,
                pricing,
                usage,
                tokenAccounting,
                entryCost,
            } = this._entryMetrics(entry, { costMultiplier, overridesJson, exchangeRate });

            totalRequests += 1;
            totalInputTokens += usage.inputTokens;
            totalOutputTokens += usage.outputTokens;
            totalCacheCreationTokens += usage.cacheCreationTokens;
            totalCacheReadTokens += usage.cacheReadTokens;
            totalUsageTokens += tokenAccounting.totalTokens;
            totalCacheHitDenominator += tokenAccounting.cacheHitDenominator;
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
                    totalTokens: 0,
                    cacheHitDenominator: 0,
                    requestCount: 0,
                };
            }
            modelStats[compositeKey].inputTokens += usage.inputTokens;
            modelStats[compositeKey].outputTokens += usage.outputTokens;
            modelStats[compositeKey].cacheReadTokens += usage.cacheReadTokens;
            modelStats[compositeKey].cacheCreationTokens += usage.cacheCreationTokens;
            modelStats[compositeKey].totalCost += entryCost;
            modelStats[compositeKey].totalTokens += tokenAccounting.totalTokens;
            modelStats[compositeKey].cacheHitDenominator += tokenAccounting.cacheHitDenominator;
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
            dailyMap[entry.date].totalTokens += tokenAccounting.totalTokens;
            dailyMap[entry.date].requestCount += 1;
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
            modelStats: modelList.map(m => ({
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
            })),
            daysWithUsage: dailyArr.filter(d => d.totalTokens > 0).length,
            currency,
            exchangeRate,
            weeklyReport,
            achievements,
        };
    }

    _entryMetrics(entry, { costMultiplier, overridesJson, exchangeRate }) {
        const agent = entry._agent || 'claude';
        const appType = AGENT_APP_TYPE_MAP[agent] || agent;
        const pricing = getPricingForModel(entry.model, null, overridesJson);
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
        return this._entryMetrics(entry, { costMultiplier, overridesJson, exchangeRate });
    }

    _getWeeklyReport(entries, options) {
        const todayDate = _parseLocalDate(options.today);
        const currentStartDate = _startOfLocalWeek(todayDate);
        const currentStart = _formatLocalDate(currentStartDate);
        const currentEndDate = new Date(currentStartDate);
        currentEndDate.setDate(currentEndDate.getDate() + 6);
        const currentEnd = _formatLocalDate(currentEndDate);

        const historyStartDate = new Date(currentStartDate);
        historyStartDate.setDate(historyStartDate.getDate() - ACHIEVEMENT_HISTORY_WEEKS * 7);
        const historyStart = _formatLocalDate(historyStartDate);

        const current = _emptyWeekStats(currentStart);
        const historyMap = {};

        for (let i = ACHIEVEMENT_HISTORY_WEEKS; i >= 1; i--) {
            const start = new Date(currentStartDate);
            start.setDate(start.getDate() - i * 7);
            historyMap[_formatLocalDate(start)] = _emptyWeekStats(_formatLocalDate(start));
        }

        for (const entry of entries) {
            if (!entry.date || entry.date < historyStart || entry.date > currentEnd) continue;

            const date = _parseLocalDate(entry.date);
            const weekStart = _formatLocalDate(_startOfLocalWeek(date));
            const stats = weekStart === currentStart ? current : historyMap[weekStart];
            if (!stats) continue;

            const metrics = this._entryMetrics(entry, options);
            _addEntryToWeekStats(stats, entry, metrics);
        }

        const historyWeeks = Object.values(historyMap);
        const nonEmptyHistory = historyWeeks.filter(w => w.totalTokens > 0 || w.requestCount > 0);
        const baseline = _buildWeeklyBaseline(nonEmptyHistory);
        const daily = _buildCurrentWeekDaily(current, currentStartDate, options.tokenFormat);
        const topModel = _topMapEntry(current.modelMap);
        const topAgent = _topMapEntry(current.agentMap);

        const title = _weeklyTitle(current, baseline);
        const subtitle = _weeklySubtitle(current, baseline);
        const costPerMillion = current.totalTokens > 0
            ? current.totalCost / current.totalTokens * 1_000_000
            : 0;

        return {
            weekStart: currentStart,
            weekEnd: currentEnd,
            title,
            subtitle,
            totalTokens: current.totalTokens,
            totalTokensFormatted: formatTokens(current.totalTokens, options.tokenFormat),
            totalCost: current.totalCost,
            totalCostFormatted: formatCost(current.totalCost, options.currency, options.exchangeRate),
            requestCount: current.requestCount,
            activeDays: current.activeDates.size,
            modelCount: current.modelMap.size,
            agentCount: current.agentMap.size,
            cacheHitRate: current.cacheHitDenominator > 0
                ? current.cacheReadTokens / current.cacheHitDenominator
                : 0,
            cacheHitRateFormatted: `${(current.cacheHitDenominator > 0 ? current.cacheReadTokens / current.cacheHitDenominator * 100 : 0).toFixed(1)}%`,
            cacheReadTokens: current.cacheReadTokens,
            costPerMillion,
            costPerMillionFormatted: formatCost(costPerMillion, options.currency, options.exchangeRate),
            topModel: topModel ? topModel.label : _('暂无'),
            topAgent: topAgent ? topAgent.label : _('暂无'),
            daily,
            baseline,
            historyWeeks: historyWeeks.map(w => ({
                weekStart: w.weekStart,
                totalTokens: w.totalTokens,
                activeDays: w.activeDates.size,
                modelCount: w.modelMap.size,
                cacheHitRate: w.cacheHitDenominator > 0 ? w.cacheReadTokens / w.cacheHitDenominator : 0,
                costPerMillion: w.totalTokens > 0 ? w.totalCost / w.totalTokens * 1_000_000 : 0,
            })),
        };
    }

    _getAchievements(weeklyReport) {
        const state = _parseAchievementState(this._settings.get_string('achievement-state'));
        const updatedState = { ...state };
        let hasAchievementStateChanges = false;
        const now = new Date().toISOString();
        const baseline = weeklyReport.baseline || {};
        const enoughHistory = (baseline.nonEmptyWeeks || 0) >= 2;

        const highWeekThreshold = enoughHistory
            ? Math.max(1, baseline.avgTokens * 1.2)
            : 100_000;
        const activeHardThreshold = 5;
        const activeLiveThreshold = enoughHistory ? 5 : 3;
        const modelThreshold = enoughHistory
            ? Math.max(3, Math.ceil((baseline.avgModelCount || 0) + 1))
            : 3;
        const cacheThreshold = enoughHistory
            ? Math.max(0.3, (baseline.avgCacheHitRate || 0) + 0.1)
            : 0.3;
        const saverThreshold = baseline.avgCostPerMillion > 0
            ? baseline.avgCostPerMillion * 0.85
            : 0;

        const specs = [
            {
                id: 'high-week',
                title: _('高能周'),
                description: _('本周 Token 明显高于平常'),
                value: weeklyReport.totalTokens,
                threshold: highWeekThreshold,
                valueLabel: weeklyReport.totalTokensFormatted,
                thresholdLabel: formatTokens(highWeekThreshold, this._settings.get_string('token-display-format')),
                liveMet: weeklyReport.totalTokens >= highWeekThreshold && weeklyReport.totalTokens > 0,
                hardMet: weeklyReport.totalTokens >= highWeekThreshold && weeklyReport.totalTokens > 0,
            },
            {
                id: 'active-week',
                title: _('连勤周'),
                description: _('本周多天都有 AI 编程记录'),
                value: weeklyReport.activeDays,
                threshold: activeLiveThreshold,
                valueLabel: `${weeklyReport.activeDays}${_('天')}`,
                thresholdLabel: `${activeLiveThreshold}${_('天')}`,
                liveMet: weeklyReport.activeDays >= activeLiveThreshold,
                hardMet: weeklyReport.activeDays >= activeHardThreshold,
            },
            {
                id: 'model-explorer',
                title: _('模型探索'),
                description: _('本周尝试了更多不同模型'),
                value: weeklyReport.modelCount,
                threshold: modelThreshold,
                valueLabel: `${weeklyReport.modelCount}${_('个')}`,
                thresholdLabel: `${modelThreshold}${_('个')}`,
                liveMet: weeklyReport.modelCount >= modelThreshold,
                hardMet: weeklyReport.modelCount >= modelThreshold,
            },
            {
                id: 'cache-comeback',
                title: _('缓存回血'),
                description: _('缓存命中率表现不错'),
                value: weeklyReport.cacheHitRate,
                threshold: cacheThreshold,
                valueLabel: weeklyReport.cacheHitRateFormatted,
                thresholdLabel: `${(cacheThreshold * 100).toFixed(0)}%`,
                liveMet: weeklyReport.cacheReadTokens > 0 && weeklyReport.cacheHitRate >= cacheThreshold,
                hardMet: weeklyReport.cacheReadTokens > 0 && weeklyReport.cacheHitRate >= cacheThreshold,
            },
            {
                id: 'cost-saver',
                title: _('省钱打法'),
                description: _('本周每百万 Token 成本低于平常'),
                value: saverThreshold > 0 ? baseline.avgCostPerMillion - weeklyReport.costPerMillion : 0,
                threshold: saverThreshold > 0 ? baseline.avgCostPerMillion - saverThreshold : 0,
                valueLabel: weeklyReport.costPerMillionFormatted,
                thresholdLabel: saverThreshold > 0
                    ? formatCost(saverThreshold, this._settings.get_string('cost-currency'), this._settings.get_double('cny-exchange-rate'))
                    : _('需要历史数据'),
                liveMet: saverThreshold > 0 && weeklyReport.totalTokens >= 10_000 && weeklyReport.costPerMillion <= saverThreshold,
                hardMet: saverThreshold > 0 && weeklyReport.totalTokens >= 10_000 && weeklyReport.costPerMillion <= saverThreshold,
            },
        ];

        const items = specs.map(spec => {
            const saved = state[spec.id] || null;
            let newlyUnlocked = false;
            if (spec.hardMet && !saved) {
                newlyUnlocked = true;
                hasAchievementStateChanges = true;
                updatedState[spec.id] = {
                    unlockedAt: now,
                    bestValue: spec.value,
                };
            } else if (spec.hardMet && saved && spec.value > (saved.bestValue || 0)) {
                hasAchievementStateChanges = true;
                updatedState[spec.id] = {
                    ...saved,
                    bestValue: spec.value,
                };
            }

            const persisted = updatedState[spec.id] || saved;
            return {
                id: spec.id,
                title: spec.title,
                description: spec.description,
                valueLabel: spec.valueLabel,
                thresholdLabel: spec.thresholdLabel,
                progress: spec.threshold > 0 ? Math.min(1, Math.max(0, spec.value / spec.threshold)) : 0,
                isLive: spec.liveMet,
                unlocked: Boolean(persisted),
                newlyUnlocked,
                unlockedAt: persisted ? persisted.unlockedAt : '',
                bestValue: persisted ? persisted.bestValue : 0,
            };
        });

        return {
            items,
            live: items.filter(item => item.isLive),
            unlocked: items.filter(item => item.unlocked),
            updatedState,
            hasAchievementStateChanges,
        };
    }

    _buildDateFilter(preset, customSince, customUntil) {
        const today = _formatLocalDate(new Date());

        if (preset === 'today') {
            const todayStr = today;
            return (date) => date >= todayStr;
        }
        if (preset === '7d') {
            // Include today as day 1: 7 calendar days total (today - 6 .. today).
            const sinceDate = new Date();
            sinceDate.setDate(sinceDate.getDate() - 6);
            const since = _formatLocalDate(sinceDate);
            return (date) => date >= since;
        }
        if (preset === '30d') {
            // Include today as day 1: 30 calendar days total (today - 29 .. today).
            const sinceDate = new Date();
            sinceDate.setDate(sinceDate.getDate() - 29);
            const since = _formatLocalDate(sinceDate);
            return (date) => date >= since;
        }
        if (preset === 'all') {
            return () => true;
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
            dailyMap[entry.date].requestCount += 1;
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

    _emptyResult(heatmapWeeks = null, weeklyReport = null, achievements = null) {
        const currency = this._settings ? this._settings.get_string('cost-currency') : 'CNY';
        const exchangeRate = this._settings ? this._settings.get_double('cny-exchange-rate') : 7.25;
        const tokenFormat = this._settings ? this._settings.get_string('token-display-format') : 'auto';
        const weeks = heatmapWeeks || this._getTokenHeatmapWeeks([], tokenFormat, _formatLocalDate(new Date()));
        const emptyWeeklyReport = weeklyReport || this._getWeeklyReport([], {
            tokenFormat,
            costMultiplier: this._settings ? this._settings.get_double('cost-multiplier') : 1,
            overridesJson: this._settings ? this._settings.get_string('price-overrides') : '{}',
            currency,
            exchangeRate,
            today: _formatLocalDate(new Date()),
        });

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
            weeklyReport: emptyWeeklyReport,
            achievements: achievements || this._getAchievements(emptyWeeklyReport),
        };
    }
}

function _parseAchievementState(raw) {
    try {
        const parsed = JSON.parse(raw || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed;
    } catch (_e) {
        return {};
    }
}

function _emptyWeekStats(weekStart) {
    return {
        weekStart,
        totalTokens: 0,
        totalCost: 0,
        requestCount: 0,
        cacheReadTokens: 0,
        cacheHitDenominator: 0,
        activeDates: new Set(),
        modelMap: new Map(),
        agentMap: new Map(),
        dailyMap: new Map(),
    };
}

function _addEntryToWeekStats(stats, entry, metrics) {
    const modelKey = `${metrics.agent}:${entry.model || 'unknown'}`;
    const displayName = metrics.pricing ? (metrics.pricing.displayName || entry.model || 'unknown') : (entry.model || 'unknown');
    const agentName = AGENT_DISPLAY_NAMES[metrics.agent] || metrics.agent;

    stats.totalTokens += metrics.tokenAccounting.totalTokens;
    stats.totalCost += metrics.entryCost;
    stats.requestCount += 1;
    stats.cacheReadTokens += metrics.usage.cacheReadTokens;
    stats.cacheHitDenominator += metrics.tokenAccounting.cacheHitDenominator;
    stats.activeDates.add(entry.date);

    _addToAggregateMap(stats.modelMap, modelKey, displayName, metrics.tokenAccounting.totalTokens, metrics.entryCost);
    _addToAggregateMap(stats.agentMap, metrics.agent, agentName, metrics.tokenAccounting.totalTokens, metrics.entryCost);

    const daily = stats.dailyMap.get(entry.date) || { date: entry.date, totalTokens: 0, requestCount: 0, cost: 0 };
    daily.totalTokens += metrics.tokenAccounting.totalTokens;
    daily.requestCount += 1;
    daily.cost += metrics.entryCost;
    stats.dailyMap.set(entry.date, daily);
}

function _addToAggregateMap(map, key, label, tokens, cost) {
    const current = map.get(key) || { key, label, tokens: 0, cost: 0, requestCount: 0 };
    current.tokens += tokens;
    current.cost += cost;
    current.requestCount += 1;
    map.set(key, current);
}

function _topMapEntry(map) {
    let best = null;
    for (const entry of map.values()) {
        if (!best || entry.tokens > best.tokens) best = entry;
    }
    return best;
}

function _buildCurrentWeekDaily(stats, weekStartDate, tokenFormat) {
    const days = [];
    let maxTokens = 0;
    for (let i = 0; i < 7; i++) {
        const d = new Date(weekStartDate);
        d.setDate(d.getDate() + i);
        const key = _formatLocalDate(d);
        const dayStats = stats.dailyMap.get(key) || { date: key, totalTokens: 0, requestCount: 0, cost: 0 };
        if (dayStats.totalTokens > maxTokens) maxTokens = dayStats.totalTokens;
        days.push(dayStats);
    }
    return days.map((day, index) => ({
        ...day,
        weekday: [_('一'), _('二'), _('三'), _('四'), _('五'), _('六'), _('日')][index],
        totalTokensFormatted: formatTokens(day.totalTokens, tokenFormat),
        level: _tokenHeatLevel(day.totalTokens, maxTokens),
    }));
}

function _buildWeeklyBaseline(weeks) {
    const nonEmptyWeeks = weeks.length;
    const sumTokens = weeks.reduce((sum, w) => sum + w.totalTokens, 0);
    const sumActiveDays = weeks.reduce((sum, w) => sum + w.activeDates.size, 0);
    const sumModelCount = weeks.reduce((sum, w) => sum + w.modelMap.size, 0);
    const cacheWeeks = weeks.filter(w => w.cacheHitDenominator > 0);
    const costWeeks = weeks.filter(w => w.totalTokens > 0);

    return {
        nonEmptyWeeks,
        avgTokens: nonEmptyWeeks > 0 ? sumTokens / nonEmptyWeeks : 0,
        avgActiveDays: nonEmptyWeeks > 0 ? sumActiveDays / nonEmptyWeeks : 0,
        avgModelCount: nonEmptyWeeks > 0 ? sumModelCount / nonEmptyWeeks : 0,
        avgCacheHitRate: cacheWeeks.length > 0
            ? cacheWeeks.reduce((sum, w) => sum + w.cacheReadTokens / w.cacheHitDenominator, 0) / cacheWeeks.length
            : 0,
        avgCostPerMillion: costWeeks.length > 0
            ? costWeeks.reduce((sum, w) => sum + w.totalCost / w.totalTokens * 1_000_000, 0) / costWeeks.length
            : 0,
    };
}

function _weeklyTitle(current, baseline) {
    if (current.totalTokens <= 0) return _('本周还没开张');
    if (baseline.nonEmptyWeeks >= 2 && current.totalTokens >= baseline.avgTokens * 1.2) return _('高能输出周');
    if (current.activeDates.size >= 5) return _('连勤手感在线');
    if (current.modelMap.size >= 3) return _('模型探索周');
    return _('本周稳步推进');
}

function _weeklySubtitle(current, baseline) {
    if (current.totalTokens <= 0) return _('有新记录后，这里会生成本周小结。');
    if (baseline.nonEmptyWeeks < 2) {
        return _('历史样本还少，先记录本周节奏。');
    }
    if (baseline.avgTokens <= 0) return _('本周已经留下 AI 编程记录。');
    const ratio = current.totalTokens / baseline.avgTokens;
    if (ratio >= 1.05) return _('Token 比平常更活跃。');
    if (ratio <= 0.75) return _('这一周相对轻量。');
    return _('节奏接近平常水平。');
}

export function _parseLocalDate(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
}

function _startOfLocalWeek(date) {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = start.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + diff);
    return start;
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
