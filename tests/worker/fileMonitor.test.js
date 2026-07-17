// Stage-5 FileMonitor integration test.
//
// Verifies that DataSource.setupFileMonitors fires the onDirty callback when
// a watched log file is appended, and that a debounced scan then reloads the
// snapshot with the appended data. Uses a temp CODEX_HOME so the worker
// scans our fake log instead of the user's real ~/.codex.
//
// Run with: gjs -m tests/worker/fileMonitor.test.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const _src = Gio.File.new_for_uri(import.meta.url);
// tests/worker/fileMonitor.test.js → worker/ → tests/ → repo root (3 hops)
const REPO_ROOT = _src.get_parent().get_parent().get_parent().get_path();
// Resolve the module graph via file:// URIs (computed once, then used in
// static import statements below). We can't use template strings in an
// import spec, so the path is hard-coded relative to this file via the
// standard relative-import form, which gjs -m resolves correctly from the
// script's own location.
import { DataSource } from '../../modules/dataSource.js';
import { writeSnapshot } from '../../worker/snapshot.js';

const TEXT_ENCODER = new TextEncoder();
const SNAPSHOT_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'code-usage-extension']);

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function removeTree(path) {
    const f = Gio.File.new_for_path(path);
    if (!f.query_exists(null)) return;
    try {
        const info = f.query_info('standard::type', Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            const en = f.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let child;
            try { while ((child = en.next_file(null)) !== null) removeTree(f.get_child(child.get_name()).get_path()); }
            finally { en.close(null); }
        }
    } catch (_e) {}
    try { f.delete(null); } catch (_e) {}
}
function cleanArtifacts() {
    for (const f of ['compact-snapshot.json', 'file-state.json']) {
        try { Gio.File.new_for_path(GLib.build_filenamev([SNAPSHOT_DIR, f])).delete(null); } catch (_e) {}
    }
}
function readJson(path) {
    try {
        const [ok, c] = Gio.File.new_for_path(path).load_contents(null);
        return ok ? JSON.parse(new TextDecoder().decode(c)) : null;
    } catch (_e) { return null; }
}

// Codex-format lines.
function ctx(model) {
    return JSON.stringify({ type: 'turn_context', payload: { type: 'turn_context', model } });
}
function tc(date, model, input, output, cached) {
    const info = { last_token_usage: { input_tokens: input, output_tokens: output } };
    if (cached != null) info.last_token_usage.cached_input_tokens = cached;
    if (model) info.model = model;
    return JSON.stringify({ type: 'event_msg', timestamp: `${date}T10:00:00Z`, payload: { type: 'token_count', info } });
}

async function main() {
    const root = GLib.dir_make_tmp('code-usage-fm-XXXXXX');
    try {
        const codexHome = GLib.build_filenamev([root, 'codex']);
        const sessionsDir = GLib.build_filenamev([codexHome, 'sessions']);
        GLib.mkdir_with_parents(sessionsDir, 0o755);
        const logPath = GLib.build_filenamev([sessionsDir, 'rollout-fm.jsonl']);
        // Seed the log with a turn_context + one token_count record.
        GLib.file_set_contents(logPath, TEXT_ENCODER.encode(
            ctx('gpt-5.5-codex') + '\n' + tc('2026-07-15', 'gpt-5.5-codex', 1000, 500, 200) + '\n'));

        const settings = {
            get_double: (k) => k === 'cny-exchange-rate' ? 7.25 : 1.0,
            get_string: (k) => k === 'price-overrides' || k === 'model-aliases' ? '{}' : '',
            get_boolean: () => false,
            get_int: (k) => 300,
        };
        // Point the worker at our temp CODEX_HOME via env. DataSource
        // doesn't set env itself, so we wrap scanAndDiff in an env override
        // by setting it on the process before spawning — easier: set it now.
        GLib.setenv('CODEX_HOME', codexHome, true);

        const ds = new DataSource(settings, REPO_ROOT);

        // 1. Initial full scan produces a 1-row snapshot.
        const r0 = await ds.scanAndDiff(['codex']);
        let snap = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'compact-snapshot.json']));
        assert(snap && snap.dailyUsage.length === 1, `initial rows: ${snap?.dailyUsage?.length}`);

        // 2. Set up FileMonitors; append a record; expect onDirty to fire.
        let dirtyFired = false;
        const dirtyPromise = new Promise((resolve) => {
            ds.setupFileMonitors(['codex'], (dirtyAgents) => {
                dirtyFired = true;
                resolve(dirtyAgents);
            });
        });

        // Append a second record (true append, preserves inode).
        const s = Gio.File.new_for_path(logPath).append_to(Gio.FileCreateFlags.NONE, null);
        s.write_all(TEXT_ENCODER.encode(tc('2026-07-16', 'gpt-5.5-codex', 500, 200, 50) + '\n'), null);
        s.close(null);

        // FileMonitor fires asynchronously; wait up to 5s.
        const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            if (!dirtyFired) resolve([]); // resolve with empty to unblock
            return GLib.SOURCE_REMOVE;
        });
        const dirtyAgents = await dirtyPromise;
        GLib.source_remove(timer);
        assert(dirtyFired, 'FileMonitor should fire onDirty when a log file is appended');
        assert(dirtyAgents.includes('codex'), `dirty agents should include codex: ${dirtyAgents}`);

        // 3. Simulate the panelIndicator debounce + scan: scan the dirty
        //    agents, reload snapshot — should now have 2 rows.
        await ds.scanAndDiff(dirtyAgents);
        snap = readJson(GLib.build_filenamev([SNAPSHOT_DIR, 'compact-snapshot.json']));
        assert(snap && snap.dailyUsage.length === 2, `after dirty scan rows: ${snap?.dailyUsage?.length}`);

        ds.destroy();
        print('fileMonitor tests passed');
    } finally {
        removeTree(root);
        cleanArtifacts();
        GLib.unsetenv('CODEX_HOME');
    }
}

const loop = GLib.MainLoop.new(null, false);
main().then(() => loop.quit())
    .catch((e) => { console.error(`fileMonitor tests FAILED: ${e.message}`); loop.quit(); });
loop.run();