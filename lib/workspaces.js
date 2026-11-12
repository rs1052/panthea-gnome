// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Connections} from './signals.js';

// One event-driven model shared by the desktop and Overview views. Workspace
// objects, not indices, are the identity: GNOME may remove or reorder them.
export const Workspaces = GObject.registerClass({
    Signals: {'changed': {}},
}, class Workspaces extends GObject.Object {
    _init() {
        super._init();
        this._signals = new Connections();
        this._workspaceSignals = new Connections();
        this._windows = new Map();
        this._updateId = 0;
        this.entries = [];
        this._tracker = Shell.WindowTracker.get_default();
        this._settings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._names = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        const manager = global.workspace_manager;
        this._signals.connect(manager, 'notify::n-workspaces', () => this._syncWorkspaces());
        this._signals.connect(manager, 'workspaces-reordered', () => this._queueUpdate());
        this._signals.connect(manager, 'active-workspace-changed', () => this._queueUpdate());
        this._signals.connect(this._settings, 'changed::dynamic-workspaces', () => this._queueUpdate());
        this._signals.connect(this._settings, 'changed::workspaces-only-on-primary', () => this._queueUpdate());
        this._signals.connect(this._names, 'changed::workspace-names', () => this._queueUpdate());
        this._signals.connect(this._tracker, 'tracked-windows-changed', () => this._queueUpdate());
        this._signals.connect(Shell.AppSystem.get_default(), 'installed-changed', () => this._queueUpdate());
        this._signals.connect(global.display, 'window-created', (_display, window) => this._track(window));
        for (const signal of ['window-entered-monitor', 'window-left-monitor'])
            this._signals.connect(global.display, signal, () => this._queueUpdate());
        this._syncWorkspaces();
        this._update();
    }

    _syncWorkspaces() {
        this._workspaceSignals.clear();
        const manager = global.workspace_manager;
        for (let i = 0; i < manager.n_workspaces; i++) {
            const workspace = manager.get_workspace_by_index(i);
            this._workspaceSignals.connect(workspace, 'window-added', (_workspace, window) => this._track(window));
            this._workspaceSignals.connect(workspace, 'window-removed', () => this._queueUpdate());
            for (const window of workspace.list_windows())
                this._track(window);
        }
        this._queueUpdate();
    }

    _track(window) {
        if (!this._windows.has(window)) {
            const signals = new Connections();
            for (const signal of ['workspace-changed', 'notify::on-all-workspaces',
                'notify::skip-taskbar', 'notify::window-type', 'notify::wm-class',
                'notify::gtk-application-id'])
                signals.connect(window, signal, () => this._queueUpdate());
            signals.connect(window, 'unmanaged', () => {
                signals.clear();
                this._windows.delete(window);
                this._queueUpdate();
            });
            this._windows.set(window, signals);
        }
        this._queueUpdate();
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

    _update() {
        const manager = global.workspace_manager;
        const names = this._names.get_strv('workspace-names');
        const windows = [...this._windows.keys()].filter(window =>
            !window.skip_taskbar && ![Meta.WindowType.DESKTOP, Meta.WindowType.DOCK]
                .includes(window.get_window_type()))
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
        const entries = [];
        for (let i = 0; i < manager.n_workspaces; i++) {
            const workspace = manager.get_workspace_by_index(i);
            entries.push({
                workspace,
                name: names[i] || `Workspace ${i + 1}`,
                active: workspace === manager.get_active_workspace(),
                isNew: this._settings.get_boolean('dynamic-workspaces') && i === manager.n_workspaces - 1,
                windows: windows.filter(window => window.located_on_workspace(workspace))
                    .map(window => ({window, app: this._tracker.get_window_app(window)})),
            });
        }
        // WindowTracker also reports title changes. Do not redraw the dock or
        // reset its scroll position when the represented state is unchanged.
        if (entries.length === this.entries.length && entries.every((entry, i) => {
            const previous = this.entries[i];
            return entry.workspace === previous.workspace && entry.name === previous.name &&
                entry.active === previous.active && entry.isNew === previous.isNew &&
                entry.windows.length === previous.windows.length && entry.windows.every((item, j) =>
                    item.window === previous.windows[j].window && item.app === previous.windows[j].app);
        }))
            return;
        this.entries = entries;
        this.emit('changed');
    }

    destroy() {
        if (this._updateId)
            GLib.Source.remove(this._updateId);
        this._updateId = 0;
        this._signals.clear();
        this._workspaceSignals.clear();
        for (const signals of this._windows.values())
            signals.clear();
        this._windows.clear();
        this.entries = [];
    }
});
