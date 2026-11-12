// SPDX-License-Identifier: GPL-3.0-or-later
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as IconGrid from 'resource:///org/gnome/shell/ui/iconGrid.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Connections} from './signals.js';

const WorkspaceButton = GObject.registerClass(
class WorkspaceButton extends Dash.DashItemContainer {
    _init(entry, ensureVisible) {
        super._init();
        this.entry = entry;
        this._signals = new Connections();
        this._labelId = 0;
        this.button = new St.Button({
            style_class: 'show-apps panthea-workspace-button',
            track_hover: true,
            can_focus: true,
        });
        this.icon = new IconGrid.BaseIcon('', {
            setSizeManually: true,
            showLabel: false,
            createIcon: size => this._createIcon(size),
        });
        this.icon.y_align = Clutter.ActorAlign.CENTER;
        this.button.child = this.icon;
        this.setChild(this.button);
        this.button.connect('clicked', () => {
            this._hideLabel();
            // A workspace can disappear between the last model update and a click.
            if (this.entry.workspace.index() < 0)
                return;
            if (this.entry.workspace === global.workspace_manager.get_active_workspace())
                Main.overview.toggle();
            else
                this.entry.workspace.activate(global.get_current_time());
        });
        this.button.connect('notify::hover', () => this._syncLabel());
        this.button.connect('key-focus-in', () => {
            ensureVisible(this);
            this._syncLabel();
        });
        this.button.connect('key-focus-out', () => this._syncLabel());
        this.connect('notify::mapped', () => {
            if (!this.mapped)
                this._hideLabel();
        });
        this._signals.connect(Main.overview, 'hiding', () => this._hideLabel());
        this.connect('destroy', () => {
            this._hideLabel();
            this._signals.clear();
        });
        this.update(entry);
        this.show(false);
    }

    update(entry) {
        const previous = this.entry;
        this.entry = entry;
        this.button.checked = entry.active;
        const count = entry.windows.length;
        this.setLabelText(entry.isNew ? 'New Workspace' :
            `Workspace ${entry.workspace.index() + 1}${entry.active ? ' (current)' : ''}`);
        if (this.label.visible)
            this.label.text = this._labelText;
        if (!this.icon.icon || previous.isNew !== entry.isNew ||
            previous.windows.length !== count || entry.windows.some((item, i) =>
                item.window !== previous.windows[i]?.window || item.app !== previous.windows[i]?.app))
            this.icon.update();
    }

    _createIcon(size) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // Fixed cells keep long overflow counts from enlarging the dock tile.
        const grid = new St.Widget({layout_manager: new Clutter.FixedLayout(),
            style_class: 'panthea-workspace-tile',
            width: size * scale, height: size * scale, clip_to_allocation: true});
        if (this.entry.isNew) {
            const glyphSize = Math.max(8, Math.floor(size / 2));
            const plus = new St.Icon({icon_name: 'list-add-symbolic', icon_size: glyphSize});
            plus.set_position((size - glyphSize) * scale / 2, (size - glyphSize) * scale / 2);
            grid.add_child(plus);
            return grid;
        }
        if (!this.entry.windows.length)
            return grid;
        const small = Math.max(4, Math.floor(size / 3));
        const windows = this.entry.windows;
        const count = Math.min(4, windows.length);
        const columns = Math.min(2, count);
        const rows = Math.ceil(count / 2);
        const gap = Math.max(1, Math.round(size / 12));
        const startX = (size - columns * small - (columns - 1) * gap) / 2;
        const startY = (size - rows * small - (rows - 1) * gap) / 2;
        for (let i = 0; i < count; i++) {
            const actor = i === 3 && windows.length > 4
                ? new St.Label({text: `+${windows.length - 3}`, style_class: 'panthea-workspace-overflow',
                    style: `font-size: ${Math.max(4, Math.floor(small * 0.65))}px;`})
                : windows[i].app?.create_icon_texture(small) ??
                    new St.Icon({icon_name: 'application-x-executable', icon_size: small});
            actor.set_position((startX + (i % 2) * (small + gap)) * scale,
                (startY + Math.floor(i / 2) * (small + gap)) * scale);
            actor.set_size(small * scale, small * scale);
            grid.add_child(actor);
        }
        return grid;
    }

    _syncLabel() {
        this._hideLabel();
        if (!this.mapped || (!this.button.hover && !this.button.has_key_focus()))
            return;
        this._labelId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 300, () => {
            this._labelId = 0;
            if (this.mapped)
                this.showLabel();
        });
    }

    _hideLabel() {
        if (this._labelId)
            GLib.Source.remove(this._labelId);
        this._labelId = 0;
        this.label?.hide();
    }
});

export class WorkspaceButtons {
    constructor(dash, model, settings) {
        this._signals = new Connections();
        this._model = model;
        this._settings = settings;
        this._items = new Map();
        this.actor = new St.BoxLayout({style_class: 'panthea-workspaces'});
        this.actor.connect('destroy', () => {
            // Shell can destroy the view before the extension is disabled.
            this._signals.clear();
            this._items.clear();
            this.actor = null;
        });
        this.separator = new St.Widget({style_class: 'dash-separator', y_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this.separator);
        this._box = new St.BoxLayout();
        this.scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            enable_mouse_scrolling: true,
        });
        this.scroll.set_child(this._box);
        this.actor.add_child(this.scroll);
        dash._dashContainer.insert_child_below(this.actor, dash._showAppsIcon);
        this._signals.connect(model, 'changed', () => this._sync());
        this._signals.connect(settings, 'changed::workspace-controls', () => this._sync());
        this._signals.connect(St.ThemeContext.get_for_stage(global.stage), 'notify::scale-factor', () => {
            for (const item of this._items.values())
                item.icon.update();
        });
        this._signals.connect(this.scroll, 'notify::allocation', () => this._ensureActiveVisible());
        this._signals.connect(this.scroll, 'scroll-event', (_actor, event) => {
            const adjustment = this.scroll.hadjustment;
            const direction = event.get_scroll_direction();
            let delta;
            if (direction === Clutter.ScrollDirection.SMOOTH) {
                const [dx, dy] = event.get_scroll_delta();
                delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            } else {
                delta = [Clutter.ScrollDirection.UP, Clutter.ScrollDirection.LEFT].includes(direction) ? -1 : 1;
            }
            adjustment.value = Math.clamp(adjustment.value + delta * this._buttonWidth,
                adjustment.lower, Math.max(adjustment.lower, adjustment.upper - adjustment.page_size));
            return Clutter.EVENT_STOP;
        });
        this._sync();
    }

    get count() {
        return this._items.size;
    }

    _sync() {
        // GNOME's trailing empty workspace is the + control, not another
        // regular workspace. Hide a lone regular workspace only while empty.
        const enabled = this._settings.get_boolean('workspace-controls');
        this.actor.visible = enabled;
        const allEntries = enabled ? this._model.entries : [];
        const entries = allEntries.some(entry => entry.isNew) && allEntries.length <= 2
            ? allEntries.filter(entry => entry.isNew || entry.windows.length > 0) : allEntries;
        for (const [workspace, item] of this._items) {
            if (!entries.some(entry => entry.workspace === workspace)) {
                item.destroy();
                this._items.delete(workspace);
            }
        }
        entries.forEach((entry, index) => {
            let item = this._items.get(entry.workspace);
            if (!item) {
                item = new WorkspaceButton(entry, actor => this._ensureVisible(actor));
                this._items.set(entry.workspace, item);
                this._box.add_child(item);
            } else {
                item.update(entry);
            }
            this._box.set_child_at_index(item, index);
            if (this._iconSize)
                item.icon.setIconSize(this._iconSize);
        });
        this._ensureActiveVisible();
    }

    setSize(size, buttonWidth, maxWidth) {
        this._iconSize = size;
        this._buttonWidth = buttonWidth;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.separator.height = size * scale;
        for (const item of this._items.values())
            item.icon.setIconSize(size);
        this.scroll.width = Math.max(buttonWidth, Math.min(this.count * buttonWidth, maxWidth));
    }

    _ensureActiveVisible() {
        const focused = global.stage.key_focus;
        const item = [...this._items.values()].find(actor => focused && actor.contains(focused)) ??
            [...this._items.values()].find(actor => actor.entry.active);
        if (item)
            this._ensureVisible(item);
    }

    _ensureVisible(item) {
        if (!item.has_allocation())
            return;
        const adjustment = this.scroll.hadjustment;
        const [x] = item.get_position();
        const start = Math.min(adjustment.value, x);
        adjustment.value = Math.clamp(Math.max(start, x + item.width - adjustment.page_size),
            adjustment.lower, Math.max(adjustment.lower, adjustment.upper - adjustment.page_size));
    }

    destroy() {
        this.actor?.destroy();
    }
}
