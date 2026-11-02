// SPDX-License-Identifier: GPL-3.0-or-later
// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Appearance} from './lib/appearance.js';
import {Dock} from './lib/dock.js';
import {Launcher} from './lib/launcher.js';
import {Connections} from './lib/signals.js';
import {Visibility} from './lib/visibility.js';

export default class PantheaExtension extends Extension {
    enable() {
        const conflicts = [
            'dash-to-dock@micxgx.gmail.com',
            'bottom-dash-panel@fthx',
            'just-perfection-desktop@just-perfection',
            'AutoColor-top-Bar@baitsart.github.com',
            'transparent-top-bar@ftpix.com',
            'arcmenu@arcmenu.com',
        ].filter(uuid => Main.extensionManager.lookup(uuid)?.state === ExtensionState.ACTIVE);
        if (conflicts.length)
            throw new Error(`Disable overlapping extensions before enabling Panthea: ${conflicts.join(', ')}`);

        this._settings = this.getSettings();
        this._signals = new Connections();
        try {
            this._dock = new Dock(this._settings);
            this._visibility = new Visibility(this._settings);
            this._syncLauncher();
            this._syncAppearance();
            this._signals.connect(this._settings, 'changed::applications-enabled', () => this._syncLauncher());
            this._signals.connect(this._settings, 'changed::automatic-translucency', () => this._syncAppearance());
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    disable() {
        this._signals?.clear();
        this._appearance?.destroy();
        this._appearance = null;
        this._launcher?.destroy();
        this._launcher = null;
        this._visibility?.destroy();
        this._visibility = null;
        this._dock?.destroy();
        this._dock = null;
        this._signals = null;
        this._settings = null;
    }

    _syncLauncher() {
        if (this._settings.get_boolean('applications-enabled')) {
            if (!this._launcher) {
                this._launcher = new Launcher(this._settings);
                const activities = Main.panel.statusArea.activities?.container;
                const sibling = activities?.get_parent() === Main.panel._leftBox ? activities : activities?.get_parent();
                const position = sibling ? Main.panel._leftBox.get_children().indexOf(sibling) + 1 : 0;
                Main.panel.addToStatusArea(this.uuid, this._launcher, position, 'left');
            }
        } else {
            this._launcher?.destroy();
            this._launcher = null;
        }
    }

    _syncAppearance() {
        if (this._settings.get_boolean('automatic-translucency')) {
            this._appearance ??= new Appearance(this._dock);
        } else {
            this._appearance?.destroy();
            this._appearance = null;
        }
    }
}
