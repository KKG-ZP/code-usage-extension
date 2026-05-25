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
        const pos = this._settings.get_string('panel-position');
        const box = pos.includes('left') ? Main.panel._leftBox
            : pos === 'center' ? Main.panel._centerBox
            : Main.panel._rightBox;
        const index = pos.startsWith('far-') ? 0 : undefined;
        Main.panel.addToStatusArea(this.uuid, this._indicator, index, box);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}