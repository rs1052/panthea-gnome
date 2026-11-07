// SPDX-License-Identifier: GPL-3.0-or-later
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Connections} from './signals.js';

// A short opacity handoff, with no changes to either dock's natural geometry.
export class DockTransition {
    constructor(dock) {
        this._dock = dock;
        this._signals = new Connections();
        this._desktopOpacity = dock.actor.opacity;
        this._nativeOpacities = [dock.nativeDash._background, dock.nativeDash._dashContainer]
            .map(actor => [actor, actor.opacity]);
        this._adjustment = Main.overview._overview.controls._stateAdjustment;
        this._signals.connect(this._adjustment, 'notify::value', () => this._sync());
        for (const name of ['showing', 'shown', 'hiding', 'hidden'])
            this._signals.connect(Main.overview, name, () => this._sync());
        this._signals.connect(Main.layoutManager, 'startup-complete', () => this._sync());
        this._signals.connect(St.Settings.get(), 'notify::enable-animations', () => this._sync());
        // Opacity does not disable picking. Treat the fading desktop dock like
        // Overview's cover pane, preventing its children from activating.
        this._signals.connect(dock.dash, 'captured-event', (_actor, event) => {
            // Crossing events must propagate so Clutter can maintain focus.
            if (event.type() === Clutter.EventType.ENTER || event.type() === Clutter.EventType.LEAVE)
                return Clutter.EVENT_PROPAGATE;
            return Main.overview.visible ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        });
        this._sync();
    }

    _sync() {
        let desktop = Main.overview.visible ? 0 : 1;
        let overview = 1;
        if (Main.overview.visible && !Main.layoutManager._startingUp &&
            St.Settings.get().enable_animations) {
            const progress = Math.clamp(this._adjustment.value, 0, 1);
            // Fade out before fading in. Different icon positions/sizes must
            // never produce a doubled row. The narrow middle interval keeps
            // the handoff brief, and naturally follows reversed gestures.
            desktop = Math.clamp((0.5 - progress) / 0.25, 0, 1);
            overview = Math.clamp((progress - 0.5) / 0.25, 0, 1);
        }
        this._dock.actor.opacity = Math.round(this._desktopOpacity * desktop);
        this._dock.dash.visible = desktop > 0;
        for (const [actor, opacity] of this._nativeOpacities)
            actor.opacity = Math.round(opacity * overview);
    }

    destroy() {
        this._signals.clear();
        this._dock.actor.opacity = this._desktopOpacity;
        for (const [actor, opacity] of this._nativeOpacities)
            actor.opacity = opacity;
    }
}
