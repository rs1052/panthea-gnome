// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Connections} from './signals.js';
import {visibilityTargets} from './shellTargets.js';

// Hide an owned parent, not the native actor. This preserves native visibility
// bindings, availability changes and the Airplane Mode panel indicator. A
// notify::visible + hide() loop would lose that state and couple the two controls.
class HiddenActor {
    constructor(actor, grid) {
        this.actor = actor;
        this._grid = grid;
        const parent = actor.get_parent();
        const index = parent.get_children().indexOf(actor);
        this._span = grid ? parent.layout_manager.get_child_meta(parent, actor).column_span : null;
        actor.menu?.close();
        this.wrapper = new St.Bin({name: 'panthea-hidden', visible: false});
        const showOnParent = actor.show_on_set_parent;
        actor.show_on_set_parent = false;
        parent.remove_child(actor);
        this.wrapper.child = actor;
        actor.show_on_set_parent = showOnParent;
        parent.insert_child_at_index(this.wrapper, index);
        if (grid)
            parent.layout_manager.child_set_property(parent, this.wrapper, 'column-span', this._span);
        this._destroyId = actor.connect('destroy', () => {
            this.actor = null;
        });
    }

    restore() {
        const parent = this.wrapper.get_parent();
        if (this.actor) {
            this.actor.disconnect(this._destroyId);
            const index = parent?.get_children().indexOf(this.wrapper) ?? -1;
            const stillWrapped = this.actor.get_parent() === this.wrapper;
            const showOnParent = this.actor.show_on_set_parent;
            this.actor.show_on_set_parent = false;
            this.wrapper.child = null;
            if (parent && stillWrapped) {
                parent.insert_child_at_index(this.actor, index);
                if (this._grid)
                    parent.layout_manager.child_set_property(parent, this.actor, 'column-span', this._span);
            }
            this.actor.show_on_set_parent = showOnParent;
        }
        this.wrapper.destroy();
        this.actor = null;
    }
}

export class Visibility {
    constructor(settings) {
        this._settings = settings;
        this._signals = new Connections();
        this._hidden = new Map();
        this._changing = false;
        this._discoveryId = 0;
        const qs = Main.panel.statusArea.quickSettings;
        this._signals.connect(settings, 'changed', (_settings, key) => {
            if (key.startsWith('show-'))
                this._sync();
        });
        // Quick Settings finishes construction asynchronously on GNOME 50.
        this._signals.connect(qs._indicators, 'child-added', () => this._queueDiscovery());
        this._signals.connect(qs.menu._grid, 'child-added', () => this._queueDiscovery());
        this._signals.connect(Main.panel._rightBox, 'child-added', () => this._queueDiscovery());
        this._signals.connect(Main.sessionMode, 'updated', () => this._sync());
        this._sync();
    }

    _queueDiscovery() {
        if (this._changing || this._discoveryId)
            return;
        // child-added runs before GNOME assigns grid metadata and submenus.
        // Wait for that construction to finish, but apply before painting.
        this._discoveryId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._discoveryId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        if (this._changing)
            return;
        this._changing = true;
        try {
            for (const [key, actor, grid] of visibilityTargets(Main.panel)) {
                let hidden = this._hidden.get(actor);
                if (hidden && actor.get_parent() !== hidden.wrapper) {
                    hidden.restore();
                    this._hidden.delete(actor);
                    hidden = null;
                }
                if (this._settings.get_boolean(key)) {
                    if (hidden) {
                        hidden.restore();
                        this._hidden.delete(actor);
                    }
                } else if (!hidden && actor.get_parent()) {
                    if (key === 'show-panel-quick-settings')
                        Main.panel.closeQuickSettings();
                    this._hidden.set(actor, new HiddenActor(actor, grid));
                }
            }
        } finally {
            this._changing = false;
        }
    }

    destroy() {
        if (this._discoveryId)
            global.compositor.get_laters().remove(this._discoveryId);
        this._discoveryId = 0;
        this._signals.clear();
        for (const hidden of this._hidden.values())
            hidden.restore();
        this._hidden.clear();
    }
}
