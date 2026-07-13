import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { DEFAULT_PRICING, SUPPORTED_AGENTS } from './modules/defaultPricing.js';

export default class CodeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page1 = new Adw.PreferencesPage({
            title: _('通用'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page1);

        this._buildGeneralPage(page1, settings);
        this._buildAgentPage(page1, settings);

        const page2 = new Adw.PreferencesPage({
            title: _('模型定价'),
            icon_name: 'preferences-volumes-symbolic',
        });
        window.add(page2);
        this._buildPricingPage(page2, settings, window);

        const page3 = new Adw.PreferencesPage({
            title: _('高级'),
            icon_name: 'preferences-other-symbolic',
        });
        window.add(page3);
        this._buildAdvancedPage(page3, settings);
    }

    _buildGeneralPage(page, settings) {
        const generalGroup = new Adw.PreferencesGroup({
            title: _('刷新间隔'),
            description: _('自适应轮询：检测到 agent 日志最近 2 分钟内有写入时使用活跃间隔，否则切换到空闲间隔。'),
        });
        page.add(generalGroup);

        const activeRow = new Adw.SpinRow({
            title: _('活跃刷新间隔'),
            subtitle: _('agent 正在写入日志时的轮询间隔（秒，5–300）'),
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 300,
                step_increment: 5,
                page_increment: 30,
                value: settings.get_int('active-refresh-interval'),
            }),
        });
        settings.bind('active-refresh-interval', activeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(activeRow);

        const idleRow = new Adw.SpinRow({
            title: _('空闲刷新间隔'),
            subtitle: _('日志静默时的轮询间隔（秒，30–3600）'),
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 3600,
                step_increment: 30,
                page_increment: 300,
                value: settings.get_int('idle-refresh-interval'),
            }),
        });
        settings.bind('idle-refresh-interval', idleRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(idleRow);

        const displayGroup = new Adw.PreferencesGroup({
            title: _('面板显示'),
            description: _('配置顶部面板的显示内容'),
        });
        page.add(displayGroup);

        const displayModeRow = new Adw.ComboRow({
            title: _('显示模式'),
            subtitle: _('选择面板显示的内容'),
        });
        const displayModeModel = new Gtk.StringList();
        displayModeModel.append(_('Token 数'));
        displayModeModel.append(_('费用'));
        displayModeModel.append(_('请求数'));
        displayModeModel.append(_('全部'));
        displayModeRow.set_model(displayModeModel);

        const currentMode = settings.get_string('display-mode');
        // 'both' is the legacy value (originally tokens+cost). It now maps
        // to 'all' (tokens · cost · requests) so existing users get the
        // expanded composite display without losing their selection.
        const modeIndex = currentMode === 'cost' ? 1
            : currentMode === 'requests' ? 2
            : (currentMode === 'all' || currentMode === 'both') ? 3
            : 0;
        displayModeRow.set_selected(modeIndex);

        displayModeRow.connect('notify::selected', () => {
            const selected = displayModeRow.get_selected();
            const modes = ['tokens', 'cost', 'requests', 'all'];
            settings.set_string('display-mode', modes[selected]);
        });
        displayGroup.add(displayModeRow);

        const showIconRow = new Adw.SwitchRow({
            title: _('显示图标'),
            subtitle: _('在顶部面板显示扩展图标'),
        });
        settings.bind('show-icon', showIconRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(showIconRow);

        const positionRow = new Adw.ComboRow({
            title: _('面板位置'),
            subtitle: _('选择扩展图标在顶部面板中的位置'),
        });
        const positionModel = new Gtk.StringList();
        positionModel.append(_('靠右'));
        positionModel.append(_('靠左'));
        positionModel.append(_('居中'));
        positionModel.append(_('最右'));
        positionModel.append(_('最左'));
        positionRow.set_model(positionModel);

        const currentPos = settings.get_string('panel-position');
        const posIndex = currentPos === 'left' ? 1 : currentPos === 'center' ? 2
            : currentPos === 'far-right' ? 3 : currentPos === 'far-left' ? 4 : 0;
        positionRow.set_selected(posIndex);

        positionRow.connect('notify::selected', () => {
            const positions = ['right', 'left', 'center', 'far-right', 'far-left'];
            settings.set_string('panel-position', positions[positionRow.get_selected()]);
        });
        displayGroup.add(positionRow);

        const dateGroup = new Adw.PreferencesGroup({
            title: _('日期范围'),
            description: _('选择统计数据的日期范围'),
        });
        page.add(dateGroup);

        const datePresetRow = new Adw.ComboRow({
            title: _('日期预设'),
            subtitle: _('快速选择日期范围'),
        });
        const datePresetModel = new Gtk.StringList();
        datePresetModel.append(_('今天'));
        datePresetModel.append(_('最近7天'));
        datePresetModel.append(_('最近30天'));
        datePresetModel.append(_('自定义'));
        datePresetRow.set_model(datePresetModel);

        const currentPreset = settings.get_string('date-range-preset');
        const presetIndex = currentPreset === '7d' ? 1 : currentPreset === '30d' ? 2 : currentPreset === 'custom' ? 3 : 0;
        datePresetRow.set_selected(presetIndex);

        datePresetRow.connect('notify::selected', () => {
            const presets = ['today', '7d', '30d', 'custom'];
            settings.set_string('date-range-preset', presets[datePresetRow.get_selected()]);
        });
        dateGroup.add(datePresetRow);

        const sinceRow = new Adw.EntryRow({
            title: _('起始日期 (YYYY-MM-DD)'),
            show_apply_button: true,
        });
        sinceRow.set_text(settings.get_string('custom-date-since'));
        sinceRow.connect('apply', () => {
            const text = sinceRow.get_text().trim();
            // Reject malformed dates so the downstream string comparison in
            // DataProcessor._buildDateFilter stays meaningful.
            if (text && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return;
            settings.set_string('custom-date-since', text);
        });
        dateGroup.add(sinceRow);

        const untilRow = new Adw.EntryRow({
            title: _('截止日期 (YYYY-MM-DD)'),
            show_apply_button: true,
        });
        untilRow.set_text(settings.get_string('custom-date-until'));
        untilRow.connect('apply', () => {
            const text = untilRow.get_text().trim();
            if (text && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return;
            settings.set_string('custom-date-until', text);
        });
        dateGroup.add(untilRow);
    }

    _buildAgentPage(page, settings) {
        const agentGroup = new Adw.PreferencesGroup({
            title: _('代理源'),
            description: _('选择要监控的编码代理（从本地日志文件读取数据）'),
        });
        page.add(agentGroup);

        const selectedAgents = settings.get_strv('selected-agents');

        for (const agent of SUPPORTED_AGENTS) {
            const row = new Adw.ActionRow({
                title: agent.name,
                subtitle: agent.id,
            });

            const check = new Gtk.CheckButton({
                active: selectedAgents.includes(agent.id),
            });
            check.connect('notify::active', () => {
                const current = settings.get_strv('selected-agents');
                if (check.active) {
                    if (!current.includes(agent.id)) {
                        current.push(agent.id);
                    }
                } else {
                    const idx = current.indexOf(agent.id);
                    if (idx >= 0) {
                        current.splice(idx, 1);
                    }
                }
                settings.set_strv('selected-agents', current);
            });

            row.add_suffix(check);
            row.activatable_widget = check;
            agentGroup.add(row);
        }

        const multiplierGroup = new Adw.PreferencesGroup({
            title: _('成本计算'),
            description: _('配置成本倍率和换算'),
        });
        page.add(multiplierGroup);

        const multiplierRow = new Adw.SpinRow({
            title: _('成本倍率'),
            subtitle: _('应用于总成本的倍率（用于加价或折扣）'),
            adjustment: new Gtk.Adjustment({
                lower: 0.1,
                upper: 10,
                step_increment: 0.1,
                page_increment: 1,
                value: settings.get_double('cost-multiplier'),
            }),
            digits: 2,
        });
        settings.bind('cost-multiplier', multiplierRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        multiplierGroup.add(multiplierRow);
    }

    _buildPricingPage(page, settings, window) {
        const infoGroup = new Adw.PreferencesGroup({
            title: _('模型定价'),
            description: _('管理模型价格覆盖。自定义定价优先于内置默认定价。'),
        });
        page.add(infoGroup);

        const overrideList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });
        infoGroup.add(overrideList);

        const renderPricingList = () => {
            let child;
            while ((child = overrideList.get_first_child()) !== null) {
                overrideList.remove(child);
            }

            let overrides = {};
            try {
                overrides = JSON.parse(settings.get_string('price-overrides') || '{}');
            } catch (e) { /* ignore */ }

            const keys = Object.keys(overrides).sort();
            for (const modelId of keys) {
                const pricing = overrides[modelId];
                const row = new Adw.ActionRow({
                    title: pricing.displayName || modelId,
                    subtitle: _(`输入 $${pricing.input}/M  输出 $${pricing.output}/M  缓存读 $${pricing.cacheRead || 0}/M  缓存写 $${pricing.cacheWrite || 0}/M`),
                });

                const deleteBtn = new Gtk.Button({
                    icon_name: 'edit-delete-symbolic',
                    css_classes: ['destructive-action', 'circular'],
                    valign: Gtk.Align.CENTER,
                });
                deleteBtn.connect('clicked', () => {
                    const current = JSON.parse(settings.get_string('price-overrides') || '{}');
                    delete current[modelId];
                    settings.set_string('price-overrides', JSON.stringify(current));
                    renderPricingList();
                });

                row.add_suffix(deleteBtn);
                overrideList.append(row);
            }

            if (keys.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: _('暂无自定义定价'),
                    subtitle: _('点击下方按钮添加模型定价'),
                });
                emptyRow.set_sensitive(false);
                overrideList.append(emptyRow);
            }
        };

        renderPricingList();
        // settings is a schema-level singleton that outlives the prefs
        // window. If we don't disconnect on close, every open/close cycle
        // stacks another handler that captures the destroyed overrideList.
        const priceOverridesId = settings.connect('changed::price-overrides', renderPricingList);
        window.connect('close-request', () => {
            try { settings.disconnect(priceOverridesId); } catch (_e) { /* ignore */ }
        });

        const addActionGroup = new Adw.PreferencesGroup({});
        page.add(addActionGroup);

        const addRow = new Adw.ActionRow({
            title: _('添加模型定价'),
            icon_name: 'list-add-symbolic',
        });
        addRow.connect('activated', () => {
            this._openPricingDialog(window, settings, null, renderPricingList);
        });
        addActionGroup.add(addRow);

        const defaultsGroup = new Adw.PreferencesGroup({
            title: _('内置默认定价'),
            description: _('扩展内置了 90+ 个模型的默认定价，无需手动配置。仅当需要覆盖特定模型价格时才添加自定义定价。'),
        });
        page.add(defaultsGroup);

        const resetRow = new Adw.ActionRow({
            title: _('重置所有自定义定价'),
            subtitle: _('删除所有自定义定价覆盖，恢复使用默认定价'),
            icon_name: 'edit-undo-symbolic',
        });
        resetRow.connect('activated', () => {
            settings.set_string('price-overrides', '{}');
            renderPricingList();
        });
        defaultsGroup.add(resetRow);
    }

    _openPricingDialog(parentWindow, settings, existingModel, refreshCallback) {
        const dialog = new Adw.Dialog({
            title: existingModel ? _('编辑模型定价') : _('添加模型定价'),
            content_width: 400,
            content_height: 500,
        });

        const page = new Adw.PreferencesPage({});
        const group = new Adw.PreferencesGroup({});
        page.add(group);
        dialog.set_child(page);

        const modelIdRow = new Adw.EntryRow({
            title: _('模型 ID'),
        });
        if (existingModel) {
            modelIdRow.set_text(existingModel);
            modelIdRow.set_sensitive(false);
        }
        group.add(modelIdRow);

        const displayNameRow = new Adw.EntryRow({
            title: _('显示名称'),
        });
        group.add(displayNameRow);

        const inputRow = new Adw.SpinRow({
            title: _('输入价格 ($/M tokens)'),
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 1000, step_increment: 0.01, page_increment: 1, value: 0,
            }),
            digits: 4,
        });
        group.add(inputRow);

        const outputRow = new Adw.SpinRow({
            title: _('输出价格 ($/M tokens)'),
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 1000, step_increment: 0.01, page_increment: 1, value: 0,
            }),
            digits: 4,
        });
        group.add(outputRow);

        const cacheReadRow = new Adw.SpinRow({
            title: _('缓存读价格 ($/M tokens)'),
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 1000, step_increment: 0.01, page_increment: 1, value: 0,
            }),
            digits: 4,
        });
        group.add(cacheReadRow);

        const cacheWriteRow = new Adw.SpinRow({
            title: _('缓存写价格 ($/M tokens)'),
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 1000, step_increment: 0.01, page_increment: 1, value: 0,
            }),
            digits: 4,
        });
        group.add(cacheWriteRow);

        if (existingModel) {
            let overrides = {};
            try {
                overrides = JSON.parse(settings.get_string('price-overrides') || '{}');
            } catch (e) { /* ignore */ }
            const pricing = overrides[existingModel];
            if (pricing) {
                displayNameRow.set_text(pricing.displayName || '');
                inputRow.set_value(pricing.input || 0);
                outputRow.set_value(pricing.output || 0);
                cacheReadRow.set_value(pricing.cacheRead || 0);
                cacheWriteRow.set_value(pricing.cacheWrite || 0);
            }
        }

        modelIdRow.connect('apply', () => {
            const id = modelIdRow.get_text().trim();
            if (DEFAULT_PRICING[id] && !existingModel) {
                const p = DEFAULT_PRICING[id];
                displayNameRow.set_text(p.displayName || id);
                inputRow.set_value(p.input || 0);
                outputRow.set_value(p.output || 0);
                cacheReadRow.set_value(p.cacheRead || 0);
                cacheWriteRow.set_value(p.cacheWrite || 0);
            }
        });

        const saveGroup = new Adw.PreferencesGroup({});
        page.add(saveGroup);
        const saveBtn = new Gtk.Button({
            label: _('保存'),
            css_classes: ['suggested-action', 'pill'],
            halign: Gtk.Align.CENTER,
        });
        saveBtn.connect('clicked', () => {
            const modelId = existingModel || modelIdRow.get_text().trim();
            if (!modelId) return;

            let overrides = {};
            try {
                overrides = JSON.parse(settings.get_string('price-overrides') || '{}');
            } catch (e) { /* ignore */ }

            overrides[modelId] = {
                displayName: displayNameRow.get_text().trim() || modelId,
                input: parseFloat(inputRow.get_value().toFixed(4)),
                output: parseFloat(outputRow.get_value().toFixed(4)),
                cacheRead: parseFloat(cacheReadRow.get_value().toFixed(4)),
                cacheWrite: parseFloat(cacheWriteRow.get_value().toFixed(4)),
            };

            settings.set_string('price-overrides', JSON.stringify(overrides));
            if (refreshCallback) refreshCallback();
            dialog.close();
        });
        saveGroup.add(saveBtn);

        dialog.present(parentWindow);
    }

    _buildAdvancedPage(page, settings) {
        const displayGroup = new Adw.PreferencesGroup({
            title: _('显示设置'),
            description: _('配置数据显示格式和货币'),
        });
        page.add(displayGroup);

        const currencyRow = new Adw.ComboRow({
            title: _('货币'),
            subtitle: _('选择费用显示的货币'),
        });
        const currencyModel = new Gtk.StringList();
        currencyModel.append('CNY (¥)');
        currencyModel.append('USD ($)');
        currencyRow.set_model(currencyModel);
        currencyRow.set_selected(settings.get_string('cost-currency') === 'USD' ? 1 : 0);
        currencyRow.connect('notify::selected', () => {
            settings.set_string('cost-currency', currencyRow.get_selected() === 1 ? 'USD' : 'CNY');
        });
        displayGroup.add(currencyRow);

        const cnyRateRow = new Adw.SpinRow({
            title: _('CNY 汇率'),
            subtitle: _('1 USD 等于多少 CNY'),
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 20, step_increment: 0.01, page_increment: 0.5,
                value: settings.get_double('cny-exchange-rate'),
            }),
            digits: 2,
        });
        settings.bind('cny-exchange-rate', cnyRateRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(cnyRateRow);

        const tokenFormatRow = new Adw.ComboRow({
            title: _('Token 显示格式'),
            subtitle: _('选择 Token 数量的显示方式'),
        });
        const tokenFormatModel = new Gtk.StringList();
        tokenFormatModel.append(_('自动（K/M/B 缩写）'));
        tokenFormatModel.append(_('始终使用 K'));
        tokenFormatModel.append(_('始终使用 M'));
        tokenFormatModel.append(_('始终使用 B'));
        tokenFormatModel.append(_('原始数值'));
        tokenFormatRow.set_model(tokenFormatModel);
        const currentFormat = settings.get_string('token-display-format');
        const formatIndex = currentFormat === 'K' ? 1
            : currentFormat === 'M' ? 2
            : currentFormat === 'B' ? 3
            : currentFormat === 'raw' ? 4
            : 0;
        tokenFormatRow.set_selected(formatIndex);
        tokenFormatRow.connect('notify::selected', () => {
            const formats = ['auto', 'K', 'M', 'B', 'raw'];
            settings.set_string('token-display-format', formats[tokenFormatRow.get_selected()]);
        });
        displayGroup.add(tokenFormatRow);

        const sortOrderRow = new Adw.ComboRow({
            title: _('日期排序'),
            subtitle: _('日期数据的排列顺序'),
        });
        const sortModel = new Gtk.StringList();
        sortModel.append(_('降序（最新在前）'));
        sortModel.append(_('升序（最旧在前）'));
        sortOrderRow.set_model(sortModel);
        sortOrderRow.set_selected(settings.get_string('sort-order') === 'asc' ? 1 : 0);
        sortOrderRow.connect('notify::selected', () => {
            settings.set_string('sort-order', sortOrderRow.get_selected() === 1 ? 'asc' : 'desc');
        });
        displayGroup.add(sortOrderRow);

        const modelSortByRow = new Adw.ComboRow({
            title: _('模型排序'),
            subtitle: _('模型列表的排序依据'),
        });
        const modelSortModel = new Gtk.StringList();
        modelSortModel.append(_('金额（从高到低）'));
        modelSortModel.append(_('使用总量（从多到少）'));
        modelSortModel.append(_('命中率（从高到低）'));
        modelSortModel.append(_('请求数（从多到少）'));
        modelSortByRow.set_model(modelSortModel);
        const modelSortOptions = ['cost', 'totalTokens', 'cacheHitRate', 'requestCount'];
        const currentModelSort = settings.get_string('model-sort-by');
        const modelSortIndex = modelSortOptions.indexOf(currentModelSort);
        modelSortByRow.set_selected(modelSortIndex >= 0 ? modelSortIndex : 0);
        modelSortByRow.connect('notify::selected', () => {
            settings.set_string('model-sort-by', modelSortOptions[modelSortByRow.get_selected()]);
        });
        displayGroup.add(modelSortByRow);

        const debugGroup = new Adw.PreferencesGroup({
            title: _('调试'),
            description: _('调试选项'),
        });
        page.add(debugGroup);

        const debugRow = new Adw.SwitchRow({
            title: _('调试模式'),
            subtitle: _('在日志中输出调试信息（使用 journalctl -f -o cat 查看）'),
        });
        settings.bind('debug-mode', debugRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        debugGroup.add(debugRow);
    }
}
