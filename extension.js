import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { CodeUsageIndicator, setGettext } from './modules/panelIndicator.js';

export default class CodeUsageExtension extends Extension {
    _applyPosition() {
        const pos = this._settings.get_string('panel-position');
        const parent = this._indicator.get_parent();
        if (parent) {
            parent.remove_child(this._indicator);
        }
        let box;
        if (pos.includes('left')) {
            box = Main.panel._leftBox;
        } else if (pos === 'center') {
            box = Main.panel._centerBox;
        } else {
            box = Main.panel._rightBox;
        }
        if (pos.startsWith('far-')) {
            box.insert_child_at_index(this._indicator, 0);
        } else {
            box.add_child(this._indicator);
        }
    }

    enable() {
        setGettext(_);
        this._settings = this.getSettings();
        this._indicator = new CodeUsageIndicator(
            this.path,
            this._settings,
            () => this.openPreferences()
        );
        this._applyPosition();
        this._posChangedId = this._settings.connect('changed::panel-position', () => {
            this._applyPosition();
        });
    }

    disable() {
        if (this._posChangedId) {
            this._settings.disconnect(this._posChangedId);
            this._posChangedId = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}