// Agent source registry + thin DataSource facade.
//
// AGENT_CONFIGS describes where each supported coding agent stores its log
// data and how to parse a single record. The actual scanning, caching, and
// incremental parsing live in FileCacheManager — DataSource only forwards.
//
// Supported: Claude Code, Codex, Gemini, Kimi, OpenClaw, PI, Qwen, Copilot,
// Amp, CodeBuff, Kiro CLI, plus SQLite-backed agents (OpenCode, Goose,
// Hermes, Kilo)
// via the optional sqlite3 CLI.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { parseClaudeEntry } from './parsers.js';
import {
    parseCodexLine, parseGeminiFile, parseKimiLine,
    parseOpenClawLine, parsePILine, parseQwenLine,
    parseCopilotLine, parseAmpFile, parseCodeBuffFile,
    parseKiroCliSessionFile,
} from './parsers.js';
import { FileCacheManager } from './cacheManager.js';

function _expandHome(path) {
    if (!path) return path;
    if (path === '~') return GLib.get_home_dir();
    if (path.startsWith('~/')) {
        return GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]);
    }
    return path;
}

const AGENT_CONFIGS = {
    claude: {
        name: 'Claude Code',
        appType: 'claude',
        dirs: () => {
            const configDir = GLib.getenv('CLAUDE_CONFIG_DIR');
            const dirs = [];
            if (configDir) {
                for (const d of configDir.split(',')) {
                    dirs.push(GLib.build_filenamev([_expandHome(d.trim()), 'projects']));
                }
            }
            const xdg = _expandHome(GLib.getenv('XDG_CONFIG_HOME')) ||
                GLib.build_filenamev([GLib.get_home_dir(), '.config']);
            dirs.push(GLib.build_filenamev([xdg, 'claude', 'projects']));
            dirs.push(GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'projects']));
            return dirs;
        },
        pattern: /\.jsonl$/,
        parse: parseClaudeEntry,
        recursive: true,
    },
    codex: {
        name: 'Codex',
        appType: 'codex',
        dirs: () => {
            const home = _expandHome(GLib.getenv('CODEX_HOME')) || GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
            return [
                GLib.build_filenamev([home, 'sessions']),
                GLib.build_filenamev([home, 'archived_sessions']),
            ];
        },
        pattern: /\.jsonl$/,
        parse: parseCodexLine,
        recursive: true,
    },
    gemini: {
        name: 'Gemini CLI',
        appType: 'gemini',
        dirs: () => {
            const d = _expandHome(GLib.getenv('GEMINI_DATA_DIR')) || GLib.build_filenamev([GLib.get_home_dir(), '.gemini', 'tmp']);
            return [d];
        },
        pattern: /\.(json|jsonl)$/,
        parse: parseGeminiFile,
        recursive: true,
    },
    kimi: {
        name: 'Kimi',
        appType: 'kimi',
        dirs: () => {
            const d = _expandHome(GLib.getenv('KIMI_DATA_DIR')) || GLib.build_filenamev([GLib.get_home_dir(), '.kimi']);
            return [d];
        },
        pattern: /wire\.jsonl$/,
        parse: parseKimiLine,
        recursive: true,
    },
    openclaw: {
        name: 'OpenClaw',
        appType: 'openclaw',
        dirs: () => {
            const d = _expandHome(GLib.getenv('OPENCLAW_DIR')) || GLib.build_filenamev([GLib.get_home_dir(), '.openclaw']);
            return [d];
        },
        pattern: /\.jsonl$/,
        parse: parseOpenClawLine,
        recursive: true,
    },
    pi: {
        name: 'pi-agent',
        appType: 'pi',
        dirs: () => {
            const d = _expandHome(GLib.getenv('PI_AGENT_DIR')) || GLib.build_filenamev([GLib.get_home_dir(), '.pi', 'agent', 'sessions']);
            return [d];
        },
        pattern: /\.jsonl$/,
        parse: parsePILine,
        recursive: true,
    },
    qwen: {
        name: 'Qwen',
        appType: 'qwen',
        dirs: () => {
            const d = _expandHome(GLib.getenv('QWEN_DATA_DIR')) || GLib.build_filenamev([GLib.get_home_dir(), '.qwen']);
            return [d];
        },
        pattern: /\.jsonl$/,
        parse: parseQwenLine,
        recursive: true,
    },
    copilot: {
        name: 'GitHub Copilot CLI',
        appType: 'copilot',
        dirs: () => {
            const d = _expandHome(GLib.getenv('COPILOT_OTEL_FILE_EXPORTER_PATH'));
            if (d) return [d];
            const home = GLib.get_home_dir();
            return [
                GLib.build_filenamev([home, '.copilot', 'session-state']),
                GLib.build_filenamev([home, '.copilot', 'otel']),
            ];
        },
        pattern: /\.jsonl$/,
        parse: parseCopilotLine,
        recursive: true,
    },
    amp: {
        name: 'Amp',
        appType: 'amp',
        dirs: () => {
            const d = _expandHome(GLib.getenv('AMP_DATA_DIR')) || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'amp']);
            return [GLib.build_filenamev([d, 'threads'])];
        },
        pattern: /\.json$/,
        parse: parseAmpFile,
        recursive: false,
    },
    codebuff: {
        name: 'Codebuff',
        appType: 'codebuff',
        dirs: () => {
            const d = _expandHome(GLib.getenv('CODEBUFF_DATA_DIR'));
            const dirs = [];
            if (d) {
                dirs.push(GLib.build_filenamev([d, 'projects']));
            }
            dirs.push(GLib.build_filenamev([GLib.get_home_dir(), '.config', 'manicode', 'projects']));
            return dirs;
        },
        pattern: /^chat-messages\.json$/,
        parse: parseCodeBuffFile,
        recursive: true,
    },
    kiro: {
        name: 'Kiro CLI',
        appType: 'kiro',
        dirs: () => {
            const sessionsDir = GLib.getenv('KIRO_CLI_SESSIONS_DIR');
            if (sessionsDir) return [_expandHome(sessionsDir)];

            const kiroHome = _expandHome(GLib.getenv('KIRO_HOME')) ||
                GLib.build_filenamev([GLib.get_home_dir(), '.kiro']);
            return [GLib.build_filenamev([kiroHome, 'sessions', 'cli'])];
        },
        pattern: /\.json$/,
        parse: parseKiroCliSessionFile,
        recursive: false,
    },
    opencode: {
        name: 'OpenCode',
        appType: 'opencode',
        dirs: () => {
            const d = _expandHome(GLib.getenv('OPENCODE_DATA_DIR')) || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'opencode']);
            return [d];
        },
        pattern: null,
        sqlite: true,
        dbFiles: ['opencode.db', 'opencode-stable.db'],
    },
    goose: {
        name: 'Goose',
        appType: 'goose',
        dirs: () => {
            const root = _expandHome(GLib.getenv('GOOSE_PATH_ROOT')) || GLib.get_home_dir();
            const dirs = [];
            dirs.push(GLib.build_filenamev([root, '.local', 'share', 'goose', 'sessions']));
            dirs.push(GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'Block', 'goose', 'sessions']));
            return dirs;
        },
        pattern: null,
        sqlite: true,
        dbFiles: ['sessions.db'],
    },
    hermes: {
        name: 'Hermes',
        appType: 'hermes',
        dirs: () => {
            const base = _expandHome(GLib.getenv('HERMES_HOME')) || GLib.build_filenamev([GLib.get_home_dir(), '.hermes']);
            const dirs = [base];
            const profilesDir = GLib.build_filenamev([base, 'profiles']);
            const dir = Gio.File.new_for_path(profilesDir);
            if (dir.query_exists(null)) {
                try {
                    const enumerator = dir.enumerate_children(
                        'standard::name,standard::type',
                        Gio.FileQueryInfoFlags.NONE, null
                    );
                    let info;
                    try {
                        while ((info = enumerator.next_file(null)) !== null) {
                            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                                dirs.push(GLib.build_filenamev([profilesDir, info.get_name()]));
                            }
                        }
                    } finally {
                        try { enumerator.close(null); } catch (_e) { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
            return dirs;
        },
        pattern: null,
        sqlite: true,
        dbFiles: ['state.db'],
    },
    kilo: {
        name: 'Kilo',
        appType: 'kilo',
        dirs: () => {
            const d = _expandHome(GLib.getenv('KILO_DATA_DIR')) || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'kilo']);
            return [d];
        },
        pattern: null,
        sqlite: true,
        dbFiles: ['kilo.db'],
    },
};

export class DataSource {
    constructor(settings) {
        this._settings = settings;
        this._cache = new FileCacheManager(settings, AGENT_CONFIGS);
    }

    /**
     * Refresh the underlying file cache for the given agents. Returns
     * { changed, lastActivityAt } so callers can drive an active/idle
     * timer state machine without re-reading file metadata themselves.
     */
    async scanAndDiff(agents) {
        return this._cache.scanAndDiff(agents);
    }

    /**
     * Return the current merged entries snapshot. Cheap (memoised) when no
     * scan has invalidated it — this is what enables settings-only changes
     * (currency, sort, etc.) to skip IO entirely.
     */
    getEntries() {
        return this._cache.getMergedEntries();
    }

    /** Keep the live cache bounded to the current local day after archiving. */
    retainEntriesForDate(date) {
        this._cache.retainEntriesForDate(date);
    }

    /** Drop all cached state. Used when the agent set must be rescanned cold. */
    clearCache() {
        this._cache.clear();
    }
}

export { AGENT_CONFIGS };
