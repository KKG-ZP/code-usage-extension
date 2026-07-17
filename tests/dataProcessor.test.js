// Stage-4 DataProcessor test: processAggregatedRows vs processEntries parity.
//
// Feeds the same underlying usage data through both paths (pseudo-entries
// from the snapshot vs the snapshot's aggregated rows directly) and asserts
// the totals / modelStats / daily / heatmap outputs match, confirming the
// stage-4 shortcut is observationally equivalent to the legacy per-entry
// loop. Also covers: date-range filtering on rows, alias grouping, and the
// 'no rows' empty path.
//
// Run with: gjs -m tests/dataProcessor.test.js

import GLib from 'gi://GLib';
import { DataProcessor } from '../modules/dataProcessor.js';

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function approxEq(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

function makeSettings(overrides) {
    const base = {
        'token-display-format': 'auto',
        'cost-currency': 'CNY',
        'cny-exchange-rate': 7.25,
        'price-overrides': '{}',
        'model-aliases': '{}',
        'date-range-preset': 'all',
        'custom-date-since': '',
        'custom-date-until': '',
        'sort-order': 'desc',
        'model-sort-by': 'cost',
        'stats-mode': 'agent-model',
        'debug-mode': false,
    };
    const merged = { ...base, ...overrides };
    return {
        get_string: (k) => merged[k] != null ? String(merged[k]) : '',
        get_double: (k) => Number(merged[k]) || 0,
        get_boolean: (k) => !!merged[k],
    };
}

// A snapshot-style row (the worker's output) and the equivalent pseudo-entry
// (what cacheManager._snapshotToEntries produces) carry the same data.
const today = new Date();
const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const rows = [
    { date: '2026-07-14', agent: 'codex', raw_model: 'gpt-5.5-codex',
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 0,
      requestCount: 3, cost: 1.23 },
    { date: '2026-07-15', agent: 'codex', raw_model: 'gpt-5.5-codex',
      inputTokens: 2000, outputTokens: 800, cacheReadTokens: 400, cacheCreationTokens: 0,
      requestCount: 4, cost: 2.5 },
    { date: todayStr, agent: 'claude', raw_model: 'claude-sonnet-4',
      inputTokens: 500, outputTokens: 250, cacheReadTokens: 0, cacheCreationTokens: 100,
      requestCount: 1, cost: 0.5 },
];
// Equivalent pseudo-entries (the shape _snapshotToEntries emits).
const entries = rows.map(r => ({
    date: r.date, model: r.raw_model, _agent: r.agent,
    inputTokens: r.inputTokens, outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens, cacheCreationTokens: r.cacheCreationTokens,
    requestCount: r.requestCount, costUSD: null, _finalCostCNY: r.cost,
}));

async function main() {
    // 1. Parity: processAggregatedRows vs processEntries on the same data.
    //    date-range-preset 'all' excludes today (see _buildDateFilter), so
    //    today's row is dropped by both paths — totals match on the 2 past
    //    days.
    const s = makeSettings({ 'date-range-preset': 'all' });
    const proc = new DataProcessor(s);
    const byRows = proc.processAggregatedRows(rows);
    const byEntries = proc.processEntries(entries);
    assert(approxEq(byRows.totalCost, byEntries.totalCost),
        `totalCost: rows=${byRows.totalCost} entries=${byEntries.totalCost}`);
    assert(byRows.totalRequests === byEntries.totalRequests,
        `totalRequests: rows=${byRows.totalRequests} entries=${byEntries.totalRequests}`);
    assert(approxEq(byRows.totalInputTokens, byEntries.totalInputTokens),
        `totalInputTokens mismatch`);
    assert(approxEq(byRows.totalOutputTokens, byEntries.totalOutputTokens),
        `totalOutputTokens mismatch`);
    assert(approxEq(byRows.totalTokens, byEntries.totalTokens),
        `totalTokens mismatch`);
    assert(byRows.modelStats.length === byEntries.modelStats.length,
        `modelStats length: rows=${byRows.modelStats.length} entries=${byEntries.modelStats.length}`);
    assert(byRows.daily.length === byEntries.daily.length,
        `daily length: rows=${byRows.daily.length} entries=${byEntries.daily.length}`);
    assert(byRows.heatmapWeeks.length === byEntries.heatmapWeeks.length,
        `heatmapWeeks length mismatch`);

    // 2. Date-range filter applies to rows too: 'today' preset → only today's row.
    const sToday = makeSettings({ 'date-range-preset': 'today' });
    const procToday = new DataProcessor(sToday);
    const todayResult = procToday.processAggregatedRows(rows);
    assert(todayResult.totalRequests === 1, `today-only requests: ${todayResult.totalRequests}`);
    assert(todayResult.modelStats.length === 1, `today-only models: ${todayResult.modelStats.length}`);
    assert(todayResult.modelStats[0].agent === 'claude', `today model agent: ${todayResult.modelStats[0].agent}`);

    // 3. Alias grouping: alias claude-sonnet-4 → gpt-5.5-codex merges into one model card in 'model' stats-mode.
    const sAlias = makeSettings({
        'stats-mode': 'model',
        'model-aliases': JSON.stringify({ 'claude-sonnet-4': 'gpt-5.5-codex' }),
        'date-range-preset': 'all',
    });
    const procAlias = new DataProcessor(sAlias);
    const aliasResult = procAlias.processAggregatedRows(rows);
    // today's claude row is excluded by 'all'; two codex rows merge to 1 model card
    assert(aliasResult.modelStats.length === 1, `alias-merged models: ${aliasResult.modelStats.length}`);
    assert(aliasResult.modelStats[0].model === 'gpt-5.5-codex', `alias model: ${aliasResult.modelStats[0].model}`);

    // 4. Empty rows → empty result (no crash).
    const empty = proc.processAggregatedRows([]);
    assert(empty.totalRequests === 0 && empty.modelStats.length === 0,
        `empty rows should yield empty result`);

    // 5. Estimated ZCode fallback is visibly distinguished from exact
    // provider/database usage in the panel-facing formatted values.
    const estimated = procToday.processAggregatedRows([{
        date: todayStr, agent: 'zcode', raw_model: 'glm-5.2:cloud',
        inputTokens: 1_500_000, outputTokens: 20_000,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        requestCount: 80, cost: 0, usageSource: 'rollout-estimate', estimated: true,
    }]);
    assert(estimated.hasEstimatedUsage === true,
        `estimated result marker: ${estimated.hasEstimatedUsage}`);
    assert(estimated.totalRealTokensFormatted.startsWith('≈'),
        `estimated total formatting: ${estimated.totalRealTokensFormatted}`);
    assert(estimated.modelStats[0].totalTokensFormatted.startsWith('≈'),
        `estimated model formatting: ${estimated.modelStats[0].totalTokensFormatted}`);

    print('dataProcessor tests passed');
}

const loop = GLib.MainLoop.new(null, false);
main().then(() => loop.quit())
    .catch((e) => { console.error(`dataProcessor tests FAILED: ${e.message}`); loop.quit(); });
loop.run();
