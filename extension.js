const Main = imports.ui.main;
const Util = imports.misc.util;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const PanelIndicator = Me.imports.modules.panelIndicator;
const CodeUsageIndicator = PanelIndicator.CodeUsageIndicator;
const setGettext = PanelIndicator.setGettext;

const _ = ExtensionUtils.gettext;

let _settings = null;
let _indicator = null;
let _posChangedId = null;

function _applyPosition() {
    if (!_indicator || !_settings) return;

    const pos = _settings.get_string('panel-position');
    const parent = _indicator.get_parent ? _indicator.get_parent() : _indicator.actor.get_parent();
    if (parent) {
        parent.remove_child(_indicator);
    }

    let box;
    if (pos.indexOf('left') !== -1) {
        box = Main.panel._leftBox;
    } else if (pos === 'center') {
        box = Main.panel._centerBox;
    } else {
        box = Main.panel._rightBox;
    }

    if (pos === 'far-left' || pos === 'right') {
        box.insert_child_at_index(_indicator, 0);
    } else {
        box.add_child(_indicator);
    }
}

function _openPreferences() {
    try {
        if (ExtensionUtils.openPrefs) {
            ExtensionUtils.openPrefs();
            return;
        }
    } catch (e) {
        // Fall through to command based prefs launchers.
    }

    try {
        Util.spawn(['gnome-extensions', 'prefs', Me.uuid]);
    } catch (e1) {
        try {
            Util.spawn(['gnome-shell-extension-prefs', Me.uuid]);
        } catch (e2) {
            log(`Code Usage: failed to open preferences: ${e2.message}`);
        }
    }
}

function init() {
    ExtensionUtils.initTranslations(Me.metadata['gettext-domain'] || Me.uuid);
}

function enable() {
    setGettext(_);
    _settings = ExtensionUtils.getSettings('org.gnome.shell.extensions.code-usage');
    _indicator = new CodeUsageIndicator(Me.path, _settings, _openPreferences);
    _applyPosition();
    _posChangedId = _settings.connect('changed::panel-position', _applyPosition);
}

function disable() {
    if (_settings && _posChangedId) {
        _settings.disconnect(_posChangedId);
        _posChangedId = null;
    }
    if (_indicator) {
        _indicator.destroy();
        _indicator = null;
    }
    _settings = null;
}
