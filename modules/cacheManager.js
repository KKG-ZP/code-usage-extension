// Snapshot-backed cache for the GNOME Shell extension.
//
// Stage 1 rewrite: the Shell no longer parses raw agent logs. A standalone
// worker process (worker/usage-worker.js) scans the logs and writes a
// compact-snapshot.json; this module just loads that snapshot and exposes
// its rows as the "entries" DataProcessor consumes. Heavy parsing stays in
// the worker subprocess so a GC stall or memory spike can never block
// Mutter/desktop compositing.
//
// The snapshot's dailyUsage rows are already aggregated by (date, agent,
// raw_model) with locked-in CNY cost. We surface them as pseudo-entries so
// DataProcessor's existing aggregation path (which re-sums per day) yields
// the same totals; stage 4 will shortcut straight to the aggregated rows.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { loadSnapshot } from '../worker/snapshot.js';

const TEXT_DECODER = new TextDecoder('utf-8');

export const IDLE_THRESHOLD_MS = 120 * 1000;

export class FileCacheManager {
    constructor(settings, agentConfigs) {
        this._settings = settings;
        this._agentConfigs = agentConfigs;
        this._snapshot = null;
        this._entries = null;
        this._lastActivityAt = 0;
        this._snapshotMtimeMs = 0;
    }

    _debug(msg) {
        if (this._settings.get_boolean('debug-mode')) {
            console.log(`Code Usage: ${msg}`);
        }
    }

    /**
     * Reload the snapshot from disk if its mtime advanced, then rebuild the
     * pseudo-entries. Returns { changed, lastActivityAt } so the caller can
     * keep driving its active/idle timer state machine; lastActivityAt is
     * derived from the snapshot's generatedAt (the worker's freshest scan
     * time), not raw file mtimes — the Shell no longer stats agent logs.
     */
    async scanAndDiff(_agents) {
        const changed = this._maybeReloadSnapshot();
        return { changed, lastActivityAt: this._lastActivityAt };
    }

    /**
     * Re-read compact-snapshot.json if its mtime advanced since the last
     * load. On a successful load, rebuild the pseudo-entries array and
     * update lastActivityAt from generatedAt. A missing/corrupt snapshot
     * leaves the previous entries intact (failure never wipes data).
     * Returns true iff the entries actually changed.
     */
    _maybeReloadSnapshot() {
        const path = _snapshotPath();
        let mtimeMs = 0;
        try {
            const info = Gio.File.new_for_path(path).query_info(
                'time::modified,time::modified-usec',
                Gio.FileQueryInfoFlags.NONE, null,
            );
            const sec = Number(info.get_attribute_uint64('time::modified'));
            let usec = 0;
            try { usec = Number(info.get_attribute_uint32('time::modified-usec')) || 0; } catch (_e) {}
            mtimeMs = sec * 1000 + Math.floor(usec / 1000);
        } catch (_e) {
            // snapshot missing — leave previous data intact
            return false;
        }
        if (mtimeMs === this._snapshotMtimeMs) return false;

        const snap = loadSnapshot();
        if (!snap) {
            // corrupt/missing: keep previous entries, don't treat as empty
            return false;
        }
        this._snapshotMtimeMs = mtimeMs;
        this._snapshot = snap;
        this._entries = _snapshotToEntries(snap);
        // lastActivityAt from generatedAt so the active/idle state machine
        // can still detect "logs were recently written" via the snapshot's
        // freshness rather than raw log mtimes.
        this._lastActivityAt = _isoToMs(snap.generatedAt) || mtimeMs;
        this._debug(`snapshot reloaded: ${this._entries.length} entries, ${snap.dailyUsage?.length || 0} rows`);
        return true;
    }

    /**
     * Return the flattened pseudo-entries array derived from the snapshot.
     * Each row becomes one entry carrying its aggregated counters + a
     * _finalCostCNY so DataProcessor bypasses USD→CNY re-valuation (the
     * worker already locked in the CNY cost at scan time).
     */
    getMergedEntries() {
        if (this._entries !== null) return this._entries;
        // First call before any scan: try a lazy load so the panel shows the
        // last good snapshot immediately on Shell restart.
        this._maybeReloadSnapshot();
        return this._entries || [];
    }

    /**
     * Stage 4: return the snapshot's dailyUsage rows directly (the
     * pre-aggregated (date, agent, raw_model) rows) so DataProcessor can
     * skip the per-entry loop and aggregate rows directly. Preferred over
     * getMergedEntries for the stage-4 query path.
     */
    getDailyUsage() {
        if (this._snapshot) return this._snapshot.dailyUsage || [];
        this._maybeReloadSnapshot();
        return (this._snapshot && this._snapshot.dailyUsage) || [];
    }

    /**
     * No-op for API compatibility. The snapshot is already bounded to
     * aggregated rows; there is no per-day retention to perform.
     */
    retainEntriesForDate(_date) {
        // intentionally empty — snapshot rows are already aggregated
    }

    /** Drop loaded snapshot state. */
    clear() {
        this._snapshot = null;
        this._entries = null;
        this._lastActivityAt = 0;
        this._snapshotMtimeMs = 0;
    }

    /** Expose the last-loaded snapshot for health/status UI. */
    getSnapshot() {
        return this._snapshot;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────

function _snapshotPath() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'code-usage-extension',
        'compact-snapshot.json',
    ]);
}

/**
 * Convert the snapshot's dailyUsage rows into the entry shape DataProcessor
 * expects. Each aggregated row becomes one pseudo-entry; DataProcessor's
 * per-day re-aggregation sums them back to the same totals. The CNY cost is
 * carried via _finalCostCNY so it is shown as-recorded (not re-valued by the
 * current exchange rate / multiplier).
 */
function _snapshotToEntries(snapshot) {
    const rows = snapshot?.dailyUsage || [];
    const out = [];
    for (const r of rows) {
        out.push({
            date: r.date,
            model: r.raw_model,
            _agent: r.agent,
            inputTokens: r.inputTokens || 0,
            outputTokens: r.outputTokens || 0,
            cacheReadTokens: r.cacheReadTokens || 0,
            cacheCreationTokens: r.cacheCreationTokens || 0,
            requestCount: r.requestCount || 1,
            // Locked-in CNY cost from the worker; DataProcessor._entryMetrics
            // recognises _finalCostCNY and bypasses re-valuation.
            _finalCostCNY: r.cost || 0,
            costUSD: null,
        });
    }
    return out;
}

function _isoToMs(iso) {
    if (!iso) return 0;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
}