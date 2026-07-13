import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { DataSource } from './dataSource.js';
import { DataProcessor, setGettext as setDataProcessorGettext } from './dataProcessor.js';
import { IDLE_THRESHOLD_MS } from './cacheManager.js';
import { AGENT_BRAND_COLORS, AGENT_BRAND_TEXT_COLORS } from './defaultPricing.js';
import { setDebugEnabled as setParsersDebugEnabled } from './parsers.js';
import { DailyArchive } from './dailyArchive.js';

let _ = (s) => s;

const MODEL_COLLAPSED_PAGE_SIZE = 5;
const MODEL_EXPANDED_PAGE_SIZE = 8;

export function setGettext(fn) {
    _ = fn;
    setDataProcessorGettext(fn);
}

/**
 * Create a single-line St.Label with end-ellipsis truncation.
 * The label will shrink to its allocated width and show '…' when text overflows.
 */
function _makeEllipsizedLabel(params = {}) {
    const label = new St.Label(params);
    label.clutter_text.set_single_line_mode(true);
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    return label;
}

/**
 * Attach a hover tooltip to an actor. The tooltip is added to Main.layoutManager
 * as chrome so it can render above the popup menu. The tooltip is only shown
 * when the predicate `shouldShow()` returns true (e.g. only when the label is
 * actually ellipsized).
 *
 * The tooltip is automatically destroyed when the actor leaves hover or is
 * destroyed. Returns nothing; cleanup is handled internally.
 */
function _attachHoverTooltip(actor, getText, shouldShow, options = {}) {
    actor.reactive = true;
    actor.track_hover = true;

    let tooltip = null;
    const removeTooltip = () => {
        if (tooltip) {
            tooltip.destroy();
            tooltip = null;
        }
    };

    const hoverId = actor.connect('notify::hover', () => {
        if (actor.hover) {
            if (tooltip) return;
            if (shouldShow && !shouldShow()) return;
            const text = getText();
            if (!text) return;

            tooltip = new St.Label({
                style_class: 'cu-tooltip',
                text: text,
            });
            Main.layoutManager.addChrome(tooltip);

            const [x, y] = actor.get_transformed_position();
            const actorW = actor.get_width();
            const actorH = actor.get_height();
            const [, tooltipW] = tooltip.get_preferred_width(-1);
            const [, tooltipH] = tooltip.get_preferred_height(-1);
            const monitor = Main.layoutManager.findMonitorForActor
                ? Main.layoutManager.findMonitorForActor(actor)
                : Main.layoutManager.primaryMonitor;
            const gap = 6;
            const margin = 8;
            const minX = monitor.x + margin;
            const maxX = monitor.x + monitor.width - tooltipW - margin;
            let tx = Math.round(x + actorW / 2 - tooltipW / 2);
            tx = Math.max(minX, Math.min(tx, maxX));

            let ty;
            if (options.placement === 'above') {
                ty = Math.round(y - tooltipH - gap);
                if (ty < monitor.y + margin) {
                    ty = Math.round(y + actorH + gap);
                }
            } else {
                ty = Math.round(y + actorH + 2);
            }
            tooltip.set_position(tx, ty);
        } else {
            removeTooltip();
        }
    });

    actor.connect('destroy', () => {
        if (hoverId) {
            try { actor.disconnect(hoverId); } catch (_e) { /* ignore */ }
        }
        removeTooltip();
    });
}

// Lazy getter so the labels are translated with the live `_` set by
// enable() at call time, not at module-load time (when `_` is still the
// identity function and gettext would be bypassed).
function _getDatePresets() {
    return [
        { id: 'today', label: _('今天') },
        { id: '7d', label: _('7天') },
        { id: '30d', label: _('30天') },
        { id: 'all', label: _('全部') },
    ];
}

export const CodeUsageIndicator = GObject.registerClass(
class CodeUsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, _('代码用量监控'));

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._dataSource = new DataSource(settings);
        this._processor = new DataProcessor(settings);
        this._archive = new DailyArchive(settings, this._processor);
        this._lastData = null;
        this._refreshing = false;
        this._refreshQueued = false;
        this._queuedShowPlaceholder = false;
        this._refreshGeneration = 0;
        this._destroyed = false;
        this._modelExpanded = false;
        this._modelPage = 0;
        this._modelListData = [];
        this._modelListDirty = false;
        this._heatmapWeeksData = [];
        this._heatmapDirty = false;
        this._activePage = 'overview';
        this._pageButtons = {};
        this._overviewPageItems = [];
        // Debounce source ids for settings-driven reprocessing / timer
        // restarts. SpinRow drags fire dozens of 'changed' signals per
        // second; without coalescing, each one triggers a full reprocess.
        this._reprocessDebounceId = 0;
        this._timerRestartDebounceId = 0;
        // Adaptive timer state: 'active' uses active-refresh-interval, 'idle'
        // uses idle-refresh-interval. Transitions happen after each scan
        // based on how long ago the most recent log write was.
        this._intervalState = 'idle';
        this._lastActivityAt = 0;
        // Propagate the initial debug-mode flag to the parser layer so its
        // swallowed exceptions become visible when the user opts in.
        setParsersDebugEnabled(this._settings.get_boolean('debug-mode'));

        this._box = new St.BoxLayout({
            style_class: 'cu-panel-status-box',
        });

        // Build per-metric chips: [icon] + [label]. Each chip is shown/hidden
        // based on display-mode. All three icons come from the system theme,
        // so they follow the user's icon style automatically. Cost has no
        // single guaranteed name in standard Adwaita, so it uses a fallback
        // chain — preferring a money emblem when present, otherwise the
        // calculator icon which is always available.
        this._tokenChip = this._createMetricChip('text-x-generic-symbolic', 'cu-chip-tokens');
        this._costChip = this._createMetricChip(
            ['emblem-money-symbolic', 'accessories-calculator-symbolic'],
            'cu-chip-cost'
        );
        this._requestsChip = this._createMetricChip('network-transmit-receive-symbolic', 'cu-chip-requests');

        this._box.add_child(this._tokenChip);
        this._box.add_child(this._costChip);
        this._box.add_child(this._requestsChip);

        this.add_child(this._box);

        this._createMenu();
        Main.panel.menuManager.addMenu(this.menu);

        // When the user opens the popup, render any deferred model list and
        // kick a full refresh so the just-revealed cards show data as fresh
        // as possible. The cache layer makes the refresh cheap when nothing
        // has changed.
        this._menuOpenStateId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen) return;
            if (this._modelListDirty) {
                this._renderModelList();
                this._modelListDirty = false;
            }
            if (this._heatmapDirty) {
                this._renderTokenHeatmap();
                this._heatmapDirty = false;
            }
            this._fullRefresh({ showPlaceholder: true });
        });

        this._updateDisplayMode();
        this._updateIconVisibility();

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            switch (key) {
                case 'active-refresh-interval':
                case 'idle-refresh-interval':
                    this._debouncedRestartTimer();
                    break;
                case 'display-mode':
                    this._updateDisplayMode();
                    break;
                case 'show-icon':
                    this._updateIconVisibility();
                    break;
                case 'selected-agents':
                    // Agent set changed → drop cache and rescan from scratch.
                    this._dataSource.clearCache();
                    this._fullRefresh();
                    break;
                case 'cost-currency':
                case 'cny-exchange-rate':
                case 'cost-multiplier':
                case 'price-overrides':
                case 'sort-order':
                case 'model-sort-by':
                case 'date-range-preset':
                case 'custom-date-since':
                case 'custom-date-until':
                case 'token-display-format':
                case 'debug-mode':
                    setParsersDebugEnabled(this._settings.get_boolean('debug-mode'));
                    // Pure presentation/aggregation changes → re-process the
                    // cached entries with current settings, no IO. Debounced
                    // so a SpinRow drag (100+ signals/sec) does one reprocess.
                    this._debouncedReprocess();
                    break;
                default:
                    break;
            }
        });

        this._fullRefresh({ showPlaceholder: true });
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

    /**
     * Build a "metric chip" actor consisting of an icon followed by a value
     * label. Each chip is independently shown/hidden based on display-mode,
     * and its icon visibility is controlled by the show-icon setting.
     *
     * `iconSpec` accepts:
     *  - a themed icon name string (e.g. 'text-x-generic-symbolic')
     *  - an array of names as a fallback chain — useful when the preferred
     *    name isn't guaranteed to exist in every icon theme; the first
     *    name found in the active theme wins.
     *  - a relative SVG file name ending in '.svg' (resolved under icons/).
     */
    _createMetricChip(iconSpec, extraStyleClass) {
        const chip = new St.BoxLayout({
            style_class: `cu-panel-chip ${extraStyleClass}`,
        });

        const iconProps = {
            style_class: 'cu-panel-icon',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        };
        if (Array.isArray(iconSpec)) {
            iconProps.gicon = Gio.ThemedIcon.new_from_names(iconSpec);
        } else if (iconSpec.endsWith('.svg')) {
            const iconPath = GLib.build_filenamev([this._extensionPath, 'icons', iconSpec]);
            iconProps.gicon = this._loadIcon(iconPath);
        } else {
            iconProps.icon_name = iconSpec;
        }
        const icon = new St.Icon(iconProps);
        chip.add_child(icon);

        const label = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cu-panel-label',
        });
        chip.add_child(label);

        chip._icon = icon;
        chip._label = label;
        return chip;
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        // 'all' / legacy 'both' show all three chips. Each named single mode
        // shows only its own chip. Unknown values (including legacy 'bar')
        // fall back to tokens-only.
        const showAll = (mode === 'all' || mode === 'both');
        const named = mode === 'tokens' || mode === 'cost' || mode === 'requests';
        const fallbackTokens = !showAll && !named;

        this._tokenChip.visible = showAll || mode === 'tokens' || fallbackTokens;
        this._costChip.visible = showAll || mode === 'cost';
        this._requestsChip.visible = showAll || mode === 'requests';

        if (this._lastData) {
            this._updatePanelLabel(this._lastData);
        }
    }

    _updateIconVisibility() {
        const showIcon = this._settings.get_boolean('show-icon');
        for (const chip of [this._tokenChip, this._costChip, this._requestsChip]) {
            if (showIcon) {
                chip._icon.show();
            } else {
                chip._icon.hide();
            }
        }
    }

    _createMenu() {
        const heroBox = new St.BoxLayout({
            style_class: 'cu-hero-box cu-popup-content-width',
            vertical: true,
            x_expand: true,
        });

        const heroHeader = new St.BoxLayout({ vertical: false, x_expand: true });

        const heroTitle = new St.Label({
            text: _('用量概览'),
            style_class: 'cu-section-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        heroHeader.add_child(heroTitle);

        this._refreshButton = new St.Button({
            style_class: 'cu-action-button',
            reactive: true,
            can_focus: true,
        });
        const refreshIcon = new St.Icon({
            icon_name: 'view-refresh-symbolic',
            icon_size: 14,
        });
        this._refreshButton.set_child(refreshIcon);
        this._refreshButton.connect('clicked', () => {
            this._fullRefresh({ showPlaceholder: true });
        });
        heroHeader.add_child(this._refreshButton);

        this._settingsButton = new St.Button({
            style_class: 'cu-action-button',
            reactive: true,
            can_focus: true,
        });
        const settingsIcon = new St.Icon({
            icon_name: 'preferences-system-symbolic',
            icon_size: 14,
        });
        this._settingsButton.set_child(settingsIcon);
        this._settingsButton.connect('clicked', () => {
            this._openPreferences();
        });
        heroHeader.add_child(this._settingsButton);

        heroBox.add_child(heroHeader);

        const statsRow = new St.BoxLayout({
            style_class: 'cu-stats-row',
            vertical: false,
            x_expand: true,
        });

        this._requestCountCard = this._createStatCard(_('请求数'), '0', 'cu-stat-requests');
        this._tokenCountCard = this._createStatCard(_('Token'), '0', 'cu-stat-tokens');
        this._costCard = this._createStatCard(_('费用'), '¥0.00', 'cu-stat-cost');

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

        const tabsItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        tabsItem.add_child(this._createPageTabs());
        this.menu.addMenuItem(tabsItem);

        const overviewSep1 = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(overviewSep1);
        this._overviewPageItems.push(overviewSep1);

        const modelSectionBox = new St.BoxLayout({
            style_class: 'cu-model-section cu-popup-content-width',
            vertical: true,
            x_expand: true,
        });
        const modelTitle = new St.Label({
            text: _('模型'),
            style_class: 'cu-section-title',
        });
        modelSectionBox.add_child(modelTitle);

        this._modelListContainer = new St.BoxLayout({
            style_class: 'cu-model-list',
            vertical: true,
            x_expand: true,
        });
        modelSectionBox.add_child(this._modelListContainer);

        this._modelExpander = new St.Button({
            style_class: 'cu-model-expander',
            reactive: true,
            can_focus: true,
            label: _('展开更多 ▼'),
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._modelExpander.connect('clicked', () => {
            this._modelExpanded = !this._modelExpanded;
            this._modelPage = 0;
            this._renderModelList();
        });
        modelSectionBox.add_child(this._modelExpander);

        this._modelPaginationBox = new St.BoxLayout({
            style_class: 'cu-model-pagination',
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._modelPagePrev = new St.Button({
            style_class: 'cu-model-page-btn',
            reactive: true,
            can_focus: true,
            label: '‹',
        });
        this._modelPagePrev.connect('clicked', () => {
            if (this._modelPage > 0) {
                this._modelPage--;
                this._renderModelList();
            }
        });
        this._modelPaginationBox.add_child(this._modelPagePrev);

        this._modelPageLabel = new St.Label({
            text: '1/1',
            style_class: 'cu-model-page-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._modelPaginationBox.add_child(this._modelPageLabel);

        this._modelPageNext = new St.Button({
            style_class: 'cu-model-page-btn',
            reactive: true,
            can_focus: true,
            label: '›',
        });
        this._modelPageNext.connect('clicked', () => {
            const models = this._modelListData;
            const totalPages = Math.ceil(models.length / MODEL_EXPANDED_PAGE_SIZE);
            if (this._modelPage < totalPages - 1) {
                this._modelPage++;
                this._renderModelList();
            }
        });
        this._modelPaginationBox.add_child(this._modelPageNext);

        modelSectionBox.add_child(this._modelPaginationBox);

        const modelSectionItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        modelSectionItem.add_child(modelSectionBox);
        this.menu.addMenuItem(modelSectionItem);
        this._overviewPageItems.push(modelSectionItem);

        const overviewSep2 = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(overviewSep2);
        this._overviewPageItems.push(overviewSep2);

        const heatmapBox = new St.BoxLayout({
            style_class: 'cu-heatmap-section cu-popup-content-width',
            vertical: true,
            x_expand: true,
        });
        const heatmapHeader = new St.BoxLayout({
            style_class: 'cu-heatmap-header',
            vertical: false,
            x_expand: true,
        });
        const heatmapTitle = new St.Label({
            text: _('Token 贡献'),
            style_class: 'cu-section-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        heatmapHeader.add_child(heatmapTitle);

        this._heatmapDetailLabel = _makeEllipsizedLabel({
            text: _('悬停查看详情'),
            style_class: 'cu-heatmap-detail',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        heatmapHeader.add_child(this._heatmapDetailLabel);
        heatmapBox.add_child(heatmapHeader);

        const heatmapBody = new St.BoxLayout({
            style_class: 'cu-heatmap-body',
            vertical: false,
            x_expand: true,
        });
        const weekdayCol = new St.BoxLayout({
            style_class: 'cu-heatmap-weekdays',
            vertical: true,
        });
        weekdayCol.add_child(new St.Widget({
            style_class: 'cu-heatmap-month-slot',
        }));
        for (const label of ['', _('一'), '', _('三'), '', _('五'), '']) {
            const weekdaySlot = new St.BoxLayout({
                style_class: 'cu-heatmap-weekday-slot',
                x_align: Clutter.ActorAlign.CENTER,
            });
            weekdaySlot.add_child(new St.Label({
                text: label,
                style_class: 'cu-heatmap-weekday',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            weekdayCol.add_child(weekdaySlot);
        }
        heatmapBody.add_child(weekdayCol);

        this._heatmapGrid = new St.BoxLayout({
            style_class: 'cu-heatmap-grid',
            vertical: false,
            x_expand: true,
        });
        heatmapBody.add_child(this._heatmapGrid);
        heatmapBox.add_child(heatmapBody);

        const heatmapLegend = new St.BoxLayout({
            style_class: 'cu-heatmap-legend',
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        heatmapLegend.add_child(new St.Label({ text: _('少'), style_class: 'cu-heatmap-legend-label' }));
        for (let level = 0; level <= 4; level++) {
            heatmapLegend.add_child(new St.Widget({ style_class: `cu-heatmap-cell cu-heatmap-level-${level}` }));
        }
        heatmapLegend.add_child(new St.Label({ text: _('多'), style_class: 'cu-heatmap-legend-label' }));
        heatmapBox.add_child(heatmapLegend);

        const heatmapItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        heatmapItem.add_child(heatmapBox);
        this.menu.addMenuItem(heatmapItem);
        this._overviewPageItems.push(heatmapItem);

        const overviewSep3 = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(overviewSep3);
        this._overviewPageItems.push(overviewSep3);

        const dateBox = new St.BoxLayout({
            style_class: 'cu-date-section cu-popup-content-width',
            vertical: true,
            x_expand: true,
        });

        const dateHeader = new St.BoxLayout({ vertical: false, x_expand: true });
        const dateTitle = new St.Label({
            text: _('日期范围'),
            style_class: 'cu-section-title',
        });
        dateHeader.add_child(dateTitle);
        dateBox.add_child(dateHeader);

        const dateButtonRow = new St.BoxLayout({
            style_class: 'cu-date-button-row',
            vertical: false,
            x_expand: true,
        });

        this._dateButtons = {};
        for (const preset of _getDatePresets()) {
            const btn = new St.Button({
                style_class: 'cu-date-button',
                reactive: true,
                can_focus: true,
                label: preset.label,
            });
            btn.connect('clicked', () => {
                const currentPreset = this._settings.get_string('date-range-preset');
                if (preset.id === currentPreset) {
                    // Clicking the already-active range is a no-op: don't reset
                    // pagination state and don't trigger a refresh.
                    return;
                }
                // Reset model list to collapsed first page so the new range
                // always starts from a clean state, even if the new dataset
                // would have fewer pages than the current page index.
                this._modelExpanded = false;
                this._modelPage = 0;
                this._settings.set_string('date-range-preset', preset.id);
                this._updateDateButtonStyles();
                // The settings 'changed' handler routes date-range-preset
                // through _quickReprocess (no IO) since the cache is unaffected.
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
        this._overviewPageItems.push(dateItem);

        this._weeklyPageItem = this._createWeeklyPage();
        this.menu.addMenuItem(this._weeklyPageItem);

        this._achievementsPageItem = this._createAchievementsPage();
        this.menu.addMenuItem(this._achievementsPageItem);

        this._updateDateButtonStyles();
        this._setActivePage('overview');
    }

    _createPageTabs() {
        const tabs = new St.BoxLayout({
            style_class: 'cu-page-tabs cu-popup-content-width',
            vertical: false,
            x_expand: true,
        });
        for (const tab of [
            { id: 'overview', label: _('概览') },
            { id: 'weekly', label: _('周报') },
            { id: 'achievements', label: _('成就') },
        ]) {
            const btn = new St.Button({
                style_class: 'cu-page-tab',
                reactive: true,
                can_focus: true,
                label: tab.label,
                x_expand: true,
            });
            btn.connect('clicked', () => this._setActivePage(tab.id));
            this._pageButtons[tab.id] = btn;
            tabs.add_child(btn);
        }
        return tabs;
    }

    _setActivePage(pageId) {
        this._activePage = pageId;
        for (const [id, btn] of Object.entries(this._pageButtons)) {
            if (id === pageId) {
                btn.add_style_class_name('active');
            } else {
                btn.remove_style_class_name('active');
            }
        }
        for (const item of this._overviewPageItems) {
            if (pageId === 'overview') item.show();
            else item.hide();
        }
        if (this._weeklyPageItem) {
            if (pageId === 'weekly') this._weeklyPageItem.show();
            else this._weeklyPageItem.hide();
        }
        if (this._achievementsPageItem) {
            if (pageId === 'achievements') this._achievementsPageItem.show();
            else this._achievementsPageItem.hide();
        }
    }

    _createWeeklyPage() {
        const pageBox = new St.BoxLayout({
            style_class: 'cu-weekly-page cu-popup-content-width',
            vertical: true,
            x_expand: true,
        });

        this._weeklyTitleLabel = new St.Label({
            text: _('本周还没开张'),
            style_class: 'cu-weekly-title',
        });
        pageBox.add_child(this._weeklyTitleLabel);

        this._weeklySubtitleLabel = _makeEllipsizedLabel({
            text: _('有新记录后，这里会生成本周小结。'),
            style_class: 'cu-weekly-subtitle',
            x_expand: true,
        });
        pageBox.add_child(this._weeklySubtitleLabel);

        const statsRow = new St.BoxLayout({
            style_class: 'cu-weekly-stats-row',
            vertical: false,
            x_expand: true,
        });
        this._weeklyActiveCard = this._createStatCard(_('活跃天数'), '0', 'cu-stat-requests cu-weekly-stat-card', Clutter.ActorAlign.CENTER, false);
        this._weeklyTokenCard = this._createStatCard(_('Token'), '0', 'cu-stat-tokens cu-weekly-stat-card', Clutter.ActorAlign.CENTER, false);
        this._weeklyCostCard = this._createStatCard(_('费用'), '¥0.00', 'cu-stat-cost cu-weekly-stat-card', Clutter.ActorAlign.CENTER, false);
        for (const card of [this._weeklyActiveCard, this._weeklyTokenCard, this._weeklyCostCard]) {
            card.set_width(88);
            card._valueLabel.add_style_class_name('cu-weekly-stat-value');
            card._valueLabel.set_height(22);
            card._label.add_style_class_name('cu-weekly-stat-label');
            card._label.set_height(15);
        }
        statsRow.add_child(this._weeklyActiveCard);
        statsRow.add_child(this._weeklyTokenCard);
        statsRow.add_child(this._weeklyCostCard);
        pageBox.add_child(statsRow);

        this._weeklyDailyBars = new St.BoxLayout({
            style_class: 'cu-weekly-daily-bars',
            vertical: false,
            x_expand: true,
        });
        pageBox.add_child(this._weeklyDailyBars);

        this._weeklyHighlightList = new St.BoxLayout({
            style_class: 'cu-weekly-highlight-list',
            vertical: true,
            x_expand: true,
        });
        pageBox.add_child(this._weeklyHighlightList);

        this._weeklyBadgeList = new St.BoxLayout({
            style_class: 'cu-weekly-badge-list',
            vertical: true,
            x_expand: true,
        });
        pageBox.add_child(this._weeklyBadgeList);

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        item.add_child(pageBox);
        return item;
    }

    _createAchievementsPage() {
        const pageBox = new St.BoxLayout({
            style_class: 'cu-achievements-page cu-popup-content-width',
            vertical: true,
            x_expand: true,
        });

        const title = new St.Label({
            text: _('成就徽章'),
            style_class: 'cu-section-title',
        });
        pageBox.add_child(title);

        this._achievementSummaryLabel = _makeEllipsizedLabel({
            text: _('还没有解锁成就'),
            style_class: 'cu-achievement-summary',
            x_expand: true,
        });
        pageBox.add_child(this._achievementSummaryLabel);

        this._achievementList = new St.BoxLayout({
            style_class: 'cu-achievement-list',
            vertical: true,
            x_expand: true,
        });
        pageBox.add_child(this._achievementList);

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        item.add_child(pageBox);
        return item;
    }

    _createStatCard(labelText, valueText, extraClass, labelAlign = Clutter.ActorAlign.START, xExpand = true) {
        const card = new St.BoxLayout({
            style_class: `cu-stat-card ${extraClass}`,
            vertical: true,
            x_expand: xExpand,
        });
        const value = new St.Label({
            text: valueText,
            style_class: 'cu-stat-value',
            x_align: labelAlign,
        });
        const label = new St.Label({
            text: labelText,
            style_class: 'cu-stat-label',
            x_align: labelAlign,
        });
        card.add_child(value);
        card.add_child(label);
        card._valueLabel = value;
        card._label = label;
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

    _currentIntervalSeconds() {
        const key = this._intervalState === 'active'
            ? 'active-refresh-interval'
            : 'idle-refresh-interval';
        // Defensive lower bound: a 0/negative value would loop the timer
        // hot. Clamp to 1s; the schema's range constraints normally prevent
        // anything pathological from reaching here.
        return Math.max(1, this._settings.get_int(key));
    }

    _startTimer() {
        const interval = this._currentIntervalSeconds();
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._fullRefresh();
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

    /**
     * Coalesce a burst of settings 'changed' signals (e.g. SpinRow drag)
     * into a single reprocess after the user stops adjusting for 150ms.
     */
    _debouncedReprocess() {
        if (this._reprocessDebounceId) {
            GLib.source_remove(this._reprocessDebounceId);
        }
        this._reprocessDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._reprocessDebounceId = 0;
            this._quickReprocess();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Same idea for timer restarts — avoid stop/start churn mid-drag. */
    _debouncedRestartTimer() {
        if (this._timerRestartDebounceId) {
            GLib.source_remove(this._timerRestartDebounceId);
        }
        this._timerRestartDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._timerRestartDebounceId = 0;
            this._restartTimer();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * After every scan, decide whether the agent has been "actively" writing
     * recently (within IDLE_THRESHOLD_MS) or is idle, and switch the timer
     * cadence if needed. Called from _fullRefresh after scanAndDiff completes
     * so it sees the freshest mtime data.
     */
    _reconcileTimerState() {
        const sinceActivityMs = Date.now() - this._lastActivityAt;
        const newState = sinceActivityMs < IDLE_THRESHOLD_MS ? 'active' : 'idle';
        if (newState === this._intervalState) return;

        const oldInterval = this._currentIntervalSeconds();
        this._intervalState = newState;
        const newInterval = this._currentIntervalSeconds();
        if (this._settings.get_boolean('debug-mode')) {
            console.log(`Code Usage: interval ${oldInterval}s -> ${newInterval}s (${newState})`);
        }
        this._restartTimer();
    }

    async _fullRefresh({ showPlaceholder = false } = {}) {
        const generation = ++this._refreshGeneration;
        if (this._refreshing) {
            this._refreshQueued = true;
            this._queuedShowPlaceholder = this._queuedShowPlaceholder || showPlaceholder;
            return;
        }
        this._refreshing = true;

        // Only show "..." when the user explicitly requested a refresh or
        // when the panel has not displayed any data yet. Auto ticks that
        // hit the cache and produce no UI change should never flicker.
        const showLoader = showPlaceholder || this._lastData === null;
        if (showLoader) {
            for (const chip of [this._tokenChip, this._costChip, this._requestsChip]) {
                chip._label.set_text('...');
            }
            this._refreshButton.add_style_pseudo_class('active');
        }

        try {
            const agents = this._settings.get_strv('selected-agents');
            if (agents.length === 0) {
                this._dataSource.clearCache();
                this._lastActivityAt = 0;
            } else {
                const result = await this._dataSource.scanAndDiff(agents);
                if (generation !== this._refreshGeneration) return;
                if (result && typeof result.lastActivityAt === 'number') {
                    this._lastActivityAt = result.lastActivityAt;
                }
            }
            if (generation !== this._refreshGeneration) return;
            this._reconcileTimerState();
            this._renderFromCache();
        } catch (e) {
            if (generation !== this._refreshGeneration) return;
            console.error(`Code Usage: Refresh failed: ${e.message}`);
            const errText = _('错误');
            for (const chip of [this._tokenChip, this._costChip, this._requestsChip]) {
                chip._label.set_text(errText);
            }
            this._requestCountCard._valueLabel.set_text('-');
            this._tokenCountCard._valueLabel.set_text('-');
            this._costCard._valueLabel.set_text('-');
        } finally {
            this._refreshing = false;
            // If the indicator was destroyed while we were awaiting IO,
            // the chips/buttons are gone — bail out before touching them
            // and skip the queued recursion too.
            if (this._destroyed) return;
            this._refreshButton.remove_style_pseudo_class('active');
            if (this._refreshQueued) {
                const queuedShowPlaceholder = this._queuedShowPlaceholder;
                this._refreshQueued = false;
                this._queuedShowPlaceholder = false;
                this._fullRefresh({ showPlaceholder: queuedShowPlaceholder });
            }
        }
    }

    /**
     * Re-run DataProcessor against the cached entries with the current
     * settings, then rerender. This is the path taken when the user
     * changes a presentation-only setting (currency, sort, date range,
     * pricing overrides, etc.) — no file IO at all.
     */
    _quickReprocess() {
        try {
            this._renderFromCache();
        } catch (e) {
            console.error(`Code Usage: Reprocess failed: ${e.message}`);
        }
    }

    /**
     * Pull the current entries snapshot from the cache, run it through
     * DataProcessor, and update the UI. Used by both _fullRefresh (after
     * scanning) and _quickReprocess (settings-only path).
     */
    _renderFromCache() {
        const agents = this._settings.get_strv('selected-agents');
        const liveEntries = agents.length === 0 ? [] : this._dataSource.getEntries();
        let entries = liveEntries;
        if (agents.length > 0) {
            // Daily archive: snapshot yesterday past the 1 AM gate (no-op
            // except once per day), then inject archived days whose live logs
            // were deleted so processEntries aggregates them into every view.
            this._archive.maybeRunSnapshot(liveEntries, new Date());
            entries = this._archive.mergeIntoEntries(liveEntries, agents);
        }
        this._lastData = this._processor.processEntries(entries);
        this._updateDisplay(this._lastData);
        this._persistAchievementUnlocks(this._lastData);
    }

    _updatePanelLabel(data) {
        // Each chip independently displays its own metric so the values stay
        // aligned with their icons regardless of which chips are visible.
        this._tokenChip._label.set_text(data.totalRealTokensFormatted);
        this._costChip._label.set_text(data.totalCostFormatted);
        this._requestsChip._label.set_text(String(data.totalRequests));
    }

    _updateDisplay(data) {
        this._updatePanelLabel(data);

        this._requestCountCard._valueLabel.set_text(String(data.totalRequests));
        this._tokenCountCard._valueLabel.set_text(data.totalRealTokensFormatted);
        this._costCard._valueLabel.set_text(data.totalCostFormatted);

        this._updateModelList(data);
        this._updateTokenHeatmap(data);
        this._updateWeeklyReport(data);
        this._updateAchievementsPage(data);
    }

    _persistAchievementUnlocks(data) {
        const achievements = data.achievements;
        if (!achievements || !achievements.hasAchievementStateChanges) return;
        try {
            this._settings.set_string('achievement-state', JSON.stringify(achievements.updatedState || {}));
        } catch (e) {
            console.error(`Code Usage: Failed to persist achievement state: ${e.message}`);
        }
    }

    _updateWeeklyReport(data) {
        const report = data.weeklyReport;
        if (!report) return;

        this._weeklyTitleLabel.set_text(report.title || _('本周小结'));
        this._weeklySubtitleLabel.set_text(report.subtitle || '');
        this._weeklyTokenCard._valueLabel.set_text(report.totalTokensFormatted || '0');
        this._weeklyCostCard._valueLabel.set_text(report.totalCostFormatted || '¥0.00');
        this._weeklyActiveCard._valueLabel.set_text(`${report.activeDays || 0}`);

        this._weeklyDailyBars.destroy_all_children();
        for (const day of report.daily || []) {
            const dayBox = new St.BoxLayout({
                style_class: 'cu-weekly-day',
                vertical: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            dayBox.add_child(new St.Label({
                text: day.weekday,
                style_class: 'cu-weekly-day-label',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            const cell = new St.Widget({
                style_class: `cu-weekly-day-cell cu-heatmap-level-${day.level || 0}`,
            });
            dayBox.add_child(cell);
            dayBox.add_child(new St.Label({
                text: day.totalTokens > 0 ? day.totalTokensFormatted : '0',
                style_class: 'cu-weekly-day-value',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            this._weeklyDailyBars.add_child(dayBox);
        }

        this._weeklyHighlightList.destroy_all_children();
        for (const row of [
            [_('主力模型'), report.topModel || _('暂无')],
            [_('主力 Agent'), report.topAgent || _('暂无')],
            [_('缓存命中'), report.cacheHitRateFormatted || '0.0%'],
            [_('百万成本'), report.costPerMillionFormatted || '¥0.00'],
        ]) {
            this._weeklyHighlightList.add_child(this._createWeeklyInfoRow(row[0], row[1]));
        }

        this._weeklyBadgeList.destroy_all_children();
        const liveBadges = data.achievements?.items?.filter(item => item.isLive || item.newlyUnlocked) || [];
        const visibleBadges = liveBadges.length > 0 ? liveBadges : (data.achievements?.items || []).slice(0, 2);
        for (const item of visibleBadges.slice(0, 3)) {
            this._weeklyBadgeList.add_child(this._createBadgeRow(item, true));
        }
        if (visibleBadges.length === 0) {
            this._weeklyBadgeList.add_child(new St.Label({
                text: _('本周徽章还在路上'),
                style_class: 'cu-empty-label',
            }));
        }
    }

    _createWeeklyInfoRow(label, value) {
        const row = new St.BoxLayout({
            style_class: 'cu-weekly-info-row',
            vertical: false,
            x_expand: true,
        });
        row.add_child(new St.Label({
            text: label,
            style_class: 'cu-weekly-info-label',
            x_align: Clutter.ActorAlign.START,
        }));
        row.add_child(_makeEllipsizedLabel({
            text: value,
            style_class: 'cu-weekly-info-value',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        }));
        return row;
    }

    _updateAchievementsPage(data) {
        const achievements = data.achievements;
        const items = achievements?.items || [];
        const unlockedCount = items.filter(item => item.unlocked).length;
        this._achievementSummaryLabel.set_text(
            unlockedCount > 0
                ? `${_('已解锁')} ${unlockedCount}/${items.length}`
                : _('还没有解锁成就')
        );

        this._achievementList.destroy_all_children();
        for (const item of items) {
            this._achievementList.add_child(this._createBadgeRow(item, false));
        }
        if (items.length === 0) {
            this._achievementList.add_child(new St.Label({
                text: _('暂无成就数据'),
                style_class: 'cu-empty-label',
            }));
        }
    }

    _createBadgeRow(item, compact) {
        const card = new St.BoxLayout({
            style_class: item.unlocked || item.isLive
                ? 'cu-achievement-card cu-achievement-card-active'
                : 'cu-achievement-card',
            vertical: true,
            x_expand: true,
        });

        const header = new St.BoxLayout({
            style_class: 'cu-achievement-header',
            vertical: false,
            x_expand: true,
        });
        header.add_child(new St.Label({
            text: item.title,
            style_class: 'cu-achievement-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));
        const statusText = item.newlyUnlocked
            ? _('新解锁')
            : item.unlocked
                ? _('已解锁')
                : item.isLive
                    ? _('本周在线')
                    : `${item.valueLabel}/${item.thresholdLabel}`;
        header.add_child(new St.Label({
            text: statusText,
            style_class: item.unlocked || item.newlyUnlocked
                ? 'cu-achievement-status cu-achievement-status-unlocked'
                : 'cu-achievement-status',
            x_align: Clutter.ActorAlign.END,
        }));
        card.add_child(header);

        if (!compact) {
            card.add_child(new St.Label({
                text: item.description,
                style_class: 'cu-achievement-description',
            }));

            const progressBg = new St.Widget({
                style_class: 'cu-achievement-progress-bg',
                x_expand: true,
            });
            const progressBar = new St.Widget({
                style_class: 'cu-achievement-progress-bar',
            });
            progressBg.add_child(progressBar);
            progressBg.connect('notify::width', () => {
                const w = progressBg.get_width();
                if (w > 0) {
                    progressBar.set_width(Math.round(Math.max(0, Math.min(1, item.progress || 0)) * w));
                }
            });
            card.add_child(progressBg);
        }

        return card;
    }

    _updateTokenHeatmap(data) {
        this._heatmapWeeksData = data.heatmapWeeks || [];
        // Rebuilding 133 cells + hover signals is expensive and pointless
        // while the popup is closed (the grid is not visible). Defer it to
        // the menu open-state handler, mirroring _modelListDirty.
        if (this.menu.isOpen) {
            this._renderTokenHeatmap();
            this._heatmapDirty = false;
        } else {
            this._heatmapDirty = true;
        }
    }

    _renderTokenHeatmap() {
        // destroy_all_children (not remove_child) so connected hover signals
        // are properly released, avoiding GObject↔JS reference cycles that
        // GJS's GC can't reliably collect.
        this._heatmapGrid.destroy_all_children();

        this._heatmapDetailLabel.set_text(this._defaultHeatmapDetail(this._heatmapWeeksData));

        for (let weekIndex = 0; weekIndex < this._heatmapWeeksData.length; weekIndex++) {
            const week = this._heatmapWeeksData[weekIndex];
            const monthText = this._monthLabelForWeek(week, weekIndex);

            const weekCol = new St.BoxLayout({
                style_class: 'cu-heatmap-week',
                vertical: true,
            });
            const monthSlot = new St.BoxLayout({
                style_class: 'cu-heatmap-month-slot',
                x_align: Clutter.ActorAlign.START,
            });
            monthSlot.add_child(new St.Label({
                text: monthText,
                style_class: 'cu-heatmap-month-label',
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            weekCol.add_child(monthSlot);

            for (const day of week) {
                const level = day.level == null ? -1 : day.level;
                const cell = new St.Widget({
                    style_class: `cu-heatmap-cell cu-heatmap-level-${level}`,
                    reactive: day.inRange,
                    can_focus: day.inRange,
                });

                if (day.inRange) {
                    cell.track_hover = true;
                    cell.connect('notify::hover', () => {
                        if (cell.hover) {
                            this._heatmapDetailLabel.set_text(this._formatHeatmapDetail(day));
                        }
                    });
                }

                weekCol.add_child(cell);
            }
            this._heatmapGrid.add_child(weekCol);
        }
    }

    _formatHeatmapDetail(day) {
        return `${day.date} · ${day.totalTokensFormatted} Token · ${day.requestCount} ${_('次请求')}`;
    }

    _defaultHeatmapDetail(weeks) {
        for (let weekIndex = weeks.length - 1; weekIndex >= 0; weekIndex--) {
            const week = weeks[weekIndex];
            for (let dayIndex = week.length - 1; dayIndex >= 0; dayIndex--) {
                const day = week[dayIndex];
                if (day.inRange && day.totalTokens > 0) {
                    return this._formatHeatmapDetail(day);
                }
            }
        }
        return _('悬停查看详情');
    }

    _monthLabelForWeek(week, weekIndex) {
        for (const day of week) {
            if (!day.inRange) continue;
            const parts = day.date.split('-');
            if (parts.length === 3 && parts[2] === '01') {
                return `${Number(parts[1])}${_('月')}`;
            }
        }
        if (weekIndex !== 0) return '';
        const first = week.find(day => day.inRange);
        if (!first) return '';
        const month = Number(first.date.split('-')[1]);
        return month ? `${month}${_('月')}` : '';
    }

    _updateModelList(data) {
        this._modelListData = data.modelStats || [];
        // _renderModelList rebuilds dozens of St widgets; skip it while the
        // popup menu is closed (the cards are not visible anyway). The dirty
        // flag tells the menu open-state handler to render on next open.
        if (this.menu.isOpen) {
            this._renderModelList();
            this._modelListDirty = false;
        } else {
            this._modelListDirty = true;
        }
    }

    _renderModelList() {
        // destroy_all_children (not remove_child) so the notify::width signal
        // closures on progress bars are properly released, avoiding
        // GObject↔JS reference cycles that GJS's GC can't reliably collect.
        this._modelListContainer.destroy_all_children();

        const models = this._modelListData;
        const expanded = this._modelExpanded;
        const pageSize = expanded ? MODEL_EXPANDED_PAGE_SIZE : MODEL_COLLAPSED_PAGE_SIZE;
        // Defensive clamp: if the dataset has shrunk (e.g. agent filter or
        // sort order changed) and the stored page index would be empty,
        // fall back to the first page.
        const totalPagesAvailable = Math.max(1, Math.ceil(models.length / pageSize));
        if (this._modelPage >= totalPagesAvailable) {
            this._modelPage = 0;
        }
        const page = expanded ? this._modelPage : 0;
        const start = page * pageSize;
        const end = Math.min(start + pageSize, models.length);

        for (let i = start; i < end; i++) {
            const ms = models[i];
            const card = new St.BoxLayout({
                style_class: 'cu-model-card',
                vertical: true,
                x_expand: true,
            });

            const headerRow = new St.BoxLayout({
                style_class: 'cu-model-header-row',
                vertical: false,
                x_expand: true,
            });

            const agentColor = AGENT_BRAND_COLORS[ms.agent] || '#3584e4';
            const agentTextColor = AGENT_BRAND_TEXT_COLORS[ms.agent] || '#ffffff';
            const agentTag = new St.Label({
                text: ms.agentName,
                style_class: 'cu-model-agent-tag',
            });
            agentTag.set_style(`background-color: ${agentColor}; color: ${agentTextColor};`);
            headerRow.add_child(agentTag);

            const fullName = ms.displayName || ms.model;
            const name = _makeEllipsizedLabel({
                text: fullName,
                style_class: 'cu-model-name',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            _attachHoverTooltip(
                name,
                () => fullName,
                () => {
                    // Only show tooltip if the text is actually ellipsized.
                    const layout = name.clutter_text.get_layout();
                    if (layout && typeof layout.is_ellipsized === 'function') {
                        return layout.is_ellipsized();
                    }
                    // Fallback: show if text is reasonably long.
                    return fullName.length > 18;
                }
            );
            headerRow.add_child(name);

            const cost = new St.Label({
                text: ms.totalCostFormatted,
                style_class: 'cu-model-cost',
            });
            headerRow.add_child(cost);

            card.add_child(headerRow);

            const progressBg = new St.Widget({
                style_class: 'cu-model-progress-bg',
                x_expand: true,
            });
            const progressBar = new St.Widget({
                style_class: 'cu-model-progress-bar',
            });
            progressBg.add_child(progressBar);
            card.add_child(progressBg);

            // Render the cost-share bar dynamically based on the actual bg width
            // so a 100% ratio fills the entire card width.
            const updateCostBar = () => {
                const w = progressBg.get_width();
                if (w > 0) {
                    progressBar.set_width(Math.max(Math.round(ms.percentage * w), 2));
                }
            };
            progressBg.connect('notify::width', updateCostBar);

            const cacheProgressBg = new St.Widget({
                style_class: 'cu-model-progress-bg cu-model-cache-progress-bg',
                x_expand: true,
            });
            const cacheProgressBar = new St.Widget({
                style_class: 'cu-model-progress-bar cu-model-cache-progress-bar',
            });
            cacheProgressBg.add_child(cacheProgressBar);
            card.add_child(cacheProgressBg);

            // Same dynamic sizing for the cache hit-rate bar so the visual
            // length matches the displayed percentage text.
            const updateCacheBar = () => {
                const w = cacheProgressBg.get_width();
                if (w > 0) {
                    cacheProgressBar.set_width(Math.max(Math.round(ms.cacheHitRate * w), 2));
                }
            };
            cacheProgressBg.connect('notify::width', updateCacheBar);

            const detailRow1 = new St.BoxLayout({
                style_class: 'cu-model-detail-row',
                vertical: false,
                x_expand: true,
            });

            const row1Col1 = new St.BoxLayout({ style_class: 'cu-model-detail-col', x_expand: true, x_align: Clutter.ActorAlign.START });
            const row1Col2 = new St.BoxLayout({ style_class: 'cu-model-detail-col', x_expand: true, x_align: Clutter.ActorAlign.START });
            const row1Col3 = new St.BoxLayout({ style_class: 'cu-model-detail-col', x_expand: true, x_align: Clutter.ActorAlign.END });

            const inputLbl = _makeEllipsizedLabel({
                text: `${_('输入')} ${ms.inputTokensFormatted}`,
                style_class: 'cu-token-input',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            row1Col1.add_child(inputLbl);

            const outputLbl = _makeEllipsizedLabel({
                text: `${_('输出')} ${ms.outputTokensFormatted}`,
                style_class: 'cu-token-output',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            row1Col2.add_child(outputLbl);

            const cacheReadLbl = _makeEllipsizedLabel({
                text: `${_('缓存读')} ${ms.cacheReadTokensFormatted}`,
                style_class: 'cu-token-cache-read',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
            });
            row1Col3.add_child(cacheReadLbl);

            detailRow1.add_child(row1Col1);
            detailRow1.add_child(row1Col2);
            detailRow1.add_child(row1Col3);
            card.add_child(detailRow1);

            const detailRow2 = new St.BoxLayout({
                style_class: 'cu-model-detail-row',
                vertical: false,
                x_expand: true,
            });

            const row2Col1 = new St.BoxLayout({ style_class: 'cu-model-detail-col', x_expand: true, x_align: Clutter.ActorAlign.START });
            const row2Col2 = new St.BoxLayout({ style_class: 'cu-model-detail-col', x_expand: true, x_align: Clutter.ActorAlign.START });
            const row2Col3 = new St.BoxLayout({ style_class: 'cu-model-detail-col', x_expand: true, x_align: Clutter.ActorAlign.END });

            const hitRateLbl = _makeEllipsizedLabel({
                text: `${_('命中')} ${ms.cacheHitRateFormatted}`,
                style_class: 'cu-token-cache-hit',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            row2Col1.add_child(hitRateLbl);

            const totalLbl = _makeEllipsizedLabel({
                text: `${_('总量')} ${ms.totalTokensFormatted}`,
                style_class: 'cu-token-total',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            row2Col2.add_child(totalLbl);

            const requestsLbl = _makeEllipsizedLabel({
                text: `${_('请求数')} ${ms.requestCount}`,
                style_class: 'cu-token-requests',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
            });
            row2Col3.add_child(requestsLbl);

            detailRow2.add_child(row2Col1);
            detailRow2.add_child(row2Col2);
            detailRow2.add_child(row2Col3);
            card.add_child(detailRow2);
            this._modelListContainer.add_child(card);
        }

        if (models.length === 0) {
            const empty = new St.Label({
                text: _('暂无数据'),
                style_class: 'cu-empty-label',
            });
            this._modelListContainer.add_child(empty);
        }

        if (models.length > MODEL_COLLAPSED_PAGE_SIZE) {
            this._modelExpander.show();
            this._modelExpander.set_label(expanded ? _('收起 ▲') : _('展开更多 ▼'));
        } else {
            this._modelExpander.hide();
        }

        if (expanded && models.length > MODEL_EXPANDED_PAGE_SIZE) {
            this._modelPaginationBox.show();
            const totalPages = Math.ceil(models.length / MODEL_EXPANDED_PAGE_SIZE);
            this._modelPageLabel.set_text(`${page + 1}/${totalPages}`);
            if (page <= 0) {
                this._modelPagePrev.add_style_class_name('cu-model-page-btn-disabled');
            } else {
                this._modelPagePrev.remove_style_class_name('cu-model-page-btn-disabled');
            }
            if (page >= totalPages - 1) {
                this._modelPageNext.add_style_class_name('cu-model-page-btn-disabled');
            } else {
                this._modelPageNext.remove_style_class_name('cu-model-page-btn-disabled');
            }
        } else {
            this._modelPaginationBox.hide();
        }
    }

    destroy() {
        // Mark destroyed first and bump the generation so any in-flight
        // async _fullRefresh bails out at its next await resumption point
        // instead of touching already-destroyed St widgets.
        this._destroyed = true;
        ++this._refreshGeneration;
        this._stopTimer();
        if (this._reprocessDebounceId) {
            GLib.source_remove(this._reprocessDebounceId);
            this._reprocessDebounceId = 0;
        }
        if (this._timerRestartDebounceId) {
            GLib.source_remove(this._timerRestartDebounceId);
            this._timerRestartDebounceId = 0;
        }
        if (this._menuOpenStateId) {
            try { this.menu.disconnect(this._menuOpenStateId); } catch (_e) { /* ignore */ }
            this._menuOpenStateId = null;
        }
        Main.panel.menuManager.removeMenu(this.menu);
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        super.destroy();
    }
});
