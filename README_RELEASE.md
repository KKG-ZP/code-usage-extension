# 代码用量监控 - 发布包安装说明

## 功能简介

代码用量监控是一个 GNOME Shell 扩展，用于从本地编码代理日志中统计 API 使用情况，包括 Token 消耗、请求数、缓存命中率和费用估算。支持 Claude Code、Codex、Gemini、Kimi、Qwen、GitHub Copilot CLI、OpenCode、Goose、Hermes、Kilo 等代理源。

## 系统要求

- GNOME Shell 3.36、3.38、40-44
- `glib-compile-schemas`（通常随 GNOME/GLib 安装）
- 可选：`sqlite3`，仅 OpenCode、Goose、Hermes、Kilo 等 SQLite 数据源需要

这是 legacy 发布包，仅适用于 GNOME Shell 3.36、3.38、40-44。GNOME Shell 45-49 请使用 `main` 分支生成的 modern 发布包。

## 安装步骤

1. 解压发布包。
2. 在解压目录运行：

```bash
./install.sh
```

3. 重启 GNOME Shell 或注销后重新登录。
4. 启用扩展：

```bash
gnome-extensions enable code-usage@gnome-extensions.local
```

也可以使用系统的“扩展”应用手动启用。

## 使用方式

- 顶部面板会显示当前统计值。
- 点击面板项可查看请求数、Token、费用和模型明细。
- 在扩展设置页中可以选择要监控的代理源、日期范围、显示格式、货币和刷新间隔。

## 可选依赖

如果需要读取 OpenCode、Goose、Hermes 或 Kilo 的 SQLite 数据，请安装 `sqlite3`：

```bash
sudo apt install sqlite3
```

其他发行版请使用对应的软件包管理器安装。

## 卸载方式

```bash
gnome-extensions disable code-usage@gnome-extensions.local
rm -rf ~/.local/share/gnome-shell/extensions/code-usage@gnome-extensions.local
```

然后重启 GNOME Shell 或重新登录。

## 常见问题

- 面板没有数据：确认已在设置中选择对应代理源，并且该代理已经生成本地日志。
- SQLite 代理无数据：确认已安装 `sqlite3`，并且对应代理数据库存在。
- 设置不生效：重启 GNOME Shell 或注销后重新登录。
