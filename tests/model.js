// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {panelState, wallpaperPoint} from '../shared/appearance.js';
import {DOCK_HIDE_MODES, DOCK_SIZES, QUICK_SETTINGS, QUICK_SETTINGS_INDICATORS, TOP_PANEL} from '../shared/options.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

assert(panelState([], 0) === 'translucent', 'Unknown wallpaper uses an overlay');
assert(panelState(Array(64).fill(30), 8) === 'transparent-light', 'Dark calm wallpaper uses light text');
assert(panelState(Array(64).fill(230), 8) === 'transparent-dark', 'Bright calm wallpaper uses dark text');
assert(panelState(Array.from({length: 64}, (_, i) => i % 2 ? 255 : 0), 8) === 'translucent',
    'Busy wallpaper uses an overlay');
const area = {x: 100, y: 200, width: 200, height: 100};
assert(wallpaperPoint(100, 200, 100, 100, area, 'zoom').join(',') === '0,25',
    'Zoom samples the visible crop, not the top of the source');
assert(wallpaperPoint(100, 200, 100, 100, area, 'scaled') === null,
    'Scaled letterbox uses the background color');
assert(wallpaperPoint(200, 250, 100, 100, area, 'stretched').join(',') === '50,50',
    'Stretched images map monitor-relative coordinates');
assert(DOCK_SIZES.join(',') === '32,48,64', 'Dock size choices');
assert(DOCK_HIDE_MODES.length === 5, 'Five Hide Dock radio choices');
assert(QUICK_SETTINGS.length === 6, 'All five JP tile controls plus Power Mode');
assert(QUICK_SETTINGS.every(([key]) => key.startsWith('show-qs-')),
    'Quick Settings contains only dropdown controls');
assert(QUICK_SETTINGS_INDICATORS.map(([key]) => key).join(',') === [
    'show-panel-network', 'show-panel-bluetooth', 'show-panel-audio',
    'show-panel-power-icon', 'show-panel-power-mode', 'show-panel-night-light',
].join(','), 'Quick Settings Indicators contains the six native Quick Settings status icons');
assert(TOP_PANEL.map(([key]) => key).join(',') === [
    'show-panel-activities', 'show-panel-date', 'show-panel-notifications', 'show-panel-keyboard',
    'show-panel-accessibility', 'show-panel-quick-settings', 'show-panel-screen-sharing', 'show-panel-screen-recording',
].join(','), 'Top Panel contains the remaining panel controls and warnings');

const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const [ok, bytes] = GLib.file_get_contents(`${root}/schemas/org.gnome.shell.extensions.panthea.gschema.xml`);
assert(ok, 'Schema is readable');
const schema = new TextDecoder().decode(bytes);
assert(!schema.includes('applications-view'), 'Obsolete View preference is retired');
for (const [value] of DOCK_HIDE_MODES)
    assert(schema.includes(`<choice value="${value}"/>`), `Hide mode ${value} has a schema choice`);
assert(/<key name="dock-hide-mode" type="s">[\s\S]*?<default>'never'<\/default>/.test(schema),
    'Hide Dock defaults to Never');
assert(/<key name="show-apps-button" type="b">\s*<default>true<\/default>/.test(schema),
    'Show Apps Button defaults to shown');
const visibility = [...QUICK_SETTINGS, ...QUICK_SETTINGS_INDICATORS, ...TOP_PANEL];
assert(visibility.length === 20, 'All 20 existing visibility settings are retained');
for (const [key] of visibility)
    assert(schema.includes(`name="${key}"`), `Visibility option ${key} has a schema key`);
const keys = visibility.map(([key]) => key);
assert(new Set(keys).size === keys.length, 'Visibility keys are unique');
print('PASS: appearance model and settings inventory checks');
