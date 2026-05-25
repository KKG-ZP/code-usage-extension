import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { DataSource } from './dataSource.js';
import { DataProcessor } from './dataProcessor.js';

let _ = (s) => s;

export function setGettext(fn) {
    _ = fn;
}

const DATE_PRESETS = [
    { id: 'today', label: _('今天') },
    { id: '7d', label: _('7天') },
    { id: '30d', label: _('30天') },
];

export const CodeUsageIndicator = GObject.registerClass(
class CodeUsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, _('代码用量监控'));

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._dataSource = new DataSource(settings);
        this._processor = new DataProcessor(settings);
        this._lastData = null;
        this._refreshing = false;

        this._box = new St.BoxLayout({
            style_class: 'cu-panel-status-box',
        });

        const iconPath = GLib.build_filenamev([this._extensionPath, 'icons', 'code-usage-symbolic.svg']);
        const gicon = this._loadIcon(iconPath);
        this._icon = new St.Icon({
            gicon: gicon,
            style_class: 'cu-panel-icon',
            icon_size: 16,
        });
        this._box.add_child(this._icon);

        this._panelProgressBg = new St.Widget({
            style_class: 'cu-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelProgressBar = new St.Widget({
            style_class: 'cu-panel-progress-bar cu-usage-low',
        });
        this._panelProgressBg.add_child(this._panelProgressBar);
        this._box.add_child(this._panelProgressBg);

        this._label = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cu-panel-label',
        });
        this._box.add_child(this._label);

        this.add_child(this._box);

        this._createMenu();
        Main.panel.menuManager.addMenu(this.menu);
        this._updateDisplayMode();
        this._updateIconVisibility();

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'display-mode') {
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if (key === 'selected-agents' || key === 'date-range-preset' ||
                        key === 'custom-date-since' || key === 'custom-date-until' ||
                        key === 'cost-currency' || key === 'cny-exchange-rate' ||
                        key === 'cost-multiplier' || key === 'price-overrides' ||
                        key === 'sort-order' || key === 'debug-mode') {
                this._refreshUsage();
            }
        });

        this._refreshUsage();
        this._startTimer();
    }

    _loadIcon(path) {
        try {
            const file = Gio.File.new_for_path(path);
            if (file.query_exists(null)) {
                return Gio.icon_new_for_string(path);
            }
        } catch (e) { /* fall through */ }
        return Gio.ThemedIcon.new('utilities-system-monitor-symbolic');
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        if (mode === 'bar') {
            this._panelProgressBg.show();
            this._label.hide();
            this._label.set_style('margin-left: 0;');
        } else if (mode === 'both') {
            this._panelProgressBg.show();
            this._label.show();
            this._label.set_style('margin-left: 6px;');
        } else {
            this._panelProgressBg.hide();
            this._label.show();
            this._label.set_style('margin-left: 0;');
        }

        if (this._lastData) {
            this._updatePanelLabel(this._lastData);
        }
    }

    _updateIconVisibility() {
        const showIcon = this._settings.get_boolean('show-icon');
        if (showIcon) {
            this._icon.show();
        } else {
            this._icon.hide();
        }
    }

    _createMenu() {
        const heroBox = new St.BoxLayout({
            style_class: 'cu-hero-box',
            vertical: true,
        });

        const heroHeader = new St.BoxLayout({ vertical: false });
        const heroTitle = new St.Label({
            text: _('代码用量概览'),
            style_class: 'cu-section-title',
        });
        heroHeader.add_child(heroTitle);

        this._refreshButton = new St.Button({
            style_class: 'cu-refresh-button',
            reactive: true,
            can_focus: true,
        });
        const refreshIcon = new St.Icon({
            icon_name: 'view-refresh-symbolic',
            icon_size: 14,
        });
        this._refreshButton.set_child(refreshIcon);
        this._refreshButton.connect('clicked', () => {
            this._refreshUsage();
        });
        heroHeader.add_child(this._refreshButton);

        heroBox.add_child(heroHeader);

        const statsRow = new St.BoxLayout({
            style_class: 'cu-stats-row',
            vertical: false,
        });

        this._requestCountCard = this._createStatCard(_('请求数'), '0');
        this._tokenCountCard = this._createStatCard(_('Token'), '0');
        this._costCard = this._createStatCard(_('费用'), '¥0.00');

        statsRow.add_child(this._requestCountCard);
        statsRow.add_child(this._tokenCountCard);
        statsRow.add_child(this._costCard);
        heroBox.add_child(statsRow);

        const heroItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        heroItem.add_child(heroBox);
        this.menu.addMenuItem(heroItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const modelSectionBox = new St.BoxLayout({
            style_class: 'cu-model-section',
            vertical: true,
        });
        const modelTitle = new St.Label({
            text: _('模型分布'),
            style_class: 'cu-section-title',
        });
        modelSectionBox.add_child(modelTitle);

        this._modelListContainer = new St.BoxLayout({
            style_class: 'cu-model-list',
            vertical: true,
        });
        modelSectionBox.add_child(this._modelListContainer);

        const modelSectionItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        modelSectionItem.add_child(modelSectionBox);
        this.menu.addMenuItem(modelSectionItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const cacheBox = new St.BoxLayout({
            style_class: 'cu-cache-section',
            vertical: true,
        });

        const cacheHeader = new St.BoxLayout({ vertical: false });
        const cacheTitle = new St.Label({
            text: _('缓存命中率'),
            style_class: 'cu-section-title',
        });
        cacheHeader.add_child(cacheTitle);
        this._cacheHitRateLabel = new St.Label({
            text: '0.0%',
            style_class: 'cu-cache-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        cacheHeader.add_child(this._cacheHitRateLabel);
        cacheBox.add_child(cacheHeader);

        const cacheProgressBg = new St.Widget({
            style_class: 'cu-progress-bg cu-cache-bg',
        });
        this._cacheProgressBar = new St.Widget({
            style_class: 'cu-progress-bar cu-cache-bar',
        });
        cacheProgressBg.add_child(this._cacheProgressBar);
        cacheBox.add_child(cacheProgressBg);

        const cacheItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        cacheItem.add_child(cacheBox);
        this.menu.addMenuItem(cacheItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const dateBox = new St.BoxLayout({
            style_class: 'cu-date-section',
            vertical: true,
        });

        const dateHeader = new St.BoxLayout({ vertical: false });
        const dateTitle = new St.Label({
            text: _('日期范围'),
            style_class: 'cu-section-title',
        });
        dateHeader.add_child(dateTitle);
        dateBox.add_child(dateHeader);

        const dateButtonRow = new St.BoxLayout({
            style_class: 'cu-date-button-row',
            vertical: false,
        });

        this._dateButtons = {};
        for (const preset of DATE_PRESETS) {
            const btn = new St.Button({
                style_class: 'cu-date-button',
                reactive: true,
                can_focus: true,
                label: preset.label,
            });
            btn.connect('clicked', () => {
                this._settings.set_string('date-range-preset', preset.id);
                this._updateDateButtonStyles();
                this._refreshUsage();
            });
            this._dateButtons[preset.id] = btn;
            dateButtonRow.add_child(btn);
        }
        dateBox.add_child(dateButtonRow);

        const dateItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        dateItem.add_child(dateBox);
        this.menu.addMenuItem(dateItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem(_('设置'));
        settingsItem.connect('activate', () => {
            this._openPreferences();
        });
        this.menu.addMenuItem(settingsItem);

        this._updateDateButtonStyles();
    }

    _createStatCard(labelText, valueText) {
        const card = new St.BoxLayout({
            style_class: 'cu-stat-card',
            vertical: true,
            x_expand: true,
        });
        const value = new St.Label({
            text: valueText,
            style_class: 'cu-stat-value',
            x_align: Clutter.ActorAlign.CENTER,
        });
        const label = new St.Label({
            text: labelText,
            style_class: 'cu-stat-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        card.add_child(value);
        card.add_child(label);
        card._valueLabel = value;
        return card;
    }

    _updateDateButtonStyles() {
        const currentPreset = this._settings.get_string('date-range-preset');
        for (const [id, btn] of Object.entries(this._dateButtons)) {
            if (id === currentPreset) {
                btn.add_style_class_name('active');
            } else {
                btn.remove_style_class_name('active');
            }
        }
    }

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refreshUsage();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    async _refreshUsage() {
        if (this._refreshing) return;
        this._refreshing = true;

        this._label.set_text('...');
        this._refreshButton.add_style_pseudo_class('active');

        try {
            const agents = this._settings.get_strv('selected-agents');
            if (agents.length === 0) {
                this._lastData = this._processor.processEntries([]);
            } else {
                const entries = await this._dataSource.fetchMultiAgentData(agents);
                this._lastData = this._processor.processEntries(entries);
            }
            this._updateDisplay(this._lastData);
        } catch (e) {
            console.error(`Code Usage: Refresh failed: ${e.message}`);
            this._label.set_text(_('错误'));
            this._requestCountCard._valueLabel.set_text('-');
            this._tokenCountCard._valueLabel.set_text('-');
            this._costCard._valueLabel.set_text('-');
        } finally {
            this._refreshing = false;
            this._refreshButton.remove_style_pseudo_class('active');
        }
    }

    _updatePanelLabel(data) {
        const mode = this._settings.get_string('display-mode');

        if (mode === 'both') {
            this._label.set_text(`${data.totalRealTokensFormatted} · ${data.totalCostFormatted}`);
        } else if (mode === 'cost') {
            this._label.set_text(data.totalCostFormatted);
        } else {
            this._label.set_text(data.totalRealTokensFormatted);
        }

        this._updatePanelProgressBar(data);
    }

    _updatePanelProgressBar(data) {
        const maxWidth = 50;
        const maxForBar = Math.max(100000, data.totalRealTokens || 1);
        const width = Math.round((Math.min(data.totalRealTokens || 0, maxForBar) / maxForBar) * maxWidth);
        this._panelProgressBar.set_width(Math.max(width, 2));

        this._panelProgressBar.remove_style_class_name('cu-usage-low');
        this._panelProgressBar.remove_style_class_name('cu-usage-medium');
        this._panelProgressBar.remove_style_class_name('cu-usage-high');
        this._panelProgressBar.remove_style_class_name('cu-usage-critical');

        const ratio = data.cacheHitRate || 0;
        if (ratio >= 0.9) {
            this._panelProgressBar.add_style_class_name('cu-usage-critical');
        } else if (ratio >= 0.7) {
            this._panelProgressBar.add_style_class_name('cu-usage-high');
        } else if (ratio >= 0.4) {
            this._panelProgressBar.add_style_class_name('cu-usage-medium');
        } else {
            this._panelProgressBar.add_style_class_name('cu-usage-low');
        }
    }

    _updateDisplay(data) {
        this._updatePanelLabel(data);

        this._requestCountCard._valueLabel.set_text(String(data.totalRequests));
        this._tokenCountCard._valueLabel.set_text(data.totalRealTokensFormatted);
        this._costCard._valueLabel.set_text(data.totalCostFormatted);

        this._updateModelList(data);

        this._cacheHitRateLabel.set_text(data.cacheHitRateFormatted);
        const cacheWidth = Math.round(data.cacheHitRate * 200);
        this._cacheProgressBar.set_width(Math.max(cacheWidth, 2));
    }

    _updateModelList(data) {
        const children = this._modelListContainer.get_children();
        for (const child of children) {
            this._modelListContainer.remove_child(child);
        }

        const models = data.modelStats || [];
        const maxModels = 5;

        for (let i = 0; i < Math.min(models.length, maxModels); i++) {
            const ms = models[i];
            const row = new St.BoxLayout({
                style_class: 'cu-model-row',
                vertical: false,
            });

            const name = new St.Label({
                text: ms.displayName || ms.model,
                style_class: 'cu-model-name',
                x_expand: true,
            });
            row.add_child(name);

            const progressBg = new St.Widget({
                style_class: 'cu-progress-bg',
            });
            const progressBar = new St.Widget({
                style_class: 'cu-progress-bar',
            });
            const barWidth = Math.round(ms.percentage * 100);
            progressBar.set_width(Math.max(barWidth, 2));
            progressBg.add_child(progressBar);
            row.add_child(progressBg);

            const cost = new St.Label({
                text: ms.totalCostFormatted,
                style_class: 'cu-model-cost',
            });
            row.add_child(cost);

            this._modelListContainer.add_child(row);
        }

        if (models.length === 0) {
            const empty = new St.Label({
                text: _('暂无数据'),
                style_class: 'cu-empty-label',
            });
            this._modelListContainer.add_child(empty);
        }
    }

    destroy() {
        this._stopTimer();
        Main.panel.menuManager.removeMenu(this.menu);
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        super.destroy();
    }
});