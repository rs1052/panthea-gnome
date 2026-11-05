// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {AppIcon, AppSearchProvider} from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {GridSearchResults} from 'resource:///org/gnome/shell/ui/search.js';

const PopupSearchAppIcon = GObject.registerClass(
class PopupSearchAppIcon extends AppIcon {
    _init(app, launcher) {
        super._init(app, {expandTitleOnHover: false});
        // Search keeps its larger icons independently of the browsing grid.
        this.icon.setIconSize(72);
        this._launcher = launcher;
        this.connect('destroy', () => this._menu?.destroy());
    }

    activate(button) {
        try {
            super.activate(button);
        } catch (error) {
            Main.notifyError(`Could not open ${this.app.get_name()}`, error.message);
        }
        this._launcher.menu.close();
    }
});

// Own only the application section, not Overview's controller or remote
// providers. GNOME supplies result caching, row sizing, spacing and centering.
export const PopupAppSearch = GObject.registerClass(
class PopupAppSearch extends GridSearchResults {
    _init(launcher) {
        super._init(new AppSearchProvider(), null);
        this._launcher = launcher;
    }

    _onDestroy() {
        this._destroyed = true;
        this.close();
        this._cancellable.cancel();
        super._onDestroy();
    }

    async _ensureResultActors(results) {
        // Native searches await metadata even though app metadata is local.
        // Disabling can destroy this section before that promise resumes.
        try {
            await super._ensureResultActors(results);
        } catch (error) {
            if (!this._destroyed)
                throw error;
        }
        if (this._destroyed) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.CANCELLED,
                message: 'Application search destroyed',
            });
        }
    }

    _createResultDisplay(meta) {
        return new PopupSearchAppIcon(Shell.AppSystem.get_default().lookup_app(meta.id), this._launcher);
    }

    _getMaxDisplayedResults() {
        const maximum = super._getMaxDisplayedResults();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const icon = this._grid.get_first_child();
        if (icon && this.width)
            this._tileWidth = icon.get_preferred_width(-1)[0] / scale;
        if (!this._tileWidth)
            return maximum;
        // Native column counting can include a final tile whose spacing does
        // not fit. Avoid a clipped, off-center row at the compact popup width.
        const spacing = this._grid.layout_manager.spacing;
        const root = this._launcher._root;
        const width = root.get_theme_node().get_content_box(root.get_allocation_box()).get_width();
        const columns = Math.max(1, Math.floor((width + spacing) / (this._tileWidth * scale + spacing)));
        return maximum < 0 ? columns : Math.min(maximum, columns);
    }

    _clearResultDisplay() {
        if (this._destroyed)
            return;
        for (const icon of this._grid)
            icon.remove_style_pseudo_class('selected');
        super._clearResultDisplay();
    }

    _addItem(icon) {
        super._addItem(icon);
        this.highlightDefault();
    }

    highlightDefault() {
        const first = this.getFirstResult();
        if (first) {
            const focused = global.stage.key_focus;
            if (focused && this._launcher._search.contains(focused))
                first.add_style_pseudo_class('selected');
            else
                first.remove_style_pseudo_class('selected');
        }
    }

    close() {
        // Cached icons may be detached from the row but still own menus.
        for (const icon of Object.values(this._resultDisplays)) {
            icon._menu?.close();
            const draggable = icon._draggable;
            if (draggable?._grab) {
                if (!draggable._animationInProgress)
                    draggable._cancelDrag(global.get_current_time());
                draggable._dragActor?.remove_all_transitions();
            }
        }
    }
});
