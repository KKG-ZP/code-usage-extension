// Persistent daily-usage archive.
//
// The extension is otherwise a stateless READ-ONLY viewer: every refresh
// re-reads the agent log files and re-aggregates, so once Claude Code (or any
// agent) deletes a session log the usage it contained vanishes from the
// panel's stats. This module owns the extension's FIRST piece of persistent
// history — a JSON file of per-day snapshots refreshed on a 1h throttle with
// a MONOTONIC max-merge (a day's record only ever grows, never shrinks: days
// whose logs got deleted are simply left untouched), plus a merge of archived
// days back into the live entries so deleted days reappear in every view
// (daily list / heatmap / weekly report / per-model cards / totals).
//
// Storage lives OUTSIDE the extension install dir
// (~/.local/share/code-usage-extension/daily-usage.json) so it survives
// reinstall/uninstall. Token counts are authoritative (never drift); cost
// is the final CNY value recorded at snapshot time and is re-injected
// verbatim via the `_finalCostCNY` path in DataProcessor._entryMetrics.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const TEXT_DECODER = new TextDecoder('utf-8');
const TEXT_ENCODER = new TextEncoder('utf-8');

const ARCHIVE_VERSION = 1;
const THROTTLE_MS = 60 * 60 * 1000;   // refresh the archive at most once per hour

export class DailyArchive {
    constructor(settings, processor) {
        this._settings = settings;
        this._processor = processor;          // DataProcessor, for computeEntryMetrics
        this._path = GLib.build_filenamev(
            [GLib.get_user_data_dir(), 'code-usage-extension', 'daily-usage.json']);
        this._days = new Map();               // dateStr -> DayRecord
        this._lastRunMs = 0;                  // in-memory throttle checkpoint (ms epoch)
        this._load();
    }

    _debug(msg) {
        if (this._settings.get_boolean('debug-mode')) {
            console.log(`Code Usage: ${msg}`);
        }
    }

    _load() {
        try {
            const file = Gio.File.new_for_path(this._path);
            if (!file.query_exists(null)) return;            // first run: empty archive
            const [ok, contents] = file.load_contents(null);
            if (!ok) return;
            const parsed = JSON.parse(TEXT_DECODER.decode(contents));
            if (parsed && typeof parsed === 'object') {
                // Only `days` is read; a leftover `lastSnapshotDate` from the
                // older 1-AM-gate format is ignored (no migration needed).
                const days = parsed.days || {};
                for (const [d, rec] of Object.entries(days)) {
                    if (rec && typeof rec === 'object') this._days.set(d, rec);
                }
            }
        } catch (e) {
            // Corrupt/invalid archive: fall back to empty, never crash.
            this._days = new Map();
            this._debug(`archive load failed, starting empty: ${e.message}`);
        }
    }

    _persist() {
        try {
            const dir = GLib.get_dirname(this._path);
            GLib.mkdir_with_parents(dir, 0o755);              // idempotent; creates the dir if missing
            const payload = {
                version: ARCHIVE_VERSION,
                days: Object.fromEntries(this._days),
            };
            const bytes = TEXT_ENCODER.encode(JSON.stringify(payload, null, 2));
            // g_file_set_contents is atomic (temp file + rename + fsync), so a
            // failed/interrupted write leaves the previous file intact.
            GLib.file_set_contents(this._path, bytes);
        } catch (e) {
            // Disk full / permissions: log and keep going. In-memory state is
            // still updated; the next successful tick retries the write.
            this._debug(`archive persist failed: ${e.message}`);
        }
    }

    /**
     * Refresh the archive on a THROTTLE_MS cadence using a MONOTONIC
     * max-merge: for every day still present in the live entries, replace the
     * archived record only if the live aggregate is LARGER (replace-if-grew,
     * keyed on totalTokens). Days whose logs were deleted are absent from the
     * live set and are therefore never touched — so a day's record can only
     * grow, never shrink. This is what makes interval refresh safe: a naive
     * re-snapshot after deletion would overwrite a good record with zeros, but
     * here deleted days are simply left alone (and fully-deleted days are
     * later re-injected into the panel by mergeIntoEntries).
     *
     * Checked on every render tick; the throttle makes it a no-op except
     * once per hour. Self-heals across suspend/resume, clock skew, DST and
     * Shell restarts — the first tick whose throttle window has elapsed fires
     * (and after a Shell restart _lastRunMs is 0, so the first tick fires
     * immediately, cheaply re-evaluating in memory and writing only if today
     * actually grew).
     *
     * @param entries  live merged entries from cacheManager (has _agent)
     * @param nowDate  new Date() — pluggable for testing
     * @returns true if the archive was changed
     */
    maybeRunSnapshot(entries, nowDate) {
        if (!entries || entries.length === 0) return false;
        if (this._lastRunMs && (nowDate.getTime() - this._lastRunMs) < THROTTLE_MS) return false;

        // Every date still present in the live logs (includes today). Days
        // whose logs were deleted are NOT here, so they're never overwritten.
        const presentDates = new Set();
        for (const e of entries) if (e.date) presentDates.add(e.date);

        let changed = false;
        for (const d of presentDates) {
            const live = this._aggregateDay(entries, d);
            if (!live) continue;
            const prev = this._days.get(d);
            // replace-if-grew: only overwrite with a strictly larger snapshot.
            // Equal totalTokens (a finished day re-scanned, or a price-override
            // change that moved cost but not tokens) keeps the existing record,
            // so historical cost is preserved as-recorded rather than revalued.
            if (!prev || live.totalTokens > prev.totalTokens) {
                this._days.set(d, live);
                changed = true;
            }
        }
        this._lastRunMs = nowDate.getTime();
        if (changed) this._persist();
        return changed;
    }

    /**
     * Aggregate one day's live entries into a DayRecord, computing cost via
     * DataProcessor.computeEntryMetrics so it matches the panel exactly. Does
     * NOT apply the user's date-range preset (unlike processEntries), so a
     * past day can be snapshotted regardless of the current view filter.
     * Returns null for a zero-usage day (nothing to archive).
     */
    _aggregateDay(entries, dateStr) {
        const day = entries.filter(e => e.date === dateStr);
        if (day.length === 0) return null;

        const exchangeRate = this._settings.get_double('cny-exchange-rate');
        const costMultiplier = this._settings.get_double('cost-multiplier');

        let inputTokens = 0, outputTokens = 0,
            cacheCreationTokens = 0, cacheReadTokens = 0,
            totalTokens = 0, cost = 0, requestCount = 0;
        const breakdown = {};

        for (const e of day) {
            const m = this._processor.computeEntryMetrics(e);
            const agent = m.agent;
            const model = e.model || 'unknown';
            const compositeKey = `${agent}:${model}`;        // matches dataProcessor.js:92

            inputTokens += m.usage.inputTokens;
            outputTokens += m.usage.outputTokens;
            cacheCreationTokens += m.usage.cacheCreationTokens;
            cacheReadTokens += m.usage.cacheReadTokens;
            totalTokens += m.tokenAccounting.totalTokens;
            cost += m.entryCost;
            requestCount += 1;

            if (!breakdown[compositeKey]) {
                breakdown[compositeKey] = {
                    agent, model,
                    inputTokens: 0, outputTokens: 0,
                    cacheCreationTokens: 0, cacheReadTokens: 0,
                    totalTokens: 0, cost: 0, requestCount: 0,
                };
            }
            const bd = breakdown[compositeKey];
            bd.inputTokens += m.usage.inputTokens;
            bd.outputTokens += m.usage.outputTokens;
            bd.cacheCreationTokens += m.usage.cacheCreationTokens;
            bd.cacheReadTokens += m.usage.cacheReadTokens;
            bd.totalTokens += m.tokenAccounting.totalTokens;
            bd.cost += m.entryCost;
            bd.requestCount += 1;
        }

        return {
            date: dateStr,
            inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
            totalTokens, cost, requestCount,
            breakdown,
            snapshottedAt: new Date().toISOString(),
            exchangeRate, costMultiplier,
            currency: 'CNY',
        };
    }

    /**
     * Inject archived days into the live entries so processEntries aggregates
     * them uniformly into daily / totals / heatmap / weekly / per-model /
     * achievements. Only days with ZERO live entries are injected whole (live
     * data fully deleted). Days that still have live entries delegate to
     * _mergeRuleForDay (partial-deletion recovery).
     *
     * Only archived breakdown rows whose agent is currently selected are
     * injected, so switching the view to a different agent set never leaks
     * another agent's archived days into it.
     *
     * Synthetic entries are injected AFTER cacheManager.getMergedEntries, so
     * they bypass _dedupeKey dedup (no risk of being dropped or double-counted).
     */
    mergeIntoEntries(liveEntries, selectedAgents) {
        const selected = new Set(selectedAgents);
        const liveDates = new Set();
        for (const e of liveEntries) {
            if (e.date) liveDates.add(e.date);
        }
        const synthetic = [];
        for (const [dateStr, rec] of this._days) {
            if (liveDates.has(dateStr)) {
                const liveForDay = liveEntries.filter(e => e.date === dateStr);
                const extra = this._mergeRuleForDay(dateStr, liveForDay, rec, selectedAgents);
                if (extra && extra.length) synthetic.push(...extra);
                continue;
            }
            // Live has nothing for this day (logs fully deleted): rebuild the
            // archived day as one synthetic entry per (agent:model) breakdown.
            for (const bd of Object.values(rec.breakdown || {})) {
                if (!selected.has(bd.agent)) continue;       // only currently-selected agents
                synthetic.push({
                    date: dateStr,
                    model: bd.model,
                    _agent: bd.agent,
                    inputTokens: bd.inputTokens,
                    outputTokens: bd.outputTokens,
                    cacheCreationTokens: bd.cacheCreationTokens,
                    cacheReadTokens: bd.cacheReadTokens,
                    costUSD: null,           // do NOT use the USD path
                    _finalCostCNY: bd.cost,   // precomputed final CNY (see dataProcessor._entryMetrics)
                    _fromArchive: true,       // tag for debugging
                });
            }
        }
        return synthetic.length > 0 ? [...liveEntries, ...synthetic] : liveEntries;
    }

    /**
     * Decide how a day that has BOTH live entries and an archived snapshot
     * combines. Called once per archived day that has any live entries.
     *
     * Strategy: live-wins — when any live data exists for a day, trust it
     * entirely and ignore the archive. This never double-counts and is safe
     * even if Claude Code appends to old sessions. The trade-off is that
     * partially-deleted days (some sessions removed but others remain) stay
     * at the reduced live total rather than recovering to the archived peak.
     *
     * @param liveForDay       live entries with entry.date === dateStr
     * @param archivedRec      the DayRecord snapshotted before deletion
     * @param selectedAgents   array of currently-selected agent ids
     * @returns synthetic entries to inject as a delta, or [] to inject nothing
     */
    _mergeRuleForDay(dateStr, liveForDay, archivedRec, selectedAgents) {
        return [];
    }
}