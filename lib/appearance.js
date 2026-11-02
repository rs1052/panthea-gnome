// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Connections} from './signals.js';
import {Wallpaper} from './wallpaper.js';

export class Appearance {
    constructor(dock) {
        this._signals = new Connections();
        this._sourceId = 0;
        this._windows = new Map();
        this._dock = dock;
        this._panelButtons = [Main.panel.statusArea.activities, Main.panel.statusArea.quickSettings];
        for (const button of this._panelButtons)
            button.add_style_class_name('panthea-panel-control');
        this._wallpaper = new Wallpaper(() => this._queueUpdate());
        this._signals.connect(global.display, 'window-created', (_display, window) => this._track(window));
        for (const name of ['window-entered-monitor', 'window-left-monitor', 'in-fullscreen-changed'])
            this._signals.connect(global.display, name, () => this._queueUpdate());
        this._signals.connect(global.workspace_manager, 'active-workspace-changed', () => this._queueUpdate());
        this._signals.connect(Main.layoutManager, 'monitors-changed', () => this._queueUpdate());
        for (const actor of global.get_window_actors())
            this._track(actor.meta_window);
        this._update();
    }

    _track(window) {
        if (this._windows.has(window))
            return;
        const signals = new Connections();
        for (const name of ['notify::maximized-vertically', 'notify::maximized-horizontally',
            'notify::fullscreen', 'notify::minimized', 'workspace-changed'])
            signals.connect(window, name, () => this._queueUpdate());
        signals.connect(window, 'unmanaged', () => {
            signals.clear();
            this._windows.delete(window);
            this._queueUpdate();
        });
        this._windows.set(window, signals);
        this._queueUpdate();
    }

    _queueUpdate() {
        if (this._sourceId)
            return;
        this._sourceId = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this._sourceId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _update() {
        const workspace = global.workspace_manager.get_active_workspace();
        const qualifyingWindow = workspace.list_windows().some(window =>
            window.get_monitor() === Main.layoutManager.primaryIndex && !window.minimized &&
            window.get_window_type() === Meta.WindowType.NORMAL &&
            (window.fullscreen || (window.maximized_vertically && window.maximized_horizontally)));
        const wallpaperTranslucent = this._wallpaper.state === 'translucent';
        this.panelState = qualifyingWindow ? 'translucent' : this._wallpaper.state;
        const lightTranslucent = wallpaperTranslucent && !this._wallpaper.dark;
        const darkText = lightTranslucent || this.panelState === 'transparent-dark';
        for (const [name, enabled] of [
            ['panthea-surface', !lightTranslucent],
            ['panthea-surface-light', lightTranslucent],
        ])
            this._dock.background[enabled ? 'add_style_class_name' : 'remove_style_class_name'](name);
        for (const [name, enabled] of [
            ['panthea-dark-dock', !lightTranslucent],
            ['panthea-light-dock', lightTranslucent],
        ])
            this._dock.dash[enabled ? 'add_style_class_name' : 'remove_style_class_name'](name);
        // Keep desktop state installed. GNOME's :overview rule and native
        // transition take over without inline overrides or queued restyling.
        for (const [name, enabled] of [
            ['panthea-panel', true],
            ['panthea-surface', this.panelState === 'translucent' && !lightTranslucent],
            ['panthea-surface-light', lightTranslucent],
            ['panthea-dark-text', darkText],
        ])
            Main.panel[enabled ? 'add_style_class_name' : 'remove_style_class_name'](name);
    }

    destroy() {
        if (this._sourceId)
            GLib.Source.remove(this._sourceId);
        this._sourceId = 0;
        this._wallpaper.destroy();
        this._signals.clear();
        for (const signals of this._windows.values())
            signals.clear();
        this._windows.clear();
        for (const button of this._panelButtons)
            button.remove_style_class_name('panthea-panel-control');
        for (const name of ['panthea-panel',
            'panthea-surface', 'panthea-surface-light', 'panthea-dark-text'])
            Main.panel.remove_style_class_name(name);
        this._dock.background.remove_style_class_name('panthea-surface');
        this._dock.background.remove_style_class_name('panthea-surface-light');
        this._dock.dash.remove_style_class_name('panthea-dark-dock');
        this._dock.dash.remove_style_class_name('panthea-light-dock');
    }
}
