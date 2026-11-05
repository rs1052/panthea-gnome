// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {AppDisplay} from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// AppDisplay's normal constructor assumes Shell-lifetime ownership. Initialize
// its native base view instead, sharing Overview's PageManager and owning every
// additional connection. Native classes provide the grid, icons, folders and DND.
export const PopupAppDisplay = GObject.registerClass(
class PopupAppDisplay extends AppDisplay {
    _init(launcher) {
        Object.getPrototypeOf(AppDisplay.prototype)._init.call(this, {
            layout_manager: new Clutter.BinLayout(),
            x_expand: true, y_expand: true,
        });
        this._launcher = launcher;
        this._native = Main.overview._overview.controls.appDisplay;
        this._pageManager = this._native._pageManager;
        this._grid.setGridModes([{columns: 6, rows: 3}]);
        this._grid._setGridMode(-1);
        this._grid._setGridMode(0);
        // The native layout reserves 10% of each page for Overview's previews.
        // Only this popup needs compact gutters. Keep its native allocation,
        // preview animation and drag targets, but reserve just the arrow width.
        this._appGridLayout._getIndicatorsWidth = box => {
            const height = box.get_height();
            return Math.max(this._prevPageArrow.get_preferred_width(height)[0],
                this._nextPageArrow.get_preferred_width(height)[0]);
        };
        this._native.connectObject('view-loaded', () => {
            this._nativeLayoutPending = false;
            Main.queueDeferredWork(this._redisplayWorkId);
        }, this);
        global.settings.connectObject('changed::app-picker-layout', () => {
            if (!this._savingPages)
                this._redisplay();
        }, this);
        this.add_child(this._box);
        this._folderIcons = [];
        this._currentDialog = null;
        this._displayingDialog = false;
        this._placeholder = null;
        this._redisplayWorkId = Main.initializeDeferredWork(this, () => this._redisplay());
        Shell.AppSystem.get_default().connectObject('installed-changed',
            () => Main.queueDeferredWork(this._redisplayWorkId), this);
        this._folderSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.app-folders'});
        this._folderSettings.connectObject('changed::folder-children',
            () => Main.queueDeferredWork(this._redisplayWorkId), this);
        Main.overview.connectObject('showing', () => launcher.menu.close(), this);
        this._closeOnActivation(this);
    }

    _closeOnActivation(view) {
        const connectItems = () => {
            for (const item of view.getAllItems()) {
                // Keep native drag actors and their styling, scaling the whole
                // actor rather than replacing folder tiles with bare previews.
                item.getDragActor = () => {
                    const actor = Object.getPrototypeOf(item).getDragActor.call(item);
                    if (!item.app)
                        actor.label?.hide();
                    // Native folder icons build their texture only once styled
                    // in uiGroup, so size the preview after its first allocation.
                    actor.connect('notify::allocation', () => {
                        const size = 32 *
                            St.ThemeContext.get_for_stage(global.stage).scale_factor;
                        const scale = Math.min(1, size / Math.max(actor.width, actor.height));
                        actor.set_scale(scale, scale);
                    });
                    return actor;
                };
                // Native multiline expansion changes the tile's hover geometry.
                // Keep popup labels ellipsized without changing Overview's icons.
                if (view === this)
                    item._expandTitleOnHover = false;
                if (item.app && !item._pantheaActivationId)
                    item._pantheaActivationId = item.connect('clicked', () => this._launcher.menu.close());
            }
        };
        view.connect('view-loaded', connectItems);
        connectItems();
    }

    _redisplay() {
        const seed = !this._nativeLayoutPending && this._native.getAllItems().length > 0;
        // Overview may already have icons from startup signals, but its initial
        // deferred redisplay waits for mapping or timeout. Start from the same
        // native positions, then apply that pending pass using the shared layout.
        // Reseed every refresh until it runs, otherwise each popup redisplay
        // moves only saved items again and shifts apps missing from the saved map.
        const pending = seed && this._native._overviewHiddenId === 0;
        this._copyNativePositions = seed;
        try {
            super._redisplay();
        } finally {
            this._copyNativePositions = false;
        }
        if (pending)
            super._redisplay();
        this._compactPages();
    }

    _getSourcePosition(item) {
        const nativeReady = !this._nativeLayoutPending && this._native._overviewHiddenId !== 0;
        if ((this._copyNativePositions || nativeReady) && item !== this._placeholder) {
            const nativeItem = this._native._items.get(item.id);
            if (nativeItem)
                return this._native._grid.getItemPosition(nativeItem);
        }
        return super._getItemPosition(item);
    }

    _loadApps() {
        const apps = super._loadApps();
        const pages = new Map();
        for (const item of apps) {
            if (item === this._placeholder)
                continue;
            const [page, position] = this._getSourcePosition(item);
            if (page < 0 || position < 0)
                continue;
            if (!pages.has(page))
                pages.set(page, []);
            pages.get(page).push({id: item.id, position});
        }
        // Resolve native positions before compacting. Incomplete saved layouts
        // insert positioned items among runtime-only apps during startup.
        this._popupPositions = new Map();
        let previousPage = -1;
        let popupPage = 0;
        for (const [page, items] of [...pages].sort(([a], [b]) => a - b)) {
            popupPage += page - previousPage - 1;
            items.sort((a, b) => a.position - b.position);
            items.forEach(({id, position}) => this._popupPositions.set(id, [
                popupPage + Math.floor(position / this._grid.itemsPerPage),
                position % this._grid.itemsPerPage,
            ]));
            popupPage += Math.ceil((items.at(-1).position + 1) / this._grid.itemsPerPage);
            previousPage = page;
        }
        return apps;
    }

    _getItemPosition(item) {
        if (item === this._placeholder)
            return super._getItemPosition(item);
        return this._popupPositions?.get(item.id) ?? super._getItemPosition(item);
    }

    _compactPages() {
        // Keep native drag targets stable until the gesture has finished.
        if (this._dragMonitor)
            return;
        const items = Array.from({length: this._grid.nPages}, (_, page) =>
            this._grid.getItemsAtPage(page).filter(item => item.visible)).flat();
        items.forEach((item, index) => {
            const page = Math.floor(index / this._grid.itemsPerPage);
            const position = index % this._grid.itemsPerPage;
            const [oldPage, oldPosition] = this._grid.getItemPosition(item);
            if (oldPage !== page || oldPosition !== position)
                this._moveItem(item, page, position);
        });
    }

    _savePages() {
        this._savingPages = true;
        try {
            this._compactPages();
            super._savePages();
            // Until Overview's deferred refresh, its actors still have the old
            // positions. Use the shared saved layout for our own completed edit.
            this._nativeLayoutPending = true;
        } finally {
            this._savingPages = false;
        }
        // The shared PageManager suppresses its own layout-changed notification
        // while saving. Refresh the other display without a second settings model.
        Main.queueDeferredWork(this._native._redisplayWorkId);
    }

    addFolderDialog(dialog) {
        super.addFolderDialog(dialog);
        dialog.get_parent().remove_child(dialog);
        Main.uiGroup.add_child(dialog);
        // The native dialog keeps its own modal grab and monitor-sized placement.
        this._closeOnActivation(dialog._view);
        const view = dialog._view;
        view.connect('notify::mapped', () => {
            // A folder can unmap before drag-end reaches its native handlers.
            if (!view.mapped) {
                view._resetDragPageSwitch();
                view._removeDelayedMove();
            }
        });
        view.connect('destroy', () => view._resetDragPageSwitch());
    }

    acceptDrop(source) {
        if (!this._placeholder || source === this._placeholder || source.id !== this._placeholder.id)
            return super.acceptDrop(source);

        // GNOME 50 uses the real source for page-hint drops, although folder
        // sources only exist in the parent grid as placeholders. Give its native
        // drop handler the grid item, then remove the original folder member.
        const sourceView = source.get_parent()?._delegate;
        const accepted = super.acceptDrop(this._placeholder);
        if (accepted)
            sourceView?.removeApp?.(source.app);
        return accepted;
    }

    close() {
        this._currentDialog?.popdown();
        // Close/unmap can happen during a drag, including when disabling.
        const views = [this, ...this._folderIcons.map(icon => icon.view)];
        for (const view of views) {
            view._resetDragPageSwitch();
            view._removeDelayedMove();
            for (const item of view.getAllItems()) {
                const draggable = item._draggable;
                if (draggable?._grab) {
                    if (!draggable._animationInProgress)
                        draggable._cancelDrag(global.get_current_time());
                    // Finish snap-back before unmapping or destroying the source.
                    // A later button release must not drop an already ended drag.
                    draggable._dragActor?.remove_all_transitions();
                }
                item._menu?.close();
            }
        }
    }

    _onDestroy() {
        this.close();
        super._onDestroy();
    }
});
