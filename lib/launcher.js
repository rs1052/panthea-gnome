// SPDX-License-Identifier: GPL-3.0-or-later

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {PageIndicators} from 'resource:///org/gnome/shell/ui/pageIndicators.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {CATEGORIES} from '../shared/options.js';
import {pageSlice} from '../shared/model.js';
import {categoryItems} from '../shared/appLayout.js';
import {AppLayout} from './appLayout.js';
import {Catalog} from './catalog.js';
import {Connections} from './signals.js';

const LauncherPageIndicators = GObject.registerClass(
class LauncherPageIndicators extends PageIndicators {
    setNPages(nPages) {
        const oldCount = this.get_n_children();
        super.setNPages(nPages);
        this.get_children().slice(oldCount).forEach((indicator, offset) => {
            const index = oldCount + offset;
            for (const signal of ['key-focus-in', 'key-focus-out'])
                indicator.connect(signal, () => this._updateIndicator(indicator, index));
        });
    }

    _updateIndicator(indicator, index) {
        super._updateIndicator(indicator, index);
        if (indicator.has_key_focus())
            indicator.child.opacity = 255;
    }
});

function addTooltip(actor, text) {
    const label = new St.Label({
        text, style_class: 'dash-label', visible: false,
        x_align: Clutter.ActorAlign.CENTER,
    });
    Main.layoutManager.addTopChrome(label);
    let timeoutId = 0;
    const hide = () => {
        if (timeoutId)
            GLib.Source.remove(timeoutId);
        timeoutId = 0;
        label.hide();
    };
    const show = () => {
        if (!actor.mapped)
            return;
        label.show();
        const [, labelWidth] = label.get_preferred_width(-1);
        const [x, y] = actor.get_transformed_position();
        const labelX = Math.clamp(Math.round(x + (actor.width - labelWidth) / 2),
            0, Math.max(0, global.stage.width - labelWidth));
        label.set_position(labelX, Math.round(y + actor.height + 6));
        Main.uiGroup.set_child_above_sibling(label, null);
    };
    actor.connect('notify::hover', () => {
        if (!actor.hover) {
            hide();
            return;
        }
        if (timeoutId)
            return;
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            timeoutId = 0;
            if (actor.hover)
                show();
            return GLib.SOURCE_REMOVE;
        });
    });
    actor.connect('notify::accessible-name', () => {
        label.text = actor.accessible_name;
        if (label.visible)
            show();
    });
    actor.connect('notify::mapped', () => {
        if (!actor.mapped)
            hide();
    });
    actor.connect('destroy', () => {
        hide();
        Main.layoutManager.removeChrome(label);
        label.destroy();
    });
    return {show, hide, label};
}

const AppButton = GObject.registerClass(
class AppButton extends St.Button {
    _init(launcher) {
        super._init({
            style_class: 'button flat panthea-app',
            can_focus: true, x_expand: true,
            accessible_role: Atk.Role.PUSH_BUTTON,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
        });
        this._launcher = launcher;
        this._delegate = this;
        this._draggable = DND.makeDraggable(this, {timeoutThreshold: 200});
        this._draggable.connect('drag-begin', () => launcher._beginDrag(this));
        this._draggable.connect('drag-end', () => launcher._endDrag());
        this._draggable.connect('drag-cancelled', () => {
            if (launcher._drag)
                launcher._drag.cancelling = true;
        });
        this.connect('key-focus-in', () => {
            if (launcher._settings.get_string('applications-view') === 'list')
                ensureActorVisibleInScrollView(launcher._resultsScroll, this);
        });
        this._content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this._icon = new St.Icon({
            icon_size: 48, x_align: Clutter.ActorAlign.CENTER,
            fallback_icon_name: 'application-x-executable',
        });
        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._content.add_child(this._icon);
        this._content.add_child(this._label);
        this.child = this._content;
        this.label_actor = this._label;
        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this.connect('clicked', (_button, mouseButton) => {
            if (mouseButton === Clutter.BUTTON_SECONDARY)
                this.popupMenu();
            else
                this.activate(mouseButton);
        });
        this.connect('key-press-event', (_button, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Menu ||
                (event.get_key_symbol() === Clutter.KEY_F10 &&
                 event.get_state() & Clutter.ModifierType.SHIFT_MASK)) {
                this.popupMenu();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('destroy', () => this._menu?.destroy());
    }

    setEntry(entry, list, width, height, scale) {
        this._menu?.close();
        if (this.entry !== entry) {
            this.entry = entry;
            this.app = entry.kind === 'folder' ? null : this._launcher.catalog.app(entry);
            const gicon = entry.info?.get_icon();
            if (gicon)
                this._icon.gicon = gicon;
            else
                this._icon.icon_name = entry.kind === 'folder' ? 'folder-symbolic' : 'application-x-executable';
            this._label.text = entry.name;
            this.accessible_name = entry.name;
        }
        this._content.orientation = list ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL;
        this._icon.icon_size = list ? 28 : 48;
        this._content.x_align = list ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER;
        this._label.x_align = list ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER;
        this._label.set_style(`text-align: ${list ? 'left' : 'center'};`);
        this.set_size(width, height);
        this._label.width = Math.max(1, width - (list ? 66 : 16) * scale);
        this._draggable.startGesture.enabled = this._launcher._canDrag(entry);
    }

    getDragActor() {
        const icon = this.app?.create_icon_texture(48) ?? new St.Icon({icon_name: 'folder-symbolic', icon_size: 48});
        this._dragIcon = icon;
        icon.connect('destroy', () => { this._dragIcon = null; });
        return icon;
    }

    getDragActorSource() {
        return this._icon;
    }

    handleDragOver(source, _actor, x) {
        return this._launcher._dragOver(source, this, x);
    }

    acceptDrop(source, _actor, x) {
        return this._launcher._drop(source, this, x);
    }

    activate(button = Clutter.BUTTON_PRIMARY) {
        if (this.entry?.kind === 'folder') {
            this._launcher._openFolder(this.entry.id);
            return;
        }
        if (!this.app)
            return;
        const modifiers = Clutter.get_current_event()?.get_state() ?? 0;
        const newWindow = button === Clutter.BUTTON_MIDDLE ||
            !!(modifiers & Clutter.ModifierType.CONTROL_MASK);
        this._launcher.menu.close();
        try {
            if (newWindow && this.app.state === Shell.AppState.RUNNING && this.app.can_open_new_window())
                this.app.open_new_window(-1);
            else
                this.app.activate();
            Main.overview.hide();
        } catch (error) {
            Main.notifyError(`Could not open ${this.entry.name}`, error.message);
        }
    }

    popupMenu() {
        if (this.entry?.kind === 'folder') {
            this._launcher._openFolder(this.entry.id);
            return;
        }
        if (!this.app)
            return;
        if (!this._menu) {
            this._menu = new AppMenu(this, St.Side.TOP, {favoritesSection: true, showSingleWindows: true});
            Main.uiGroup.add_child(this._menu.actor);
            this._menuManager.addMenu(this._menu);
            this._removeItem = this._menu.addAction('Remove from Folder', () => {
                const {layout, catalog, _folderId} = this._launcher;
                this._launcher._edit(() => layout.remove(_folderId, this.entry.id, catalog.entries));
            });
        }
        this._menu.setApp(this.app);
        this._removeItem.visible = !!this._launcher._folderId;
        this._removeItem.setSensitive(this._launcher.layout.canManage(this._launcher._folderId));
        this._menu.open();
        this._menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }
});

export const Launcher = GObject.registerClass(
class Launcher extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'Applications');
        this.add_style_class_name('panthea-panel-control');
        this.menu.setSourceAlignment(0.0);
        this._settings = settings;
        this._signals = new Connections();
        this._renderId = 0;
        this._focusId = 0;
        this._dirty = true;
        this._page = 0;
        this._category = 'all';
        this._pool = [];
        this._visibleButtons = [];
        this._matches = [];
        this._folderId = null;
        this._folderPage = 0;
        this._drag = null;
        this._dragPageId = 0;
        this.add_child(new St.Label({text: 'Applications', y_align: Clutter.ActorAlign.CENTER}));

        this._root = new St.BoxLayout({
            style_class: 'panthea-launcher', orientation: Clutter.Orientation.VERTICAL,
        });
        this.menu.box.add_child(this._root);
        this._search = new St.Entry({
            style_class: 'search-entry', hint_text: 'Search applications',
            can_focus: true, x_expand: true, accessible_name: 'Search applications',
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic', style_class: 'search-entry-icon'}),
        });
        const header = new St.BoxLayout({style_class: 'panthea-header'});
        this._search.y_align = Clutter.ActorAlign.CENTER;
        header.add_child(this._search);
        const toolbar = new St.BoxLayout({
            style_class: 'panthea-toolbar', y_align: Clutter.ActorAlign.CENTER,
        });
        this._viewButtons = new Map();
        for (const [view, name, icon] of [
            ['grid', 'Grid View', 'view-grid-symbolic'],
            ['list', 'Category View', 'view-list-symbolic'],
        ]) {
            const button = this._iconButton(icon, name, () => settings.set_string('applications-view', view));
            button.toggle_mode = true;
            button._tooltip = addTooltip(button, name);
            toolbar.add_child(button);
            this._viewButtons.set(view, button);
        }
        header.add_child(toolbar);
        this._root.add_child(header);

        // Reuse the paginated results area for folders rather than embedding
        // Overview's folder dialog and its grabs/transitions.
        this._folderBar = new St.BoxLayout({style_class: 'panthea-header', visible: false});
        this._folderBack = this._iconButton('go-previous-symbolic', 'Back to applications', () => this._closeFolder());
        this._folderBar.add_child(this._folderBack);
        this._folderName = new St.Entry({can_focus: true, x_expand: true, accessible_name: 'Folder name'});
        this._folderName.clutter_text.editable = false;
        this._folderName.clutter_text.connect('key-focus-in', () => {
            const folder = this.layout.folders.get(this._folderId);
            this._folderName.clutter_text.editable = !!folder &&
                folder.is_writable('name') && folder.is_writable('translate');
        });
        this._folderName.clutter_text.connect('key-focus-out', () => {
            this._folderName.clutter_text.editable = false;
            this._queueRender();
        });
        this._folderBar.add_child(this._folderName);
        this._folderRename = new St.Button({label: 'Rename', can_focus: true, style_class: 'button'});
        this._folderRename.connect('clicked', () =>
            this._edit(() => this.layout.rename(this._folderId, this._folderName.get_text())));
        this._folderBar.add_child(this._folderRename);
        this._folderDissolve = new St.Button({label: 'Dissolve Folder', can_focus: true, style_class: 'button'});
        this._folderDissolve.connect('clicked', () => {
            if (this._edit(() => this.layout.dissolve(this._folderId, this.catalog.entries)))
                this._closeFolder();
        });
        this._folderBar.add_child(this._folderDissolve);

        this._body = new St.BoxLayout({style_class: 'panthea-body'});
        this._sidebar = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'panthea-categories'});
        this._sidebarScroll = new St.ScrollView({
            child: this._sidebar, hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._body.add_child(this._sidebarScroll);
        this._categoryButtons = new Map();
        for (const [id, name] of categoryItems(CATEGORIES)) {
            const button = new St.Button({
                label: name, style_class: 'button flat panthea-category', can_focus: true, x_expand: true,
                toggle_mode: true, accessible_name: name,
            });
            button.child.x_align = Clutter.ActorAlign.START;
            button.child.x_expand = true;
            button.connect('clicked', () => {
                this._category = id;
                this._page = 0;
                this._resetScroll = true;
                this._render();
            });
            this._categoryButtons.set(id, button);
            this._sidebar.add_child(button);
        }
        this._resultStack = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, x_expand: true,
        });
        this._gridLayout = new Clutter.GridLayout({column_homogeneous: true});
        this._results = new St.Widget({
            layout_manager: this._gridLayout,
            x_align: Clutter.ActorAlign.START,
        });
        this._empty = new St.Label({
            text: 'Loading applications…', style_class: 'panthea-empty',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true,
        });
        this._resultStack.add_child(this._results);
        this._resultStack.add_child(this._empty);
        this._resultsScroll = new St.ScrollView({
            child: this._resultStack, x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER,
        });
        const rtl = this.text_direction === Clutter.TextDirection.RTL;
        this._previousPageArrow = this._pageArrow(
            rtl ? 'carousel-arrow-next-symbolic' : 'carousel-arrow-previous-symbolic',
            'Previous page', -1);
        this._nextPageArrow = this._pageArrow(
            rtl ? 'carousel-arrow-previous-symbolic' : 'carousel-arrow-next-symbolic',
            'Next page', 1);
        this._previousPageGutter = new St.Bin({
            style_class: 'panthea-page-margin', child: this._previousPageArrow,
        });
        this._nextPageGutter = new St.Bin({
            style_class: 'panthea-page-margin', child: this._nextPageArrow,
        });
        const pageArea = new St.BoxLayout({x_expand: true});
        pageArea.add_child(this._previousPageGutter);
        pageArea.add_child(this._resultsScroll);
        pageArea.add_child(this._nextPageGutter);
        this._body.add_child(pageArea);
        this._root.add_child(this._body);

        this._pageIndicators = new LauncherPageIndicators(Clutter.Orientation.HORIZONTAL);
        this._pageIndicators.add_style_class_name('panthea-page-indicators');
        this._pageIndicators.y_expand = false;
        this._pageIndicators.connect('page-activated', (_indicators, page) => {
            this._changePage(page - this._page);
        });
        this._root.add_child(this._pageIndicators);
        // Keep the launcher's existing three top-level rows.
        this._resultStack.insert_child_at_index(this._folderBar, 0);

        this._signals.connect(this._search.clutter_text, 'text-changed', () => {
            this._page = 0;
            this._resetScroll = true;
            this._queueRender();
        });
        this._signals.connect(settings, 'changed::applications-view', () => {
            this._folderId = null;
            this._category = 'all';
            this._page = 0;
            this._resetScroll = true;
            this._queueRender();
        });
        this._signals.connect(Main.layoutManager, 'monitors-changed', () => this._queueRender());
        this._signals.connect(St.ThemeContext.get_for_stage(global.stage), 'changed', () => this._queueRender());
        this._signals.connect(this.menu, 'open-state-changed', (_menu, open) => {
            if (this._focusId)
                GLib.Source.remove(this._focusId);
            this._focusId = 0;
            if (open) {
                this._flushRender();
                // The panel's menu manager takes its grab after this signal.
                // Focus search once that synchronous grab setup has finished.
                this._focusId = GLib.idle_add_once(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._focusId = 0;
                    this._search.grab_key_focus();
                });
            } else {
                this._cancelDrag();
                this._folderId = null;
                this._dirty = true;
                for (const button of [...this._viewButtons.values(),
                    this._previousPageArrow, this._nextPageArrow,
                    ...this._pageIndicators.get_children()])
                    button._tooltip?.hide();
                for (const button of this._pool)
                    button._menu?.close();
                this._search.set_text('');
                if (this._page !== 0) {
                    this._page = 0;
                    this._queueRender();
                }
            }
        });
        this._signals.connect(this.menu.actor, 'captured-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.KEY_PRESS)
                return this._handleKeyPress(event);
            return Clutter.EVENT_PROPAGATE;
        });
        this.layout = new AppLayout(global.settings, () => this._queueRender(),
            name => Shell.util_get_translated_folder_name(name),
            (id, edit) => {
                // Use the same guard as GNOME's FolderView.removeApp(). Reset
                // keys while its dialog is alive, without reentrant redisplay.
                const view = Main.overview._overview.controls.appDisplay._items.get(id)?.view;
                const deleting = view?._deletingFolder;
                if (view)
                    view._deletingFolder = true;
                try {
                    return edit();
                } finally {
                    if (view)
                        view._deletingFolder = deleting;
                }
            });
        this.catalog = new Catalog(() => this._queueRender());
        this._queueRender();
    }

    _onDestroy() {
        this._destroying = true;
        this._cancelDrag();
        this._drag?.button._dragIcon?.destroy();
        this._endDrag();
        if (this._focusId)
            GLib.Source.remove(this._focusId);
        this._focusId = 0;
        if (this._renderId)
            GLib.Source.remove(this._renderId);
        this._renderId = 0;
        this._signals.clear();
        this.catalog.destroy();
        this.layout.destroy();
        for (const button of this._pool) {
            button.get_parent()?.remove_child(button);
            button.destroy();
        }
        this._pool = [];
        super._onDestroy();
    }

    _iconButton(iconName, name, callback) {
        const button = new St.Button({
            style_class: 'icon-button flat', can_focus: true, accessible_name: name,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        button.connect('clicked', callback);
        return button;
    }

    _pageArrow(iconName, name, delta) {
        const button = new St.Button({
            style_class: 'panthea-page-arrow',
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
            accessible_name: name, can_focus: true, track_hover: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', () => this._changePage(delta));
        button._tooltip = addTooltip(button, name);
        return button;
    }

    _queueRender() {
        if (this._destroying)
            return;
        this._dirty = true;
        if (this._renderId)
            return;
        this._renderId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._renderId = 0;
            this._render();
            return GLib.SOURCE_REMOVE;
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
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this.catalog)
            return;
        if (this._drag && !this._validDrag())
            this._cancelDrag();
        // Do not recycle a drag's actors on external changes. The revision
        // check rejects stale drops, and drag-end renders the latest state.
        if (this._drag && !this._dragPaging)
            return;
        this._dirty = false;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const list = this._settings.get_string('applications-view') === 'list';
        const arrowFocused = global.stage.key_focus === this._previousPageArrow ||
            global.stage.key_focus === this._nextPageArrow;
        const query = this._search.get_text().trim();
        if (query || list)
            this._folderId = null;
        if (this._folderId && (!this.layout.folder(this._folderId) ||
            !this.layout.contents(this._folderId, this.catalog.entries).length))
            this._folderId = null;
        const sidebar = list && !query;
        const width = Math.max(1, Math.min(680 * scale, monitor.width - 48 * scale));
        const contentWidth = Math.max(1, width - this._root.get_theme_node().get_horizontal_padding());
        const sidebarWidth = Math.min(172 * scale, Math.floor(contentWidth * 0.35));
        // Reserve both gutters even at page boundaries so icons never move
        // sideways when an arrow disappears or search returns a sparse page.
        for (const arrow of [this._previousPageArrow, this._nextPageArrow]) {
            arrow.ensure_style();
            arrow.child.ensure_style();
        }
        const gutterWidth = list ? 0 : Math.max(
            this._previousPageGutter.get_preferred_width(-1)[1],
            this._nextPageGutter.get_preferred_width(-1)[1]);
        this._previousPageGutter.visible = !list;
        this._nextPageGutter.visible = !list;
        const resultWidth = Math.max(1,
            contentWidth - (sidebar ? sidebarWidth + 12 * scale : 0) - 2 * gutterWidth);
        const fontDescription = this._root.get_theme_node().get_font();
        let font = fontDescription.get_size() / Pango.SCALE;
        if (!fontDescription.get_size_is_absolute())
            font *= St.ThemeContext.get_for_stage(global.stage).get_resolution() / 72;
        const cellHeight = Math.max((list ? 44 : 102) * scale, font * (list ? 3 : 7.5));
        this._columns = list ? 1 : Math.max(1, Math.min(6, Math.floor(resultWidth / (100 * scale))));
        const rows = Math.max(1, Math.min(list ? 8 : 3,
            Math.floor((workArea.height - (this._folderId ? 230 : 180) * scale) / cellHeight)));
        this._pageSize = rows * this._columns;
        this._root.width = width;
        this._body.height = rows * cellHeight;
        this._sidebarScroll.visible = sidebar;
        this._sidebarScroll.width = sidebarWidth;

        let entries = query || list ? this.catalog.search(query)
            : this._folderId ? this.layout.contents(this._folderId, this.catalog.entries)
                : this.layout.items(this.catalog.entries);
        const folder = this.layout.folder(this._folderId);
        if (folder) {
            const name = folder.translate
                ? Shell.util_get_translated_folder_name(folder.name) ?? folder.name : folder.name;
            if ((this._folderNameId !== folder.id || this._folderSavedName !== name) &&
                (!global.stage.key_focus || !this._folderName.contains(global.stage.key_focus)))
                this._folderName.set_text(name);
            if (!global.stage.key_focus || !this._folderName.contains(global.stage.key_focus)) {
                this._folderNameId = folder.id;
                this._folderSavedName = name;
            }
            const folderSettings = this.layout.folders.get(folder.id);
            const rename = folderSettings.is_writable('name') && folderSettings.is_writable('translate');
            this._folderRename.reactive = this._folderRename.can_focus = rename;
            this._folderName.reactive = this._folderName.can_focus = rename;
            this._folderDissolve.reactive = this._folderDissolve.can_focus = this.layout.canManage(folder.id);
        }
        this._folderBar.visible = !!folder;
        const favorites = new Set(this.catalog.favorites.getFavorites().map(app => app.get_id()));
        if (!query && list && this._category !== 'all') {
            entries = entries.filter(entry => this._category === 'favorites'
                ? favorites.has(entry.id) : entry.category === this._category);
        }
        this._matches = entries;
        const page = list ? {entries, page: 0, pages: 1}
            : pageSlice(entries, this._page, this._pageSize);
        this._page = page.page;
        const usedRows = Math.max(1, Math.ceil(page.entries.length / this._columns));
        this._resultsScroll.vscrollbar_policy = list ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER;
        const folderBarHeight = folder ? this._folderBar.get_preferred_height(resultWidth)[1] : 0;
        this._resultsScroll.height = rows * cellHeight + folderBarHeight;
        this._body.height = rows * cellHeight + folderBarHeight;
        this._resultsScroll.width = resultWidth;
        // Reserve the native scrollbar width, without shrinking grid tiles.
        const scrollbar = this._resultsScroll.get_children().find(actor =>
            actor instanceof St.ScrollBar && actor.orientation === Clutter.Orientation.VERTICAL);
        const scrollbarWidth = list ? scrollbar.get_preferred_width(-1)[1] : 0;
        const cellWidth = Math.max(1, Math.floor((resultWidth - scrollbarWidth) / this._columns));
        this._resultStack.height = list && entries.length ? -1 : rows * cellHeight + folderBarHeight;
        this._results.width = Math.min(this._columns, page.entries.length) * cellWidth;
        this._results.height = page.entries.length ? usedRows * cellHeight : 0;
        for (const [view, button] of this._viewButtons)
            button.checked = view === (list ? 'list' : 'grid');
        const activeCategories = new Set(this.catalog.entries.map(entry => entry.category));
        for (const [id, button] of this._categoryButtons) {
            button.visible = id === 'all' || id === 'favorites' || activeCategories.has(id);
            button.checked = id === this._category;
            // Mute only the label, preserving native selection and focus backgrounds.
            button.child.opacity = button.checked ? 255 : 204;
        }

        const focused = this._visibleButtons.indexOf(global.stage.key_focus);
        for (const button of this._visibleButtons) {
            button._menu?.close();
            this._results.remove_child(button);
        }
        this._visibleButtons = [];
        while (this._pool.length < page.entries.length + Number(!!this._drag))
            this._pool.push(new AppButton(this));
        const available = this._pool.filter(button => button !== this._drag?.button);
        for (let index = 0; index < page.entries.length; index++) {
            const button = available[index];
            button.setEntry(page.entries[index], list, cellWidth, cellHeight, scale);
            this._gridLayout.attach(button, index % this._columns, Math.floor(index / this._columns), 1, 1);
            this._visibleButtons.push(button);
        }
        if (focused >= 0 && this._visibleButtons.length && this.menu.isOpen)
            this._visibleButtons[Math.min(focused, this._visibleButtons.length - 1)].grab_key_focus();

        this._empty.visible = entries.length === 0;
        this._empty.text = !this.catalog.ready ? 'Loading applications…'
            : query ? 'No applications found' : this._category === 'favorites'
                ? 'No favorite applications' : folder ? 'No applications in this folder' : 'No applications in this category';
        this._pageIndicators.setNPages(page.pages);
        this._pageIndicators.setCurrentPosition(page.page);
        this._previousPageArrow.visible = !list && page.page > 0;
        this._nextPageArrow.visible = !list && page.page < page.pages - 1;
        if (arrowFocused && (!global.stage.key_focus || !global.stage.key_focus.mapped)) {
            const arrow = this._nextPageArrow.visible ? this._nextPageArrow
                : this._previousPageArrow.visible ? this._previousPageArrow : this._search;
            arrow.grab_key_focus();
        }
        for (const [index, indicator] of this._pageIndicators.get_children().entries()) {
            indicator.can_focus = true;
            indicator.accessible_name = `Page ${index + 1} of ${page.pages}`;
            indicator._tooltip ??= addTooltip(indicator, indicator.accessible_name);
            indicator.accessible_role = Atk.Role.RADIO_BUTTON;
            if (index === page.page)
                indicator.add_accessible_state(Atk.StateType.CHECKED);
            else
                indicator.remove_accessible_state(Atk.StateType.CHECKED);
        }
        if (this._resetScroll) {
            this._resultsScroll.vadjustment.value = 0;
            this._resetScroll = false;
        }
    }

    _changePage(delta) {
        if (this._settings.get_string('applications-view') === 'list')
            return;
        this._page += delta;
        this._dirty = true;
        this._dragPaging = true;
        this._flushRender();
        this._dragPaging = false;
    }

    _openFolder(id) {
        this._folderPage = this._page;
        this._folderNameId = null;
        this._folderId = id;
        this._page = 0;
        this._render();
        if (this._focusId)
            GLib.Source.remove(this._focusId);
        this._focusId = GLib.idle_add_once(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._focusId = 0;
            if (this.menu.isOpen && this._folderId === id)
                this._folderBack.grab_key_focus();
        });
    }

    _closeFolder() {
        this._folderId = null;
        this._page = this._folderPage;
        this._render();
        this._search.grab_key_focus();
    }

    _edit(callback) {
        try {
            callback();
            this._queueRender();
            return true;
        } catch (error) {
            Main.notifyError('Could not change applications', error.message);
            this._queueRender();
            return false;
        }
    }

    _canDrag(entry) {
        return this._settings.get_string('applications-view') === 'grid' &&
            !this._search.get_text().trim() && this.layout.canEdit(this._folderId) &&
            (entry.kind !== 'folder' || !this._folderId);
    }

    _beginDrag(button) {
        this._drag = {button, id: button.entry.id, kind: button.entry.kind,
            folderId: this._folderId, revision: this.layout.revision, entries: this.catalog.entries,
            ids: this._matches.map(entry => entry.id).join('\0')};
        // Do not emit Overview item-drag signals. Its handlers save their own
        // grid and would overwrite this launcher's edits.
        this._dragMonitor = {dragMotion: event => {
            const arrow = [this._previousPageArrow, this._nextPageArrow]
                .find(actor => actor.visible && actor.contains(event.targetActor));
            if (arrow !== this._dragArrow) {
                this._clearDragPage();
                this._dragArrow = arrow;
                if (arrow) {
                    this._dragPageId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
                        if (!this._validDrag() || !arrow.visible) {
                            this._clearDragPage();
                            return GLib.SOURCE_REMOVE;
                        }
                        this._changePage(arrow === this._nextPageArrow ? 1 : -1);
                        return GLib.SOURCE_CONTINUE;
                    });
                }
            }
            return DND.DragMotionResult.CONTINUE;
        }};
        DND.addDragMonitor(this._dragMonitor);
    }

    _clearDragPage() {
        if (this._dragPageId)
            GLib.Source.remove(this._dragPageId);
        this._dragPageId = 0;
        this._dragArrow = null;
    }

    _cancelDrag() {
        if (!this._drag || this._drag.cancelling)
            return;
        this._drag.cancelling = true;
        // GNOME 50 exposes no public cancel method. Use its normal snap-back
        // path so the modal grab is released even after a reused successful drag.
        this._drag.button._draggable._cancelDrag(global.get_current_time());
    }

    _endDrag() {
        this._clearDragPage();
        if (this._dragMonitor)
            DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
        this._drag = null;
        for (const button of this._pool)
            button.remove_style_pseudo_class('drop');
        this._queueRender();
    }

    _validDrag(source = this._drag?.button) {
        if (this._drag && this._drag.entries !== this.catalog.entries) {
            const entries = this._folderId ? this.layout.contents(this._folderId, this.catalog.entries)
                : this.layout.items(this.catalog.entries);
            if (entries.map(entry => entry.id).join('\0') !== this._drag.ids)
                return false;
            // A metadata refresh with the same projected order is harmless.
            this._drag.entries = this.catalog.entries;
        }
        return !!this._drag && source === this._drag.button &&
            !this._drag.cancelling &&
            this._drag.revision === this.layout.revision &&
            this._drag.entries === this.catalog.entries &&
            this._drag.folderId === this._folderId && this.menu.isOpen &&
            this._settings.get_string('applications-view') === 'grid' && !this._search.get_text().trim();
    }

    _dropMode(source, target, x) {
        if (!this._validDrag(source) || this._drag.id === target.entry.id)
            return null;
        const center = x > target.width * 0.25 && x < target.width * 0.75;
        if (center && !this._folderId && this._drag.kind !== 'folder')
            return target.entry.kind === 'folder'
                ? this.layout.canEdit(target.entry.id) ? 'add' : null
                : this.layout.canManage() ? 'create' : null;
        return this.layout.canEdit(this._folderId) ? 'move' : null;
    }

    _dragOver(source, target, x) {
        const mode = this._dropMode(source, target, x);
        for (const button of this._visibleButtons)
            button.remove_style_pseudo_class('drop');
        if (mode)
            target.add_style_pseudo_class('drop');
        return mode ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.NO_DROP;
    }

    _drop(source, target, x) {
        const mode = this._dropMode(source, target, x);
        if (!mode)
            return false;
        const {id} = this._drag;
        const targetId = target.entry.id;
        return this._edit(() => {
            if (mode === 'create')
                this.layout.create(targetId, id, this.catalog.entries);
            else if (mode === 'add')
                this.layout.add(targetId, id, this.catalog.entries);
            else
                this.layout.reorder(id, targetId,
                    this.text_direction === Clutter.TextDirection.RTL ? x < target.width / 2 : x > target.width / 2,
                    this._folderId, this.catalog.entries);
        });
    }

    _handleKeyPress(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape && this._search.get_text()) {
            this._search.set_text('');
            this._search.grab_key_focus();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Escape && this._folderId && !this._drag) {
            this._closeFolder();
            return Clutter.EVENT_STOP;
        }
        if (event.get_state() & Clutter.ModifierType.CONTROL_MASK) {
            if (key === Clutter.KEY_1 || key === Clutter.KEY_2) {
                this._settings.set_string('applications-view', key === Clutter.KEY_1 ? 'grid' : 'list');
                return Clutter.EVENT_STOP;
            }
        }
        if (key === Clutter.KEY_Page_Down || key === Clutter.KEY_Page_Up) {
            if (this._settings.get_string('applications-view') === 'list') {
                const direction = key === Clutter.KEY_Page_Down ? 1 : -1;
                const index = this._visibleButtons.indexOf(global.stage.key_focus);
                if (index >= 0) {
                    const next = Math.clamp(index + direction * this._pageSize,
                        0, this._visibleButtons.length - 1);
                    this._visibleButtons[next]?.grab_key_focus();
                } else {
                    const adjustment = this._resultsScroll.vadjustment;
                    adjustment.value = Math.clamp(adjustment.value + direction * adjustment.page_size,
                        adjustment.lower, Math.max(adjustment.lower, adjustment.upper - adjustment.page_size));
                }
                return Clutter.EVENT_STOP;
            }
            this._changePage(key === Clutter.KEY_Page_Down ? 1 : -1);
            return Clutter.EVENT_STOP;
        }
        const index = this._visibleButtons.indexOf(global.stage.key_focus);
        const searchFocused = global.stage.key_focus && this._search.contains(global.stage.key_focus);
        if (searchFocused && (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter)) {
            this._flushRender();
            this._visibleButtons[0]?.activate();
            return Clutter.EVENT_STOP;
        }
        if (searchFocused && key === Clutter.KEY_Down) {
            this._visibleButtons[0]?.grab_key_focus();
            return Clutter.EVENT_STOP;
        }
        if (index >= 0) {
            let next = index;
            if (key === Clutter.KEY_Down)
                next += this._columns;
            else if (key === Clutter.KEY_Up)
                next -= this._columns;
            else if (key === Clutter.KEY_Left)
                next += this.text_direction === Clutter.TextDirection.RTL ? 1 : -1;
            else if (key === Clutter.KEY_Right)
                next += this.text_direction === Clutter.TextDirection.RTL ? -1 : 1;
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
