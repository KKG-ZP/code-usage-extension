# 代码用量监控

代码用量监控是一个 GNOME Shell 扩展，用于从本地编码代理日志中统计 API 使用情况，包括 Token 消耗、请求数、缓存命中率和费用估算。

## 功能特性

- 顶部面板实时显示 Token、费用或请求数。
- 弹出菜单展示总览、模型明细、缓存命中率和日期范围筛选。
- 支持活跃/空闲自适应刷新，减少无日志写入时的轮询开销。
- 支持多种 Token 显示格式、CNY/USD 费用显示和自定义模型价格。
- 提供发布包脚本，可生成最小可安装扩展包。

## 支持的数据源

当前支持 Claude Code、Codex、Gemini、Kimi、OpenClaw、pi-agent、Qwen、GitHub Copilot CLI、Amp、CodeBuff、OpenCode、Goose、Hermes、Kilo、ZCode 等编码代理。

OpenCode、Goose、Hermes、Kilo 和 ZCode 使用 SQLite 数据源，需要系统安装 `sqlite3` 命令行工具。ZCode 数据从 `~/.zcode/cli/db/db.sqlite` 读取。

ZCode 某些版本会将已完成请求的 Token 写成 0。此时扩展会自动读取 `~/.zcode/cli/rollout/model-io-*.jsonl` 中的实际请求负载作为回退估算，并在面板中以 `≈` 标记；数据库恢复有效数值后会自动优先使用精确统计。

## 版本兼容

本仓库按 GNOME Shell 扩展加载机制维护两个分支：

| 分支 | GNOME Shell 版本 | 发布包 | 说明 |
| --- | --- | --- | --- |
| `main` | 45-49 | `code-usage-extension-modern-v1.zip` | 现代版，使用 GNOME 45+ ES Module 扩展入口和 Libadwaita 设置页。 |
| `legacy/gnome-3.36-44` | 3.36、3.38、40-44 | `code-usage-extension-legacy-v1.zip` | 兼容版，使用旧式 `imports.*` 扩展入口和 GTK 设置页。 |

GNOME Shell 45 起扩展加载机制切换到 ES Module，旧版 Shell 无法解析现代版的 `import`/`export` 语法；GNOME Shell 3.36-44 请切换到 `legacy/gnome-3.36-44` 分支安装。

## 系统要求

- GNOME Shell 45-49（当前 `main` 分支）
- `glib-compile-schemas`
- 可选：`sqlite3`，仅 SQLite 数据源需要

## 安装

克隆仓库后运行：

```bash
./install.sh
```

然后重启 GNOME Shell 或注销后重新登录，并启用扩展：

```bash
gnome-extensions enable code-usage@gnome-extensions.local
```

也可以使用系统的“扩展”应用手动启用。

## 发布包

生成最小可安装发布包：

```bash
./release-package.sh
```

生成结果位于：

```text
dist/code-usage-extension-modern-v1.zip
```

发布包只包含运行时文件、安装脚本、许可文件和安装说明，不包含 `.git/`、`github/` 参考资料、翻译源文件或开发产物。

## 配置

在扩展设置页中可以配置：

- 要监控的编码代理源
- 面板显示模式和图标显示
- 日期范围
- 费用货币、汇率和成本倍率
- Token 显示格式
- 活跃/空闲刷新间隔
- 自定义模型价格覆盖

## 卸载

```bash
gnome-extensions disable code-usage@gnome-extensions.local
rm -rf ~/.local/share/gnome-shell/extensions/code-usage@gnome-extensions.local
```

然后重启 GNOME Shell 或重新登录。

## 许可

本项目使用 MIT License。详见 [LICENSE](LICENSE)。
