// Direct local file data source - reads agent log files without ccusage dependency
// Supports: Claude Code, Codex, Gemini, Kimi, OpenClaw, PI, Qwen, Copilot, Amp, CodeBuff
// SQLite agents (OpenCode, Goose, Hermes, Kilo) via optional sqlite3 CLI

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { parseClaudeEntry } from './parsers.js';
import {
    parseCodexLine, parseGeminiFile, parseKimiLine,
    parseOpenClawLine, parsePILine, parseQwenLine,
    parseCopilotLine, parseAmpFile, parseCodeBuffFile,
    parseSQLiteAgent
} from './parsers.js';

const AGENT_CONFIGS = {
    claude: {
        name: 'Claude Code',
        appType: 'claude',
        dirs: () => {
            const configDir = GLib.getenv('CLAUDE_CONFIG_DIR');
            const dirs = [];
            if (configDir) {
                for (const d of configDir.split(',')) {
                    dirs.push(GLib.build_filenamev([d.trim(), 'projects']));
                }
            }
            const xdg = GLib.getenv('XDG_CONFIG_HOME') ||
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
            const home = GLib.getenv('CODEX_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
            return [GLib.build_filenamev([home, 'sessions'])];
        },
        pattern: /\.jsonl$/,
        parse: parseCodexLine,
        recursive: false,
    },
    gemini: {
        name: 'Gemini CLI',
        appType: 'gemini',
        dirs: () => {
            const d = GLib.getenv('GEMINI_DATA_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.gemini', 'tmp']);
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
            const d = GLib.getenv('KIMI_DATA_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.kimi']);
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
            const d = GLib.getenv('OPENCLAW_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.openclaw']);
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
            const d = GLib.getenv('PI_AGENT_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.pi', 'agent', 'sessions']);
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
            const d = GLib.getenv('QWEN_DATA_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.qwen']);
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
            const d = GLib.getenv('COPILOT_OTEL_FILE_EXPORTER_PATH');
            if (d) return [d];
            return [GLib.build_filenamev([GLib.get_home_dir(), '.copilot', 'otel'])];
        },
        pattern: /\.jsonl$/,
        parse: parseCopilotLine,
        recursive: true,
    },
    amp: {
        name: 'Amp',
        appType: 'amp',
        dirs: () => {
            const d = GLib.getenv('AMP_DATA_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'amp']);
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
            const d = GLib.getenv('CODEBUFF_DATA_DIR');
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
    opencode: {
        name: 'OpenCode',
        appType: 'opencode',
        dirs: () => {
            const d = GLib.getenv('OPENCODE_DATA_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'opencode']);
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
            const root = GLib.getenv('GOOSE_PATH_ROOT') || GLib.get_home_dir();
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
            const d = GLib.getenv('HERMES_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.hermes']);
            return [d];
        },
        pattern: null,
        sqlite: true,
        dbFiles: ['state.db'],
    },
    kilo: {
        name: 'Kilo',
        appType: 'kilo',
        dirs: () => {
            const d = GLib.getenv('KILO_DATA_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'kilo']);
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
        this._debug = settings.get_boolean('debug-mode');
    }

    async fetchAgentData(agent) {
        const config = AGENT_CONFIGS[agent];
        if (!config) return [];

        if (config.sqlite) {
            return this._fetchSQLiteAgent(agent, config);
        }

        if (!config.parse) {
            if (this._debug) console.log(`Code Usage: No parser for agent ${agent}`);
            return [];
        }

        const entries = [];
        const dirs = config.dirs();

        for (const dirPath of dirs) {
            const files = this._scanFiles(dirPath, config.pattern, config.recursive);
            for (const filePath of files) {
                try {
                    const content = this._readFile(filePath);
                    if (!content) continue;

                    if (config.parse === parseGeminiFile || config.parse === parseAmpFile || config.parse === parseCodeBuffFile) {
                        const parsed = config.parse(content, filePath, agent);
                        entries.push(...parsed);
                    } else {
                        const lines = content.split('\n');
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed) continue;
                            const entry = config.parse(trimmed, filePath);
                            if (entry) entries.push(entry);
                        }
                    }
                } catch (e) {
                    if (this._debug) console.log(`Code Usage: Error reading ${filePath}: ${e.message}`);
                }
            }
        }

        return entries;
    }

    async fetchMultiAgentData(agents) {
        const allEntries = [];
        for (const agent of agents) {
            try {
                const entries = await this.fetchAgentData(agent);
                for (const entry of entries) {
                    entry._agent = agent;
                    allEntries.push(entry);
                }
            } catch (e) {
                if (this._debug) console.log(`Code Usage: Failed to fetch ${agent}: ${e.message}`);
            }
        }
        return allEntries;
    }

    async _fetchSQLiteAgent(agent, config) {
        const dirs = config.dirs();
        const entries = [];

        for (const dirPath of dirs) {
            for (const dbFile of config.dbFiles) {
                const dbPath = GLib.build_filenamev([dirPath, dbFile]);
                const file = Gio.File.new_for_path(dbPath);
                if (!file.query_exists(null)) continue;

                try {
                    const result = await parseSQLiteAgent(agent, dbPath, config);
                    entries.push(...result);
                } catch (e) {
                    if (this._debug) console.log(`Code Usage: SQLite error for ${agent}: ${e.message}`);
                }
            }
        }

        return entries;
    }

    _scanFiles(dirPath, pattern, recursive) {
        const files = [];
        const dir = Gio.File.new_for_path(dirPath);
        if (!dir.query_exists(null)) return files;

        try {
            const enumerator = dir.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                const child = enumerator.get_child(info);
                const path = child.get_path();

                if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                    if (recursive) {
                        files.push(...this._scanFiles(path, pattern, true));
                    }
                } else if (info.get_file_type() === Gio.FileType.REGULAR) {
                    if (pattern && pattern.test(name)) {
                        files.push(path);
                    }
                }
            }
            enumerator.close(null);
        } catch (e) {
            if (this._debug) console.log(`Code Usage: Error scanning ${dirPath}: ${e.message}`);
        }

        return files;
    }

    _readFile(filePath) {
        try {
            const file = Gio.File.new_for_path(filePath);
            const [ok, contents] = file.load_contents(null);
            if (!ok) return null;
            const decoder = new TextDecoder('utf-8');
            return decoder.decode(contents);
        } catch (e) {
            if (this._debug) console.log(`Code Usage: Error reading file ${filePath}: ${e.message}`);
            return null;
        }
    }
}

export { AGENT_CONFIGS };