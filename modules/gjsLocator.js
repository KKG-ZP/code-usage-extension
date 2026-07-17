// Locate the gjs interpreter so the Shell extension can spawn a standalone
// worker subprocess (usage-worker.js) that runs heavy log parsing outside the
// GNOME Shell process. Mirrors parsers._findSqlite3()'s lookup strategy.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

let _gjsPath = null;
let _gjsChecked = false;

/**
 * Resolve the absolute path to the gjs interpreter. gjs ships with GNOME
 * Shell, so it is almost always present; we still probe $PATH and a few
 * fixed locations so non-standard installs work too. The result is cached.
 * Returns null if gjs cannot be found.
 */
export function findGjs() {
    if (_gjsChecked) return _gjsPath;
    _gjsChecked = true;

    const homeDir = GLib.get_home_dir();
    const candidates = new Set();

    // gjs is part of the GNOME Shell runtime; the canonical location is
    // /usr/bin/gjs (often a symlink to gjs-console).
    const systemPaths = [
        '/usr/bin/gjs',
        '/usr/local/bin/gjs',
        '/opt/homebrew/bin/gjs',
    ];
    for (const p of systemPaths) candidates.add(p);

    const pathEnv = GLib.getenv('PATH') || '';
    for (const p of pathEnv.split(':')) {
        if (p && p.trim()) {
            candidates.add(GLib.build_filenamev([p.trim(), 'gjs']));
        }
    }

    for (const sub of ['.local', 'bin']) {
        candidates.add(GLib.build_filenamev([homeDir, sub, 'bin', 'gjs']));
    }
    candidates.add(GLib.build_filenamev([homeDir, 'bin', 'gjs']));

    for (const candidate of candidates) {
        const file = Gio.File.new_for_path(candidate);
        if (file.query_exists(null)) {
            _gjsPath = candidate;
            break;
        }
    }

    return _gjsPath;
}