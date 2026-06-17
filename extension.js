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
        if (pos === 'left' || pos === 'far-left') {
            box = Main.panel._leftBox;
        } else if (pos === 'center') {
            box = Main.panel._centerBox;
        } else {
            box = Main.panel._rightBox;
        }
        // far-left 插入左 box 最前方（最左靠边），right 插入右 box 最前方（靠右近中）
        // 其他情况 add_child：far-right 追加到右 box 末尾（最右靠边），left 追加到左 box 末尾（靠左近中）
        if (pos === 'far-left' || pos === 'right') {
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