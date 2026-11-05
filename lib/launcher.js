// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {PopupAppDisplay} from './appDisplay.js';
import {PopupAppSearch} from './appSearch.js';
import {Catalog} from './catalog.js';
import {Connections} from './signals.js';

export const Launcher = GObject.registerClass(
class Launcher extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Applications');
        this.add_style_class_name('panthea-panel-control');
        this.menu.setSourceAlignment(0.0);
        this._signals = new Connections();
        this._renderId = 0;
        this._focusId = 0;
        this._dirty = true;
        this._matches = [];
        this.add_child(new St.Label({text: 'Applications', y_align: Clutter.ActorAlign.CENTER}));

        this._root = new St.BoxLayout({
            style_class: 'panthea-launcher', orientation: Clutter.Orientation.VERTICAL,
        });
        this.menu.box.add_child(this._root);
        this._search = new St.Entry({
            style_class: 'search-entry', hint_text: 'Search applications',
            can_focus: true, x_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Search applications',
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic', style_class: 'search-entry-icon'}),
        });
        this._root.add_child(this._search);
        // Share a fixed browsing-sized area so search never resizes the popup.
        this._content = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this._root.add_child(this._content);
        this._nativeDisplay = new PopupAppDisplay(this);
        this._nativeDisplay.add_style_class_name('panthea-app-display');
        this._content.add_child(this._nativeDisplay);
        // Native indicators are not keyboard-focusable in Overview. Make the
        // popup's own controls reachable without changing Overview's instances.
        for (const arrow of [this._nativeDisplay._prevPageArrow, this._nativeDisplay._nextPageArrow])
            arrow.can_focus = true;
        this._nativeDisplay._grid.connect('pages-changed', () => this._decorateNativeIndicators());
        this._results = new PopupAppSearch(this);
        this._results.add_style_class_name('panthea-app-search');
        this._results.y_align = Clutter.ActorAlign.START;
        this._results.y_expand = true;
        this._results.x_expand = true;
        this._content.add_child(this._results);
        this._empty = new St.Label({
            text: 'Loading applications…', style_class: 'panthea-empty',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._content.add_child(this._empty);
        this._clearIcon = new St.Icon({
            icon_name: 'edit-clear-symbolic', style_class: 'search-entry-icon',
        });
        this._signals.connect(this._search, 'secondary-icon-clicked', () => {
            this._search.set_text('');
            this._search.grab_key_focus();
        });
        this._signals.connect(global.stage, 'notify::key-focus', () => this._results.highlightDefault());
        this._signals.connect(this._search.clutter_text, 'text-changed', () => {
            this._search.set_secondary_icon(this._search.get_text() ? this._clearIcon : null);
            this._queueRender();
        });
        this._signals.connect(Main.layoutManager, 'monitors-changed', () => this._queueRender());
        this._signals.connect(global.display, 'workareas-changed', () => this._queueRender());
        this._signals.connect(St.ThemeContext.get_for_stage(global.stage), 'changed', () => this._queueRender());
        this._signals.connect(this.menu, 'open-state-changed', (_menu, open) => {
            if (this._focusId)
                GLib.Source.remove(this._focusId);
            this._focusId = 0;
            if (open) {
                this._flushRender();
                // The panel's menu manager takes its grab after this signal.
                this._focusId = GLib.idle_add_once(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._focusId = 0;
                    this._search.grab_key_focus();
                });
            } else {
                this._nativeDisplay.close();
                this._nativeDisplay.goToPage(0, false);
                this._dirty = true;
                this._results.close();
                this._search.set_text('');
            }
        });
        // Run before the menu manager's capture controller, which closes on Esc.
        this._escapeController = new Clutter.KeyController();
        this._signals.connect(this._escapeController, 'key-press', controller => {
            const [, key] = controller.get_key();
            if (key !== Clutter.KEY_Escape || !this._search.get_text())
                return Clutter.EVENT_PROPAGATE;
            this._search.set_text('');
            this._search.grab_key_focus();
            return Clutter.EVENT_STOP;
        });
        this.menu.actor.add_action_full('panthea-search-escape', Clutter.EventPhase.CAPTURE,
            this._escapeController);
        this._signals.connect(this.menu.actor, 'captured-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.KEY_PRESS)
                return this._handleKeyPress(event);
            return Clutter.EVENT_PROPAGATE;
        });
        this.catalog = new Catalog(() => this._queueRender());
        this._queueRender();
    }

    _onDestroy() {
        this._destroying = true;
        this._nativeDisplay.close();
        this._results.close();
        if (this._focusId)
            GLib.Source.remove(this._focusId);
        if (this._renderId)
            GLib.Source.remove(this._renderId);
        this._focusId = this._renderId = 0;
        this._signals.clear();
        this.catalog.destroy();
        this._results.clear();
        this._search.set_secondary_icon(null);
        this._clearIcon.destroy();
        super._onDestroy();
    }

    _queueRender() {
        if (this._destroying)
            return;
        this._dirty = true;
        if (this._renderId || !this.menu.isOpen)
            return;
        this._renderId = GLib.idle_add_once(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._renderId = 0;
            this._render();
        });
    }

    _flushRender() {
        if (this._renderId)
            GLib.Source.remove(this._renderId);
        this._renderId = 0;
        if (this._dirty)
            this._render();
    }

    _render() {
        const monitor = Main.layoutManager.findMonitorForActor(this) ?? Main.layoutManager.primaryMonitor;
        if (!monitor || !this.catalog)
            return;
        this._dirty = false;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const query = this._search.get_text().trim().split(/\s+/).join(' ');
        this._nativeGrid = !query;
        const {rowsPerPage: rows} = this._nativeDisplay._grid.layoutManager;
        // Preserve the popup's browsing width independently of grid capacity.
        this._root.width = Math.max(1, Math.min(672 * scale, workArea.width * 0.75));
        this._search.width = Math.min(this._root.width - 24 * scale,
            312 * scale);
        this._search.ensure_style();
        const headerHeight = this._search.get_preferred_height(this._search.width)[1];
        const height = Math.max(1, Math.min((rows * 88 + 44) * scale,
            workArea.height - headerHeight - 64 * scale));
        this._nativeDisplay.height = height;
        this._content.height = height;
        if (!this._nativeGrid)
            this._nativeDisplay.close();
        this._nativeDisplay.visible = this._nativeGrid;
        this._empty.visible = false;
        if (this._nativeGrid) {
            this._results.close();
            if (this._searchKey !== undefined) {
                this._searchKey = undefined;
                this._searchUpdate = this._results.updateSearch([], []);
            }
            this._results.hide();
            this._decorateNativeIndicators();
            return;
        }

        this._matches = this.catalog.search(query);
        const ids = this._matches.map(entry => entry.id);
        // Do not restart native result updates for unchanged queries/layout.
        const searchKey = JSON.stringify([query, ids]);
        if (searchKey !== this._searchKey) {
            this._searchKey = searchKey;
            this._results.close();
            this._searchPending = true;
            this._searchUpdate = this._results.updateSearch(ids, query.split(' '));
            this._searchUpdate = this._searchUpdate.finally(() => { this._searchPending = false; });
            this._searchUpdate.catch(error => console.error(`[Panthea] Search failed: ${error.message}`));
        } else {
            this._results.visible = ids.length > 0;
        }
        this._empty.visible = this._matches.length === 0;
        this._empty.text = this.catalog.ready ? 'No applications found' : 'Loading applications…';
    }

    get _visibleButtons() {
        return this._results._grid.get_children().filter(icon => icon.can_focus);
    }

    _withFirstResult(action) {
        const run = () => {
            if (!this._destroying && this.menu.isOpen && !this._nativeGrid) {
                const first = this._results.getFirstResult();
                if (first)
                    action(first);
            }
        };
        if (this._searchPending)
            this._searchUpdate.then(run).catch(error => console.error(`[Panthea] Search failed: ${error.message}`));
        else
            run();
    }

    _decorateNativeIndicators() {
        for (const [index, indicator] of this._nativeDisplay._pageIndicators.get_children().entries()) {
            indicator.can_focus = true;
            indicator.accessible_name = `Page ${index + 1} of ${this._nativeDisplay._grid.nPages}`;
        }
    }

    _handleKeyPress(event) {
        const key = event.get_key_symbol();
        const searchFocused = global.stage.key_focus && this._search.contains(global.stage.key_focus);
        if (searchFocused && [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_Down].includes(key))
            this._flushRender();
        if (this._nativeGrid) {
            if (key === Clutter.KEY_Page_Down || key === Clutter.KEY_Page_Up) {
                this._nativeDisplay.goToPage(this._nativeDisplay._grid.currentPage +
                    (key === Clutter.KEY_Page_Down ? 1 : -1));
                return Clutter.EVENT_STOP;
            }
            if (searchFocused && key === Clutter.KEY_Down) {
                const grid = this._nativeDisplay._grid;
                if (grid.nPages > 0)
                    grid.getItemsAtPage(grid.currentPage)[0]?.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (searchFocused && (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter)) {
            // Preserve Ctrl+Enter even when awaiting a freshly flushed search:
            // native AppIcon treats Ctrl and middle-click as new-window launch.
            const button = event.get_state() & Clutter.ModifierType.CONTROL_MASK
                ? Clutter.BUTTON_MIDDLE : Clutter.BUTTON_PRIMARY;
            this._withFirstResult(first => first.activate(button));
            return Clutter.EVENT_STOP;
        }
        if (searchFocused && key === Clutter.KEY_Down) {
            this._withFirstResult(first => first.grab_key_focus());
            return Clutter.EVENT_STOP;
        }
        const index = this._visibleButtons.indexOf(global.stage.key_focus);
        if (index >= 0) {
            let next;
            if (key === Clutter.KEY_Up)
                next = -1;
            else if (key === Clutter.KEY_Home)
                next = 0;
            else if (key === Clutter.KEY_End)
                next = this._visibleButtons.length - 1;
            else
                return Clutter.EVENT_PROPAGATE;
            if (next < 0)
                this._search.grab_key_focus();
            else
                this._visibleButtons[Math.min(next, this._visibleButtons.length - 1)]?.grab_key_focus();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});
