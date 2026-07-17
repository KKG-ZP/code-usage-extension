// Thin DataSource facade: spawns the standalone usage-worker subprocess and
// loads the compact snapshot it writes.
//
// AGENT_CONFIGS (where each agent stores its logs and how to parse a record)
// lives in agentConfigs.js, shared with the worker. The Shell never parses
// raw logs itself — DataSource just (a) launches the worker with the
// current settings as CLI args, (b) waits for it to finish, (c) reloads the
// snapshot via FileCacheManager.
//
// Supported: Claude Code, Codex, Gemini, Kimi, OpenClaw, PI, Qwen, Copilot,
// Amp, CodeBuff, Kiro CLI, plus SQLite-backed agents (OpenCode, Goose,
// Hermes, Kilo, ZCode) via the optional sqlite3 CLI.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { FileCacheManager } from './cacheManager.js';
import { AGENT_CONFIGS } from './agentConfigs.js';
import { findGjs } from './gjsLocator.js';

export class DataSource {
    constructor(settings, extensionPath) {
        this._settings = settings;
        this._extensionPath = extensionPath;
        this._cache = new FileCacheManager(settings, AGENT_CONFIGS);
        this._workerProc = null;
        this._workerRunning = false;
        // Serialise concurrent scanAndDiff calls so a timer tick + a
        // settings-triggered rescan don't race the snapshot reload.
        this._scanChain = Promise.resolve();
    }

    /**
     * Launch the worker subprocess (if not already running) to refresh the
     * snapshot, then reload it. Returns { changed, lastActivityAt }.
     * The worker runs out-of-process so heavy parsing never blocks the
     * Shell main loop; we only await its completion + the snapshot reload.
     */
    async scanAndDiff(agents) {
        const run = () => this._scanAndDiffImpl(agents);
        this._scanChain = this._scanChain.then(run, run);
        return this._scanChain;
    }

    async _scanAndDiffImpl(agents) {
        if (agents.length === 0) {
            this._cache.clear();
            return { changed: false, lastActivityAt: 0 };
        }
        await this._runWorker(agents);
        const changed = this._cache._maybeReloadSnapshot();
        return { changed, lastActivityAt: this._cache._lastActivityAt };
    }

    /**
     * Spawn the worker with current pricing/alias/currency settings as CLI
     * args (the worker is a separate process and can't read GSettings).
     * Resolves when the worker exits; if a worker is already running, the
     * call awaits the same in-flight run rather than spawning a second one.
     * On spawn failure (gjs not found) the snapshot is left as-is.
     */
    _runWorker(agents) {
        if (this._workerRunning) {
            return this._workerRunning;
        }
        const gjs = findGjs();
        if (!gjs) {
            console.error('Code Usage: gjs interpreter not found; cannot run usage worker');
            return Promise.resolve();
        }
        const workerScript = GLib.build_filenamev([
            this._extensionPath, 'worker', 'usage-worker.js']);
        const argv = [
            gjs, '-m', workerScript,
            '--extension-path', this._extensionPath,
            '--agents', agents.join(','),
            '--cost-multiplier', String(this._settings.get_double('cost-multiplier')),
            '--exchange-rate', String(this._settings.get_double('cny-exchange-rate')),
            '--price-overrides', this._settings.get_string('price-overrides'),
            '--model-aliases', this._settings.get_string('model-aliases'),
        ];
        if (this._settings.get_boolean('debug-mode')) argv.push('--debug');

        const promise = new Promise((resolve) => {
            let proc;
            try {
                proc = Gio.Subprocess.new(argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (e) {
                console.error(`Code Usage: worker spawn failed: ${e.message}`);
                resolve();
                return;
            }
            this._workerProc = proc;
            // communicate so the child's stdout/stderr pipes don't fill and
            // block it; we ignore the content (the snapshot is the source of
            // truth, not stdout).
            proc.communicate_utf8_async(null, null, (p, r) => {
                try {
                    const [ok, _stdout, stderr] = p.communicate_utf8_finish(r);
                    if (!ok && stderr && stderr.trim()) {
                        console.error(`Code Usage: worker stderr: ${stderr.trim()}`);
                    }
                } catch (e) {
                    console.error(`Code Usage: worker wait failed: ${e.message}`);
                }
                this._workerProc = null;
                resolve();
            });
        });
        this._workerRunning = promise;
        promise.finally(() => { if (this._workerRunning === promise) this._workerRunning = null; });
        return promise;
    }

    /**
     * Return the current merged entries snapshot. Cheap (memoised) when no
     * scan has invalidated it — this is what enables settings-only changes
     * (currency, sort, etc.) to skip IO entirely.
     */
    getEntries() {
        return this._cache.getMergedEntries();
    }

    /** Stage 4: raw aggregated dailyUsage rows from the snapshot. */
    getDailyUsage() {
        return this._cache.getDailyUsage();
    }

    /** No-op for API compatibility (snapshot is already bounded). */
    retainEntriesForDate(_date) {
        this._cache.retainEntriesForDate(_date);
    }

    /** Drop all cached state. */
    clearCache() {
        this._cache.clear();
    }

    /** Expose the last-loaded snapshot for health/status UI. */
    getSnapshot() {
        return this._cache.getSnapshot();
    }

    /**
     * Stage 5: watch the selected agents' log directories so a file change
     * can trigger an immediate incremental scan instead of waiting for the
     * next poll tick. `onDirty(dirtyAgents)` is called with the set of agent
     * ids whose directories saw a change; the caller debounces and calls
     * scanAndDiff(dirtyAgents). Monitors are re-created when the agent set
     * changes (call setupFileMonitors again).
     */
    setupFileMonitors(agents, onDirty) {
        this.destroyFileMonitors();
        if (!onDirty || agents.length === 0) return;
        this._fileMonitors = [];
        this._monitorDirtyAgents = new Set();
        this._monitorOnDirty = onDirty;
        const watchedDirs = new Set();
        for (const agent of agents) {
            const config = AGENT_CONFIGS[agent];
            if (!config) continue;
            const dirs = config.dirs();
            for (const dirPath of dirs) {
                // Dedupe: multiple agents may share a parent dir; one monitor
                // per directory is enough, but we track which agents it covers.
                if (watchedDirs.has(dirPath)) continue;
                watchedDirs.add(dirPath);
                const dir = Gio.File.new_for_path(dirPath);
                if (!dir.query_exists(null)) continue;
                try {
                    const monitor = dir.monitor_directory(
                        Gio.FileMonitorFlags.WATCH_MOVES, null);
                    monitor.set_rate_limit(2000);
                    const handlerId = monitor.connect('changed', (m, file, other, eventType) => {
                        // CHANGED/CREATED/MOVED/DELETED all indicate log activity.
                        if (eventType === Gio.FileMonitorEvent.CHANGED ||
                            eventType === Gio.FileMonitorEvent.CREATED ||
                            eventType === Gio.FileMonitorEvent.MOVED ||
                            eventType === Gio.FileMonitorEvent.DELETED ||
                            eventType === Gio.FileMonitorEvent.MOVED_IN ||
                            eventType === Gio.FileMonitorEvent.MOVED_OUT) {
                            this._monitorDirtyAgents.add(agent);
                            this._monitorOnDirty([...this._monitorDirtyAgents]);
                        }
                    });
                    this._fileMonitors.push({ monitor, handlerId });
                } catch (_e) {
                    // Some dirs may not be monitorable; the poll reconciliation
                    // timer is the fallback.
                }
            }
        }
    }

    destroyFileMonitors() {
        if (!this._fileMonitors) return;
        for (const { monitor, handlerId } of this._fileMonitors) {
            try { monitor.disconnect(handlerId); } catch (_e) {}
            try { monitor.cancel(); } catch (_e) {}
        }
        this._fileMonitors = null;
        this._monitorDirtyAgents = null;
        this._monitorOnDirty = null;
    }

    /**
     * Force-terminate any in-flight worker. Called on disable/destroy so
     * no scan outlives the extension.
     */
    cancelWorker() {
        if (this._workerProc) {
            try { this._workerProc.force_exit(); } catch (_e) { /* ignore */ }
        }
    }

    /** Clean up monitors + worker on destroy. */
    destroy() {
        this.destroyFileMonitors();
        this.cancelWorker();
    }
}

export { AGENT_CONFIGS };