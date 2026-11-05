// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as ParentalControls from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';

import {Connections} from './signals.js';

export class Catalog {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._signals = new Connections();
        this._appSystem = Shell.AppSystem.get_default();
        this._parental = ParentalControls.getDefault();
        this.entries = [];
        this.byId = new Map();
        this.ready = false;
        this._sourceId = 0;
        this._signals.connect(this._appSystem, 'installed-changed', () => this._refresh());
        this._signals.connect(this._parental, 'app-filter-changed', () => this._refresh());
        this._refresh();
    }

    _refresh() {
        if (this._sourceId)
            GLib.Source.remove(this._sourceId);
        const infos = this._appSystem.get_installed();
        const entries = [];
        let index = 0;
        this._sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const deadline = GLib.get_monotonic_time() + 3000;
            while (index < infos.length && GLib.get_monotonic_time() < deadline) {
                const info = infos[index++];
                if (this._parental.shouldShowApp(info)) {
                    try {
                        const id = info.get_id();
                        entries.push({id, info, name: info.get_display_name()});
                    } catch (error) {
                        console.warn(`[Panthea] Ignoring invalid application metadata: ${error.message}`);
                    }
                }
            }
            if (index < infos.length)
                return GLib.SOURCE_CONTINUE;
            entries.sort((a, b) => a.name.localeCompare(b.name));
            this.entries = entries;
            this.byId = new Map(entries.map(entry => [entry.id, entry]));
            this.ready = this._parental.initialized;
            this._sourceId = 0;
            this._onChanged();
            return GLib.SOURCE_REMOVE;
        });
    }

    search(query) {
        if (!query.trim())
            return this.entries;
        const usage = Shell.AppUsage.get_default();
        return Shell.AppSystem.search(query.trim()).flatMap(group =>
            group.filter(id => this.byId.has(id))
                .sort((a, b) => usage.compare(a, b))
                .map(id => this.byId.get(id)));
    }

    app(entry) {
        return this._appSystem.lookup_app(entry.id);
    }

    destroy() {
        if (this._sourceId)
            GLib.Source.remove(this._sourceId);
        this._sourceId = 0;
        this._signals.clear();
        this.entries = [];
        this.byId.clear();
        this._onChanged = null;
    }
}
