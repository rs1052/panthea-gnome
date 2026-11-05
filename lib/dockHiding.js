// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Connections} from './signals.js';

// Automatic modes never reserve desktop space: revealing over an overlapping
// window must not resize it and cause an overlap/show/resize feedback loop.
// A separate stationary strut also keeps animation out of work-area geometry.
export class DockHiding {
    constructor(dock, settings) {
        this._dock = dock;
        this._settings = settings;
        this._signals = new Connections();
        this._windows = new Map();
        this._updateId = 0;
        this._leaveId = 0;
        this._menuOpen = false;
        this._dragging = false;
        this.hidden = false;
        this._strut = new St.Widget({opacity: 0});
        Main.layoutManager.addChrome(this._strut, {affectsStruts: true});
        // An input-only strip works even when the dock is completely offscreen.
        // Unlike a pressure barrier it also supports absolute pointer devices.
        this._edge = new St.Widget({reactive: true, track_hover: true});
        Main.layoutManager.addChrome(this._edge, {trackFullscreen: true});
        this._signals.connect(this._edge, 'notify::hover', () => this._interactionChanged());
        this._signals.connect(dock.dash, 'notify::hover', () => this._interactionChanged());
        this._signals.connect(dock.dash, 'menu-state-changed', (_dash, open) => {
            this._menuOpen = open;
            this._interactionChanged();
        });
        this._signals.connect(global.stage, 'notify::key-focus', () => this._interactionChanged());
        for (const name of ['item-drag-begin', 'window-drag-begin']) {
            this._signals.connect(Main.overview, name, () => {
                this._dragging = true;
                this._interactionChanged();
            });
        }
        for (const name of ['item-drag-end', 'item-drag-cancelled', 'window-drag-end', 'window-drag-cancelled']) {
            this._signals.connect(Main.overview, name, () => {
                this._dragging = false;
                this._interactionChanged();
            });
        }
        this._signals.connect(settings, 'changed::dock-hide-mode', () => {
            this._syncStrut();
            this._queueUpdate();
        });
        for (const name of ['showing', 'hidden'])
            this._signals.connect(Main.overview, name, () => this._queueUpdate());
        this._signals.connect(global.display, 'notify::focus-window', () => this._queueUpdate());
        this._signals.connect(global.display, 'window-created', (_display, window) => this._track(window));
        for (const name of ['window-entered-monitor', 'window-left-monitor', 'in-fullscreen-changed'])
            this._signals.connect(global.display, name, () => this._queueUpdate());
        this._signals.connect(global.workspace_manager, 'active-workspace-changed', () => this._queueUpdate());
        for (const actor of global.get_window_actors())
            this._track(actor.meta_window);
    }

    _track(window) {
        if (this._windows.has(window))
            return;
        const signals = new Connections();
        for (const name of ['position-changed', 'size-changed', 'workspace-changed',
            'notify::minimized', 'notify::maximized-vertically', 'notify::maximized-horizontally'])
            signals.connect(window, name, () => this._queueUpdate());
        signals.connect(window, 'unmanaged', () => {
            signals.clear();
            this._windows.delete(window);
            this._queueUpdate();
        });
        this._windows.set(window, signals);
        this._queueUpdate();
    }

    syncGeometry(monitor, height) {
        this._monitor = monitor;
        this._height = height;
        const width = Math.min(monitor.width, Math.ceil(this._dock.dash.width));
        this._rect = {x: monitor.x + (monitor.width - width) / 2,
            y: monitor.y + monitor.height - height, width, height};
        this._edge.set_position(Math.floor(this._rect.x), monitor.y + monitor.height - 1);
        this._edge.set_size(Math.max(1, width), 1);
        this._syncStrut();
        // Retarget an in-flight animation after scale, icon or monitor changes.
        this._setHidden(this.hidden, true);
        this._queueUpdate();
    }

    _syncStrut() {
        if (!this._monitor)
            return;
        const m = this._monitor;
        const height = this._settings.get_string('dock-hide-mode') === 'never' ? this._height : 0;
        this._strut.set_position(m.x, m.y + m.height - height);
        this._strut.set_size(m.width, height);
    }

    _inUse() {
        const focus = global.stage.key_focus;
        return this._edge.hover || this._dock.dash.hover || this._menuOpen || this._dragging ||
            (focus && this._dock.dash.contains(focus));
    }

    _interactionChanged() {
        if (this._leaveId)
            GLib.Source.remove(this._leaveId);
        this._leaveId = 0;
        if (this._inUse()) {
            this._queueUpdate();
        } else {
            // One-shot grace period bridges edge-to-dock motion and menu grabs.
            this._leaveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
                this._leaveId = 0;
                this._queueUpdate();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _queueUpdate() {
        if (this._updateId)
            return;
        this._updateId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._updateId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _eligible(window) {
        return window && !window.minimized && window.showing_on_its_workspace() &&
            window.located_on_workspace(global.workspace_manager.get_active_workspace()) &&
            window.get_window_type() !== Meta.WindowType.DESKTOP &&
            window.get_window_type() !== Meta.WindowType.DOCK;
    }

    _overlaps(window) {
        if (!this._eligible(window))
            return false;
        const r = window.get_frame_rect();
        const d = this._rect;
        return r.x < d.x + d.width && r.x + r.width > d.x &&
            r.y < d.y + d.height && r.y + r.height > d.y;
    }

    _update() {
        if (!this._rect)
            return;
        this._edge.reactive = !Main.overview.visible;
        const mode = this._settings.get_string('dock-hide-mode');
        const focus = global.display.focus_window;
        let hide = false;
        if (mode === 'unused')
            hide = true;
        else if (mode === 'focused-maximized')
            hide = this._eligible(focus) && focus.get_monitor() === this._monitor.index &&
                focus.maximized_vertically && focus.maximized_horizontally;
        else if (mode === 'focused-overlap')
            hide = this._overlaps(focus);
        else if (mode === 'any-overlap')
            hide = [...this._windows.keys()].some(window => this._overlaps(window));
        this._setHidden(Boolean(hide && !this._inUse() && !this._leaveId));
    }

    _setHidden(hidden, geometryChanged = false) {
        if (this.hidden === hidden && !geometryChanged)
            return;
        this.hidden = hidden;
        this._dock.dash.ease({translation_y: hidden ? this._height : 0,
            duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    destroy() {
        for (const id of [this._updateId, this._leaveId]) {
            if (id)
                GLib.Source.remove(id);
        }
        this._signals.clear();
        for (const signals of this._windows.values())
            signals.clear();
        this._windows.clear();
        this._dock.dash.remove_all_transitions();
        for (const actor of [this._edge, this._strut]) {
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
    }
}
