// SPDX-License-Identifier: GPL-3.0-or-later
// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {DOCK_HIDE_MODES, QUICK_SETTINGS, QUICK_SETTINGS_INDICATORS, TOP_PANEL} from './shared/options.js';

export default class PantheaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 700);
        window.search_enabled = true;

        const applications = new Adw.PreferencesPage({
            title: 'Applications', icon_name: 'view-app-grid-symbolic',
        });
        const launcher = new Adw.PreferencesGroup({title: 'Applications Menu'});
        this._switch(launcher, settings, 'applications-enabled', 'Applications Menu',
            'Show Applications beside the Activities button.');
        applications.add(launcher);
        window.add(applications);

        const dock = new Adw.PreferencesPage({title: 'Dock & Panel', icon_name: 'focus-windows-symbolic'});
        const behavior = new Adw.PreferencesGroup({title: 'Dock'});
        const size = new Adw.ComboRow({title: 'Icon Size', model: Gtk.StringList.new(['Small', 'Medium', 'Large'])});
        settings.bind('dock-icon-size', size, 'selected', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(size);
        this._switch(behavior, settings, 'show-apps-button', 'Show Apps Button',
            "Show the button that opens GNOME's application grid.");
        dock.add(behavior);
        const hiding = new Adw.PreferencesGroup({title: 'Hide Dock'});
        const buttons = new Map();
        let first = null;
        for (const [value, title] of DOCK_HIDE_MODES) {
            const button = new Gtk.CheckButton({valign: Gtk.Align.CENTER});
            if (first)
                button.set_group(first);
            else
                first = button;
            button.active = settings.get_string('dock-hide-mode') === value;
            const row = new Adw.ActionRow({title, activatable_widget: button});
            row.add_prefix(button);
            button.connect('toggled', () => {
                if (button.active)
                    settings.set_string('dock-hide-mode', value);
            });
            buttons.set(value, button);
            hiding.add(row);
        }
        const hideChanged = settings.connect('changed::dock-hide-mode', () => {
            buttons.get(settings.get_string('dock-hide-mode')).active = true;
        });
        window.connect('close-request', () => {
            settings.disconnect(hideChanged);
            return false;
        });
        dock.add(hiding);
        const appearance = new Adw.PreferencesGroup({title: 'Appearance'});
        this._switch(appearance, settings, 'automatic-translucency', 'Panel Translucency',
            'Automatically transparent or opaque based on the wallpaper.');
        dock.add(appearance);
        window.add(dock);

        const visibility = new Adw.PreferencesPage({title: 'Visibility', icon_name: 'view-reveal-symbolic'});
        for (const [title, options] of [
            ['Quick Settings', QUICK_SETTINGS],
            ['Quick Settings Indicators', QUICK_SETTINGS_INDICATORS],
            ['Top Panel', TOP_PANEL],
        ]) {
            const group = new Adw.PreferencesGroup({
                title, description: 'Choose which controls are visible. System functionality stays enabled.',
            });
            for (const [key, label, subtitle] of options)
                this._switch(group, settings, key, label, subtitle);
            visibility.add(group);
        }
        window.add(visibility);
    }

    _switch(group, settings, key, title, subtitle = '') {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
    }
}
