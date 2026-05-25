import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { CodeUsageIndicator, setGettext } from './modules/panelIndicator.js';

export default class CodeUsageExtension extends Extension {
    enable() {
        setGettext(_);
        this._settings = this.getSettings();
        this._indicator = new CodeUsageIndicator(
            this.path,
            this._settings,
            () => this.openPreferences()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}