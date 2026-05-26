const Gtk = imports.gi.Gtk;
const Gio = imports.gi.Gio;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const DefaultPricing = Me.imports.modules.defaultPricing;

const _ = ExtensionUtils.gettext;
const SCHEMA_ID = 'org.gnome.shell.extensions.code-usage';

function init() {
    ExtensionUtils.initTranslations(Me.metadata['gettext-domain'] || Me.uuid);
}

function _add(parent, child) {
    if (parent.append) {
        parent.append(child);
    } else if (parent.add) {
        parent.add(child);
    } else if (parent.pack_start) {
        parent.pack_start(child, false, false, 0);
    }
}

function _setChild(parent, child) {
    if (parent.set_child) {
        parent.set_child(child);
    } else {
        parent.add(child);
    }
}

function _setMargins(widget, value) {
    widget.margin_top = value;
    widget.margin_bottom = value;
    widget.margin_start = value;
    widget.margin_end = value;
}

function _box(orientation, spacing) {
    return new Gtk.Box({ orientation, spacing });
}

function _label(text, options) {
    options = options || {};
    const label = new Gtk.Label({ label: text, xalign: 0 });
    label.set_line_wrap(true);
    if (options.bold) {
        label.set_markup(`<b>${GLibMarkup.escape(text)}</b>`);
    }
    return label;
}

const GLibMarkup = {
    escape(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },
};

function _group(title, description) {
    const frame = new Gtk.Frame();
    if (frame.set_label) frame.set_label(title);
    const inner = _box(Gtk.Orientation.VERTICAL, 10);
    _setMargins(inner, 12);
    if (description) {
        const desc = _label(description);
        if (desc.get_style_context) desc.get_style_context().add_class('dim-label');
        _add(inner, desc);
    }
    _setChild(frame, inner);
    return { frame, inner };
}

function _row(parent, title, subtitle, control) {
    const row = _box(Gtk.Orientation.HORIZONTAL, 12);
    _setMargins(row, 4);
    const labels = _box(Gtk.Orientation.VERTICAL, 2);
    labels.hexpand = true;
    _add(labels, _label(title));
    if (subtitle) {
        const sub = _label(subtitle);
        if (sub.get_style_context) sub.get_style_context().add_class('dim-label');
        _add(labels, sub);
    }
    _add(row, labels);
    if (control) _add(row, control);
    _add(parent, row);
    return row;
}

function _spin(settings, key, lower, upper, step, digits) {
    const adjustment = new Gtk.Adjustment({
        lower,
        upper,
        step_increment: step,
        page_increment: step * 10,
        value: settings.get_value(key).unpack(),
    });
    const spin = new Gtk.SpinButton({ adjustment, digits: digits || 0, numeric: true });
    spin.set_value(settings.get_value(key).unpack());
    spin.connect('value-changed', () => {
        if (digits && digits > 0) settings.set_double(key, spin.get_value());
        else settings.set_int(key, spin.get_value_as_int());
    });
    return spin;
}

function _switch(settings, key) {
    const sw = new Gtk.Switch({ active: settings.get_boolean(key), valign: Gtk.Align.CENTER });
    sw.connect('notify::active', () => settings.set_boolean(key, sw.active));
    return sw;
}

function _entry(settings, key, placeholder) {
    const entry = new Gtk.Entry({ text: settings.get_string(key), hexpand: false });
    if (placeholder && entry.set_placeholder_text) entry.set_placeholder_text(placeholder);
    entry.connect('changed', () => settings.set_string(key, entry.get_text()));
    return entry;
}

function _choice(settings, key, choices) {
    const current = settings.get_string(key);
    let selected = choices.findIndex(c => c[0] === current);
    if (selected < 0) selected = 0;

    if (Gtk.DropDown && Gtk.StringList) {
        const model = new Gtk.StringList();
        choices.forEach(c => model.append(c[1]));
        const dropdown = new Gtk.DropDown({ model, selected });
        dropdown.connect('notify::selected', () => {
            settings.set_string(key, choices[dropdown.get_selected()][0]);
        });
        return dropdown;
    }

    const combo = new Gtk.ComboBoxText();
    choices.forEach(c => combo.append(c[0], c[1]));
    combo.set_active_id(choices[selected][0]);
    combo.connect('changed', () => {
        const id = combo.get_active_id();
        if (id) settings.set_string(key, id);
    });
    return combo;
}

function _selectedAgents(settings) {
    try {
        return settings.get_strv('selected-agents');
    } catch (e) {
        return ['claude'];
    }
}

function _setSelectedAgent(settings, id, enabled) {
    let agents = _selectedAgents(settings);
    if (enabled) {
        if (agents.indexOf(id) === -1) agents.push(id);
    } else {
        agents = agents.filter(agent => agent !== id);
        if (agents.length === 0) agents = ['claude'];
    }
    settings.set_strv('selected-agents', agents);
}

function _buildGeneralPage(root, settings) {
    let group = _group(_('刷新间隔'), _('检测到日志最近 2 分钟内有写入时使用活跃间隔，否则使用空闲间隔。'));
    _row(group.inner, _('活跃刷新间隔'), _('agent 正在写入日志时的轮询间隔（秒，5-300）'), _spin(settings, 'active-refresh-interval', 5, 300, 5, 0));
    _row(group.inner, _('空闲刷新间隔'), _('日志静默时的轮询间隔（秒，30-3600）'), _spin(settings, 'idle-refresh-interval', 30, 3600, 30, 0));
    _add(root, group.frame);

    group = _group(_('面板显示'), _('配置顶部面板的显示内容和位置。'));
    _row(group.inner, _('显示模式'), '', _choice(settings, 'display-mode', [
        ['tokens', _('Token 数')], ['cost', _('费用')], ['requests', _('请求数')], ['all', _('全部')],
    ]));
    _row(group.inner, _('显示图标'), '', _switch(settings, 'show-icon'));
    _row(group.inner, _('面板位置'), '', _choice(settings, 'panel-position', [
        ['right', _('靠右')], ['left', _('靠左')], ['center', _('居中')], ['far-right', _('最右')], ['far-left', _('最左')],
    ]));
    _add(root, group.frame);

    group = _group(_('日期范围'), _('选择统计数据的日期范围。'));
    _row(group.inner, _('日期预设'), '', _choice(settings, 'date-range-preset', [
        ['today', _('今天')], ['7d', _('7 天')], ['30d', _('30 天')], ['custom', _('自定义')], ['all', _('全部')],
    ]));
    _row(group.inner, _('起始日期'), _('格式 YYYY-MM-DD，仅自定义日期范围使用。'), _entry(settings, 'custom-date-since', 'YYYY-MM-DD'));
    _row(group.inner, _('截止日期'), _('格式 YYYY-MM-DD，仅自定义日期范围使用。'), _entry(settings, 'custom-date-until', 'YYYY-MM-DD'));
    _add(root, group.frame);
}

function _buildAgentsPage(root, settings) {
    const group = _group(_('监控代理'), _('选择要扫描的本地编码代理日志。'));
    for (const agent of DefaultPricing.SUPPORTED_AGENTS) {
        const check = new Gtk.CheckButton({ label: agent.name, active: _selectedAgents(settings).indexOf(agent.id) !== -1 });
        check.connect('toggled', () => _setSelectedAgent(settings, agent.id, check.get_active()));
        _add(group.inner, check);
    }
    _add(root, group.frame);
}

function _buildCostPage(root, settings) {
    let group = _group(_('费用显示'), _('配置费用显示、换算和定价覆盖。'));
    _row(group.inner, _('显示货币'), '', _choice(settings, 'cost-currency', [['CNY', _('人民币 CNY')], ['USD', _('美元 USD')]]));
    _row(group.inner, _('CNY 汇率'), _('1 USD 等于多少 CNY。'), _spin(settings, 'cny-exchange-rate', 0.1, 100, 0.1, 2));
    _row(group.inner, _('成本倍率'), _('应用于总成本的倍率。'), _spin(settings, 'cost-multiplier', 0.1, 100, 0.1, 2));
    _row(group.inner, _('Token 显示格式'), '', _choice(settings, 'token-display-format', [
        ['auto', _('自动')], ['K', 'K'], ['M', 'M'], ['B', 'B'], ['raw', _('原始数值')],
    ]));
    _row(group.inner, _('日期排序'), '', _choice(settings, 'sort-order', [['desc', _('降序')], ['asc', _('升序')]]));
    _add(root, group.frame);

    group = _group(_('自定义模型定价'), _('JSON 对象，键为模型 ID，值包含 input/output/cacheRead/cacheWrite。'));
    const entry = new Gtk.Entry({ text: settings.get_string('price-overrides'), hexpand: true });
    entry.connect('changed', () => settings.set_string('price-overrides', entry.get_text()));
    _row(group.inner, _('价格覆盖 JSON'), '', entry);
    _add(root, group.frame);
}

function _buildAdvancedPage(root, settings) {
    const group = _group(_('高级'), _('排查问题时可启用调试日志。'));
    _row(group.inner, _('调试模式'), '', _switch(settings, 'debug-mode'));
    _add(root, group.frame);
}

function buildPrefsWidget() {
    const settings = ExtensionUtils.getSettings(SCHEMA_ID);
    const scrolled = new Gtk.ScrolledWindow();
    if (scrolled.set_policy) scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);

    const root = _box(Gtk.Orientation.VERTICAL, 14);
    _setMargins(root, 16);
    root.hexpand = true;
    root.vexpand = true;

    _buildGeneralPage(root, settings);
    _buildAgentsPage(root, settings);
    _buildCostPage(root, settings);
    _buildAdvancedPage(root, settings);

    _setChild(scrolled, root);
    if (scrolled.show_all) scrolled.show_all();
    return scrolled;
}
