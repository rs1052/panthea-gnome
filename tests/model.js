// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {categoryFor, pageSlice} from '../shared/model.js';
import {categoryItems, folderEntries, layoutIds, moveBefore, orderedItems} from '../shared/appLayout.js';
import {panelState, wallpaperPoint} from '../shared/appearance.js';
import {CATEGORIES, DOCK_HIDE_MODES, DOCK_SIZES, QUICK_SETTINGS, QUICK_SETTINGS_INDICATORS, TOP_PANEL} from '../shared/options.js';
import {AppLayout} from '../lib/appLayout.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

assert(categoryFor(null) === 'Other', 'Missing categories use Other');
assert(categoryFor('Audio;Player;') === 'AudioVideo', 'Audio is a Sound & Video application');
assert(categoryFor('Utility;Development;') === 'Development', 'Category precedence is deterministic');
assert(categoryFor('Network;WebBrowser;') === 'Network', 'Desktop-file categories are used');
const categoryOrder = categoryItems(CATEGORIES);
assert(categoryOrder.slice(0, 2).map(([id]) => id).join(',') === 'favorites,all', 'Favorites and All Applications lead');
assert(categoryOrder.slice(2).map(([, name]) => name).join(',') ===
    CATEGORIES.map(([, name]) => name).toSorted((a, b) => a.localeCompare(b)).join(','),
'Remaining categories sort by label without changing category precedence');
const pages = [{b: {position: 2}, a: {position: 0}}, {c: {position: 0}, a: {position: 1}}];
assert(layoutIds(pages).join(',') === 'a,b,c', 'Layout follows pages and positions, ignoring duplicate IDs');
const layoutEntries = ['d', 'c', 'b', 'a', 'e'].map(id => ({id, name: id,
    info: {get_categories: () => id === 'c' || id === 'e' ? 'Utility;' : null}}));
assert(orderedItems(layoutEntries, pages).map(entry => entry.id).join(',') === 'a,b,c,d,e',
    'Saved order precedes alphabetical unpositioned apps');
assert(orderedItems(layoutEntries, []).map(entry => entry.id).join(',') === 'a,b,c,d,e',
    'An empty native layout uses alphabetical order');
const folder = {apps: ['b', 'a', 'missing', 'b'], categories: ['Utility'], excluded: ['a', 'c']};
assert(folderEntries(folder, layoutEntries).map(entry => entry.id).join(',') === 'b,e',
    'Folders combine explicit and category members, honoring exclusions and missing apps');
assert(folderEntries({apps: ['b'], categories: ['Utility'], excluded: []},
    layoutEntries.map(entry => ({...entry, catalogOrder: entry.id === 'e' ? 0 : 1})))
    .map(entry => entry.id).join(',') === 'b,e,c',
'Automatic folder members follow GNOME installed-app order after explicit members');
assert(moveBefore(['a', 'b', 'c'], 'c', 'a').join(',') === 'c,a,b', 'Move before an anchor');
assert(moveBefore(['a', 'b', 'c'], 'a', 'c', true).join(',') === 'b,c,a', 'Move after an anchor');
assert(pageSlice(orderedItems(layoutEntries, pages), 1, 2).entries.map(entry => entry.id).join(',') === 'c,d',
    'Panthea reflows native pages without changing global ordering');
const originalLayout = new GLib.Variant('aa{sv}', [
    {a: new GLib.Variant('a{sv}', {position: new GLib.Variant('i', 0), extra: new GLib.Variant('s', 'keep')}),
        b: new GLib.Variant('a{sv}', {position: new GLib.Variant('i', 1)})},
    {missing: new GLib.Variant('a{sv}', {position: new GLib.Variant('i', 0)})},
]);
const fakeLayout = {settings: {get_value: () => originalLayout}};
const packedLayout = AppLayout.prototype._layoutChange.call(fakeLayout, ['b', 'a', 'missing', 'new'])[2];
assert(packedLayout.deepUnpack().length === 2 && Object.keys(packedLayout.deepUnpack()[0]).length === 2,
    'Writes preserve native page capacities, not Panthea page sizes');
assert(packedLayout.recursiveUnpack()[0].a.extra === 'keep' && packedLayout.recursiveUnpack()[1].missing,
    'Writes retain unknown metadata and unavailable app positions');
const values = new Map([['first', new GLib.Variant('s', 'old')], ['second', new GLib.Variant('s', 'old')]]);
let writes = 0;
const backend = {
    is_writable: key => key !== 'locked', get_value: key => values.get(key),
    set_value: (key, value) => {
        writes++;
        if (key === 'second')
            return false;
        values.set(key, value);
        return true;
    },
};
let failed = false;
try {
    AppLayout.prototype._write([[backend, 'first', new GLib.Variant('s', 'new')],
        [backend, 'locked', new GLib.Variant('s', 'new')]]);
} catch {
    failed = true;
}
assert(failed && writes === 0, 'Locked keys reject the entire edit before any write');
failed = false;
try {
    AppLayout.prototype._write([[backend, 'first', new GLib.Variant('s', 'new')],
        [backend, 'second', new GLib.Variant('s', 'new')]]);
} catch {
    failed = true;
}
assert(failed && values.get('first').unpack() === 'old', 'Rejected writes restore earlier keys in the edit');
const entries = Array.from({length: 37}, (_, index) => index);
assert(pageSlice(entries, 0, 18).entries.length === 18, 'First page is bounded');
assert(pageSlice(entries, 100, 18).page === 2, 'Removed pages clamp to the last page');
assert(pageSlice(entries, -1, 18).page === 0, 'Negative pages clamp');
assert(pageSlice([], 0, 18).pages === 1, 'Empty results retain one page');
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
print('PASS: model, pagination, category and settings inventory checks');
