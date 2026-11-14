// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Connections} from './signals.js';

export function formatPanelClock(date, time) {
    return `${date.format('%A, %B %-d')} ${time}`;
}

export class PanelClock {
    constructor() {
        // Keep private date-menu access isolated, and leave its native binding intact.
        const dateMenu = Main.panel.statusArea.dateMenu;
        this._display = dateMenu._clockDisplay;
        this._nativeClock = dateMenu._clock;
        this._clock = new GnomeDesktop.WallClock({time_only: true});
        this._signals = new Connections();
        this._signals.connect(this._clock, 'notify::clock', () => this._update());
        this._signals.connect(this._clock, 'notify::timezone', () => this._update());
        this._signals.connect(this._display, 'notify::text', () => this._update());
        this._update();
    }

    _update() {
        const text = formatPanelClock(GLib.DateTime.new_now_local(), this._clock.clock);
        // Native clock updates still reach the label. Only change differing text,
        // including during the notification caused by our own update.
        if (this._display.text !== text)
            this._display.text = text;
    }

    destroy() {
        this._signals.clear();
        this._display.text = this._nativeClock.clock;
        this._clock.run_dispose();
        this._clock = null;
    }
}
