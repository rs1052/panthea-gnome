// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {panelState, wallpaperPoint} from '../shared/appearance.js';
import {dominantColor} from '../shared/indicators.js';
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
const image = (pixels, n_channels = 4, rowstride = n_channels) => ({
    width: 1, height: pixels.length / rowstride, rowstride, n_channels,
    has_alpha: n_channels === 4, get_pixels: () => pixels,
});
assert(dominantColor(image([255, 0, 0, 255])) === 'rgb(230,80,80)', 'Red icon keeps its hue');
assert(dominantColor(image([0, 255, 0], 3)) === 'rgb(80,230,80)', 'RGB icons need no alpha channel');
assert(dominantColor(image([0, 0, 255, 255, 255, 0, 0, 0])) === 'rgb(80,80,230)',
    'Transparent pixels do not tint indicators');
assert(dominantColor(image([255, 0, 0, 255, 12, 34, 56, 78], 4, 8)) === 'rgb(230,80,80)',
    'Row padding is not sampled');
assert(dominantColor(image([255, 0, 0, 0])) === null, 'Transparent icons use theme fallback');
for (const gray of [0, 64, 128, 153, 192, 255]) {
    assert(dominantColor(image([gray, gray, gray, 255])) === null,
        `Monochrome ${gray} icons use theme fallback`);
    assert(dominantColor(image([gray, gray, gray, 255, 255, 128, 0, 255])) === 'rgb(230,155,80)',
        `Neutral ${gray} pixels do not dilute icon colors`);
}
assert(dominantColor(image([240, 245, 250, 255])) === null,
    'Near-white icons use theme fallback rather than a faint tint');
assert(dominantColor(image([128, 135, 140, 255, 0, 0, 255, 255])) === 'rgb(80,80,230)',
    'Near-gray pixels do not dilute icon colors');
assert(dominantColor(image([255, 255, 0, 255])) === 'rgb(230,230,80)',
    'Bright saturated colors are not excluded');
assert(dominantColor(image([255, 0, 0, 255, 0, 255, 255, 255])) === 'rgb(230,80,80)',
    'Unrelated hues select a stable winner instead of averaging to gray');
assert(dominantColor(image([10, 10, 14, 255, 26, 26, 30, 255])) === null,
    'Tiny channel differences in dark pixels do not become saturated blue');
assert(dominantColor(image([...Array(99).fill([61, 56, 70, 255]).flat(), 220, 50, 65, 255])) ===
    'rgb(230,80,93)', 'A thin red hand wins over a muted purple clock face');
assert(dominantColor(image([...Array(999).fill([26, 26, 27, 255]).flat(), 0, 0, 255, 255])) ===
    null, 'An isolated colored pixel does not tint a neutral icon');
assert(dominantColor(image([255, 0, 10, 255, 255, 10, 0, 255])) === 'rgb(230,80,80)',
    'Similar reds on either side of the hue wrap share one group');
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
assert(/<key name="window-count-indicators" type="b">\s*<default>true<\/default>/.test(schema),
    'Window Count Indicators default to enabled');
assert(/<key name="workspace-controls" type="b">\s*<default>true<\/default>/.test(schema),
    'Workspace Controls default to enabled');
const visibility = [...QUICK_SETTINGS, ...QUICK_SETTINGS_INDICATORS, ...TOP_PANEL];
assert(visibility.length === 20, 'All 20 existing visibility settings are retained');
for (const [key] of visibility)
    assert(schema.includes(`name="${key}"`), `Visibility option ${key} has a schema key`);
const keys = visibility.map(([key]) => key);
assert(new Set(keys).size === keys.length, 'Visibility keys are unique');
print('PASS: appearance model and settings inventory checks');
