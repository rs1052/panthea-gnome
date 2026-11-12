// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {dominantColor} from '../shared/indicators.js';
import {Connections} from './signals.js';

// Shared by both docks, not application-grid tiles. St resolves app icons;
// decoding is asynchronous and the cache is bounded for long Shell sessions.
export class IndicatorColors {
    constructor() {
        this.theme = new St.IconTheme();
        this._cache = new Map();
        this._cancellable = new Gio.Cancellable();
        this._changedId = this.theme.connect('changed', () => this._cache.clear());
    }

    get(icon) {
        if (!icon)
            return Promise.resolve(null);
        const key = icon.to_string();
        if (this._cache.has(key))
            return this._cache.get(key);
        const promise = this._load(icon);
        if (this._cache.size >= 128)
            this._cache.delete(this._cache.keys().next().value);
        this._cache.set(key, promise);
        return promise;
    }

    async _load(icon) {
        try {
            const info = this.theme.lookup_by_gicon(icon, 64, St.IconLookupFlags.FORCE_SIZE);
            if (!info)
                return null;
            const image = await new Promise((resolve, reject) => {
                info.load_icon_async(this._cancellable, (source, result) => {
                    try {
                        resolve(source.load_icon_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            return dominantColor(image);
        } catch {
            // Missing icons, unsupported decoders and cancelled loads use the
            // native dot's theme-aware color, never interrupt Shell activation.
            return null;
        }
    }

    destroy() {
        this.theme.disconnect(this._changedId);
        this._cancellable.cancel();
        this._cache.clear();
    }
}

export class WindowIndicators {
    constructor(source, settings, colors) {
        this._source = source;
        this._settings = settings;
        this._colors = colors;
        this._signals = new Connections();
        this._windows = new Connections();
        this._generation = 0;
        this._originalOpacity = source._dot.opacity;
        this.actor = new St.BoxLayout({
            style_class: 'panthea-window-indicators',
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            reactive: false,
        });
        for (let i = 0; i < 4; i++)
            this.actor.add_child(new St.Widget({
                style_class: 'panthea-window-dot', y_align: Clutter.ActorAlign.END,
            }));
        source._iconContainer.add_child(this.actor);
        this._signals.connect(settings, 'changed::window-count-indicators', () => this._sync());
        this._signals.connect(source.app, 'windows-changed', () => this._syncWindows());
        this._signals.connect(global.workspace_manager, 'active-workspace-changed', () => this._sync());
        for (const signal of ['window-entered-monitor', 'window-left-monitor'])
            this._signals.connect(global.display, signal, () => this._sync());
        this._signals.connect(source._dot, 'style-changed', () => this._syncStyle());
        this._signals.connect(source, 'notify::mapped', () => {
            if (source.mapped)
                this._syncStyle();
        });
        this._signals.connect(source.icon._iconBin, 'notify::child', () => this._readColor());
        this._signals.connect(colors.theme, 'changed', () => this._readColor());
        this._signals.connect(source, 'destroy', () => this.destroy());
        this._syncWindows();
        this._readColor();
    }

    _syncWindows() {
        this._windows.clear();
        for (const window of this._source.app.get_windows()) {
            for (const signal of ['notify::skip-taskbar', 'workspace-changed', 'notify::on-all-workspaces'])
                this._windows.connect(window, signal, () => this._sync());
        }
        this._sync();
    }

    _sync() {
        const enabled = this._settings.get_boolean('window-count-indicators');
        this._source._dot.opacity = enabled ? 0 : this._originalOpacity;
        const windows = this._source.app.get_windows().filter(window => !window.skip_taskbar);
        const workspace = global.workspace_manager.get_active_workspace();
        this.onCurrentWorkspace = windows.some(window => window.located_on_workspace(workspace));
        this.count = Math.min(4, windows.length);
        this.actor[this.onCurrentWorkspace ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('active');
        this.actor.visible = enabled && this.count > 0;
        this.actor.get_children().forEach((dot, index) => {
            dot.visible = index < this.count;
        });
        if (this.actor.visible)
            this._syncStyle();
    }

    _syncStyle() {
        if (!this._source.get_stage())
            return;
        const node = this._source._dot.get_theme_node();
        this.actor.translation_y = node.get_length('offset-y');
        const fallback = node.get_background_color();
        let color = this._color ??
            `rgba(${fallback.red},${fallback.green},${fallback.blue},${fallback.alpha / 255})`;
        if (!this.onCurrentWorkspace) {
            // Soften the native theme's indicator toward neutral gray. This
            // stays light on dark docks and dark on light docks, without fade.
            const gray = Math.round((fallback.red + fallback.green + fallback.blue) / 6 + 64);
            color = `rgb(${gray},${gray},${gray})`;
        }
        for (const dot of this.actor.get_children())
            dot.set_style(`background-color: ${color};`);
    }

    async _readColor() {
        const generation = ++this._generation;
        this._color = null;
        // BaseIcon recreates its St.Icon when the theme or icon size changes.
        const color = await this._colors.get(this._source.icon.icon?.gicon);
        if (!this._source || generation !== this._generation)
            return;
        this._color = color;
        if (this.actor.visible)
            this._syncStyle();
    }

    destroy() {
        if (!this._source)
            return;
        this._windows.clear();
        this._signals.clear();
        this._source._dot.opacity = this._originalOpacity;
        if (this._source._pantheaIndicators === this)
            delete this._source._pantheaIndicators;
        this.actor.destroy();
        this._source = null;
    }
}
