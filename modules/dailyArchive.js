// Persistent usage store split into immutable history and a mutable current day.
//
// Historical days are materialized once from the selected agents and then only
// grow through an explicit history sync. The current day is checkpointed so a
// GNOME Shell restart cannot lose usage accumulated before midnight.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const TEXT_DECODER = new TextDecoder('utf-8');
const TEXT_ENCODER = new TextEncoder('utf-8');
const ARCHIVE_VERSION = 2;

export class DailyArchive {
    constructor(settings, processor) {
        this._settings = settings;
        this._processor = processor;
        this._path = GLib.build_filenamev(
            [GLib.get_user_data_dir(), 'code-usage-extension', 'daily-usage.json']);
        this._historyDays = new Map();
        this._activeDay = null;
        this._metadata = {
            initialized: false,
            initializedAgents: [],
            initializedAt: null,
            lastHistorySyncAt: null,
        };
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
            if (!file.query_exists(null)) return;
            const [ok, contents] = file.load_contents(null);
            if (!ok) return;
            const parsed = JSON.parse(TEXT_DECODER.decode(contents));
            if (!parsed || typeof parsed !== 'object') return;

            // v1 used `days` for both historical and current snapshots. Keep
            // the records, then move today's record into activeDay on first use.
            const history = parsed.version >= ARCHIVE_VERSION
                ? (parsed.historyDays || {})
                : (parsed.days || {});
            for (const [date, record] of Object.entries(history)) {
                if (record && typeof record === 'object') this._historyDays.set(date, record);
            }
            if (parsed.version >= ARCHIVE_VERSION && parsed.activeDay) {
                this._activeDay = parsed.activeDay;
            }
            if (parsed.metadata && typeof parsed.metadata === 'object') {
                this._metadata = { ...this._metadata, ...parsed.metadata };
            }
        } catch (e) {
            this._historyDays = new Map();
            this._activeDay = null;
            this._debug(`archive load failed, starting empty: ${e.message}`);
        }
    }

    _persist() {
        try {
            GLib.mkdir_with_parents(GLib.get_dirname(this._path), 0o755);
            const payload = {
                version: ARCHIVE_VERSION,
                historyDays: Object.fromEntries(this._historyDays),
                activeDay: this._activeDay,
                metadata: this._metadata,
            };
            // g_file_set_contents writes through a temporary file and rename.
            GLib.file_set_contents(this._path, TEXT_ENCODER.encode(JSON.stringify(payload, null, 2)));
        } catch (e) {
            this._debug(`archive persist failed: ${e.message}`);
        }
    }

    /**
     * Complete the one-time import for the currently enabled agents. It never
     * imports today's records: they belong to the mutable active-day checkpoint.
     */
    initializeIfNeeded(entries, selectedAgents, now = new Date()) {
        const today = _formatLocalDate(now);
        let changed = this._advanceDay(today);
        if (!this._metadata.initialized) {
            changed = this._mergeHistoricalEntries(entries, today) || changed;
            this._metadata.initialized = true;
            this._metadata.initializedAgents = [...selectedAgents];
            this._metadata.initializedAt = now.toISOString();
            changed = true;
        }
        if (changed) this._persist();
    }

    /**
     * Update the current-day checkpoint from the live cache. A reduced live
     * result cannot shrink the checkpoint, protecting the current day if a
     * source log is removed before it is sealed at midnight.
     */
    updateActiveDay(entries, now = new Date()) {
        const today = _formatLocalDate(now);
        let changed = this._advanceDay(today);
        const record = this._aggregateDay(entries, today, now);
        if (record) {
            const merged = _mergeRecords(this._activeDay, record, true);
            if (merged.changed) {
                this._activeDay = merged.record;
                changed = true;
            }
        }
        if (changed) this._persist();
    }

    /**
     * Explicit, non-destructive history import. Existing days are replaced
     * only when the newly scanned total token count is larger.
     */
    syncHistory(entries, selectedAgents, now = new Date()) {
        const today = _formatLocalDate(now);
        let changed = this._advanceDay(today);
        changed = this._mergeHistoricalEntries(entries, today) || changed;
        this._metadata.lastHistorySyncAt = now.toISOString();
        const initializedAgents = Array.isArray(this._metadata.initializedAgents)
            ? this._metadata.initializedAgents
            : [];
        this._metadata.initializedAgents = [...new Set([
            ...initializedAgents,
            ...selectedAgents,
        ])];
        this._metadata.initialized = true;
        this._persist();
        return changed;
    }

    /**
     * Return only plugin-owned records for rendering: frozen historical days
     * plus the current checkpoint. Raw historical source logs are never mixed
     * back into totals after the first import.
     */
    getDisplayEntries(selectedAgents, now = new Date()) {
        const today = _formatLocalDate(now);
        if (this._advanceDay(today)) this._persist();
        const selected = new Set(selectedAgents);
        const entries = [];
        for (const record of this._historyDays.values()) {
            entries.push(...this._recordEntries(record, selected));
        }
        if (this._activeDay && this._activeDay.date === today) {
            entries.push(...this._recordEntries(this._activeDay, selected));
        }
        return entries;
    }

    _advanceDay(today) {
        let changed = false;
        // v1 migration: today's old snapshot becomes the active checkpoint.
        const legacyToday = this._historyDays.get(today);
        if (legacyToday) {
            this._activeDay = _mergeRecords(this._activeDay, legacyToday, true).record;
            this._historyDays.delete(today);
            changed = true;
        }
        if (this._activeDay && this._activeDay.date < today) {
            changed = this._mergeHistoryRecord(this._activeDay) || changed;
            this._activeDay = null;
            changed = true;
        }
        return changed;
    }

    _mergeHistoricalEntries(entries, today) {
        const dates = new Set();
        for (const entry of entries || []) {
            if (entry.date && entry.date < today) dates.add(entry.date);
        }
        let changed = false;
        for (const date of dates) {
            const record = this._aggregateDay(entries, date, new Date());
            if (record) changed = this._mergeHistoryRecord(record) || changed;
        }
        return changed;
    }

    _mergeHistoryRecord(record) {
        const merged = _mergeRecords(this._historyDays.get(record.date), record, false);
        if (merged.changed) {
            this._historyDays.set(record.date, merged.record);
            return true;
        }
        return false;
    }

    _aggregateDay(entries, date, now) {
        const dayEntries = (entries || []).filter(entry => entry.date === date);
        if (dayEntries.length === 0) return null;

        let inputTokens = 0;
        let outputTokens = 0;
        let cacheCreationTokens = 0;
        let cacheReadTokens = 0;
        let totalTokens = 0;
        let cost = 0;
        let requestCount = 0;
        const breakdown = {};

        for (const entry of dayEntries) {
            const metrics = this._processor.computeEntryMetrics(entry);
            const agent = metrics.agent;
            const model = metrics.model || entry.model || 'unknown';
            const key = `${agent}:${model}`;
            const requests = _entryRequestCount(entry);

            inputTokens += metrics.usage.inputTokens;
            outputTokens += metrics.usage.outputTokens;
            cacheCreationTokens += metrics.usage.cacheCreationTokens;
            cacheReadTokens += metrics.usage.cacheReadTokens;
            totalTokens += metrics.tokenAccounting.totalTokens;
            cost += metrics.entryCost;
            requestCount += requests;

            if (!breakdown[key]) {
                breakdown[key] = {
                    agent, model,
                    inputTokens: 0, outputTokens: 0,
                    cacheCreationTokens: 0, cacheReadTokens: 0,
                    totalTokens: 0, cost: 0, requestCount: 0,
                };
            }
            const row = breakdown[key];
            row.inputTokens += metrics.usage.inputTokens;
            row.outputTokens += metrics.usage.outputTokens;
            row.cacheCreationTokens += metrics.usage.cacheCreationTokens;
            row.cacheReadTokens += metrics.usage.cacheReadTokens;
            row.totalTokens += metrics.tokenAccounting.totalTokens;
            row.cost += metrics.entryCost;
            row.requestCount += requests;
        }

        return {
            date,
            inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
            totalTokens, cost, requestCount, breakdown,
            snapshottedAt: now.toISOString(),
            exchangeRate: this._settings.get_double('cny-exchange-rate'),
            costMultiplier: this._settings.get_double('cost-multiplier'),
            currency: 'CNY',
        };
    }

    _recordEntries(record, selected) {
        const entries = [];
        for (const row of Object.values(record.breakdown || {})) {
            if (!selected.has(row.agent)) continue;
            entries.push({
                date: record.date,
                model: row.model,
                _agent: row.agent,
                inputTokens: row.inputTokens,
                outputTokens: row.outputTokens,
                cacheCreationTokens: row.cacheCreationTokens,
                cacheReadTokens: row.cacheReadTokens,
                requestCount: _entryRequestCount(row),
                costUSD: null,
                _finalCostCNY: row.cost,
                _fromArchive: true,
            });
        }
        return entries;
    }
}

function _entryRequestCount(entry) {
    const count = Number(entry.requestCount);
    return Number.isFinite(count) && count > 0 ? count : 1;
}

function _mergeRecords(previous, candidate, replaceEqualRows) {
    if (!previous || previous.date !== candidate.date) {
        return { record: candidate, changed: true };
    }

    const breakdown = { ...(previous.breakdown || {}) };
    let changed = false;
    for (const [key, candidateRow] of Object.entries(candidate.breakdown || {})) {
        const previousRow = breakdown[key];
        if (!previousRow || candidateRow.totalTokens > previousRow.totalTokens ||
            (replaceEqualRows && candidateRow.totalTokens === previousRow.totalTokens &&
                JSON.stringify(candidateRow) !== JSON.stringify(previousRow))) {
            breakdown[key] = candidateRow;
            changed = true;
        }
    }
    if (!changed) return { record: previous, changed: false };

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let totalTokens = 0;
    let cost = 0;
    let requestCount = 0;
    for (const row of Object.values(breakdown)) {
        inputTokens += row.inputTokens;
        outputTokens += row.outputTokens;
        cacheCreationTokens += row.cacheCreationTokens;
        cacheReadTokens += row.cacheReadTokens;
        totalTokens += row.totalTokens;
        cost += row.cost;
        requestCount += row.requestCount;
    }
    return {
        record: {
            ...candidate,
            inputTokens,
            outputTokens,
            cacheCreationTokens,
            cacheReadTokens,
            totalTokens,
            cost,
            requestCount,
            breakdown,
        },
        changed: true,
    };
}

function _formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
