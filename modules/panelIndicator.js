const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const DataSource = Me.imports.modules.dataSource.DataSource;
const DataProcessor = Me.imports.modules.dataProcessor.DataProcessor;
const IDLE_THRESHOLD_MS = Me.imports.modules.cacheManager.IDLE_THRESHOLD_MS;
const DefaultPricing = Me.imports.modules.defaultPricing;
const AGENT_BRAND_COLORS = DefaultPricing.AGENT_BRAND_COLORS;
const AGENT_BRAND_TEXT_COLORS = DefaultPricing.AGENT_BRAND_TEXT_COLORS;

let _ = (s) => s;

function setGettext(fn) {
    _ = fn;
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
function _attachHoverTooltip(actor, getText, shouldShow) {
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
            const actorH = actor.get_height();
            // Place tooltip just below the actor, slightly indented from left edge.
            const tx = Math.round(x);
            const ty = Math.round(y + actorH + 2);
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

const DATE_PRESETS = [
    { id: 'today', label: _('今天') },
    { id: '7d', label: _('7天') },
    { id: '30d', label: _('30天') },
    { id: 'all', label: _('全部') },
];

var CodeUsageIndicator = GObject.registerClass(
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
        this._refreshQueued = false;
        this._queuedShowPlaceholder = false;
        this._refreshGeneration = 0;
        this._modelExpanded = false;
        this._modelPage = 0;
        this._modelListData = [];
        this._modelListDirty = false;
        // Adaptive timer state: 'active' uses active-refresh-interval, 'idle'
        // uses idle-refresh-interval. Transitions happen after each scan
        // based on how long ago the most recent log write was.
        this._intervalState = 'idle';
        this._lastActivityAt = 0;

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
            this._fullRefresh({ showPlaceholder: true });
        });

        this._updateDisplayMode();
        this._updateIconVisibility();

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            switch (key) {
                case 'active-refresh-interval':
                case 'idle-refresh-interval':
                    this._restartTimer();
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
                case 'date-range-preset':
                case 'custom-date-since':
                case 'custom-date-until':
                case 'token-display-format':
                case 'debug-mode':
                    // Pure presentation/aggregation changes → re-process the
                    // cached entries with current settings, no IO.
                    this._quickReprocess();
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
            style_class: 'cu-hero-box',
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

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const modelSectionBox = new St.BoxLayout({
            style_class: 'cu-model-section',
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
            const totalPages = Math.ceil(models.length / 10);
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

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const dateBox = new St.BoxLayout({
            style_class: 'cu-date-section',
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
        for (const preset of DATE_PRESETS) {
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

        this._updateDateButtonStyles();
    }

    _createStatCard(labelText, valueText, extraClass) {
        const card = new St.BoxLayout({
            style_class: `cu-stat-card ${extraClass}`,
            vertical: true,
            x_expand: true,
        });
        const value = new St.Label({
            text: valueText,
            style_class: 'cu-stat-value',
            x_align: Clutter.ActorAlign.START,
        });
        const label = new St.Label({
            text: labelText,
            style_class: 'cu-stat-label',
            x_align: Clutter.ActorAlign.START,
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
        const entries = agents.length === 0 ? [] : this._dataSource.getEntries();
        this._lastData = this._processor.processEntries(entries);
        this._updateDisplay(this._lastData);
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
        const children = this._modelListContainer.get_children();
        for (const child of children) {
            this._modelListContainer.remove_child(child);
        }

        const models = this._modelListData;
        const expanded = this._modelExpanded;
        const pageSize = expanded ? 10 : 5;
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

        if (models.length > 5) {
            this._modelExpander.show();
            this._modelExpander.set_label(expanded ? _('收起 ▲') : _('展开更多 ▼'));
        } else {
            this._modelExpander.hide();
        }

        if (expanded && models.length > 10) {
            this._modelPaginationBox.show();
            const totalPages = Math.ceil(models.length / 10);
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
        this._stopTimer();
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