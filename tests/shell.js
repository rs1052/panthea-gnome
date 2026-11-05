// SPDX-License-Identifier: GPL-3.0-or-later
// Run only through gnome-shell-test-tool, which supplies isolated settings/data.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import {AppSearchProvider} from 'resource:///org/gnome/shell/ui/appDisplay.js';
import {GridSearchResults} from 'resource:///org/gnome/shell/ui/search.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

export const METRICS = {};

export function init() {
    // The test tool isolates Shell's environment, but D-Bus services otherwise
    // inherit its parent's settings backend. Preferences must share the test
    // keyfile, never the user's normal dconf database.
    const environment = {};
    for (const key of ['GSETTINGS_BACKEND', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'])
        environment[key] = GLib.getenv(key);
    Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'UpdateActivationEnvironment',
        new GLib.Variant('(a{ss})', [environment]), null, Gio.DBusCallFlags.NONE, -1, null);
    // A newly created virtual pointer starts at (0, 0). Do not let that
    // synthetic device enter a hot corner before its first motion is handled.
    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
    if (GLib.getenv('PANTHEA_TEST_START_HIDDEN') !== '1')
        return;
    const path = GLib.build_filenamev([
        GLib.get_user_data_dir(), 'gnome-shell', 'extensions', 'panthea@local', 'schemas',
    ]);
    const source = Gio.SettingsSchemaSource.new_from_directory(path, Gio.SettingsSchemaSource.get_default(), false);
    const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.panthea', false)});
    for (const key of settings.settings_schema.list_keys().filter(key => key.startsWith('show-')))
        settings.set_boolean(key, false);
}

function assert(condition, message) {
    if (!condition)
        throw new Error(`Panthea: ${message}`);
    print(`PASS: ${message}`);
}

async function settle() {
    await Scripting.sleep(300);
    await Scripting.waitLeisure();
}

async function screenshot(name) {
    const directory = GLib.getenv('PANTHEA_TEST_OUTPUT');
    if (!directory)
        return;
    const stream = Gio.File.new_for_path(`${directory}/${name}.png`)
        .replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
}

async function press(keyboard, key) {
    keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
    await settle();
}

async function click(pointer, x, y) {
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    await Scripting.sleep(50);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await settle();
}

async function until(predicate, message) {
    const deadline = GLib.get_monotonic_time() + 3000000;
    while (!predicate() && GLib.get_monotonic_time() < deadline)
        await Scripting.sleep(25);
    assert(predicate(), message);
}

function bounds(actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x, y, width, height};
}

function checkDockPadding(dock) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const node = dock.background.get_theme_node();
    assert([St.Side.TOP, St.Side.BOTTOM].every(side =>
        Math.abs(node.get_padding(side) - 8 * scale) < 1) &&
        [St.Side.LEFT, St.Side.RIGHT].every(side =>
            Math.abs(node.get_padding(side) - 10 * scale) < 1),
    `dock uses 8px vertical and 10px horizontal padding at icon size ${dock.dash.iconSize}, scale ${scale}`);
    assert(node.get_border_radius(0) > 0, 'compact dock retains rounded corners');
}

function checkRunningIndicators(dock) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const background = bounds(dock.background);
    const apps = dock.dash._box.get_children().map(item => item.child)
        .filter(app => app?._dot?.visible);
    assert(apps.length > 0, 'running applications have native indicators');
    for (const app of apps) {
        const dot = bounds(app._dot);
        const icon = bounds(app.icon.icon);
        assert(Math.abs(dot.width - 6 * scale) < 1 && Math.abs(dot.height - 6 * scale) < 1,
            'running indicators are subtle 6px dots');
        assert(Math.abs(dot.x + dot.width / 2 - icon.x - icon.width / 2) <= 0.5 * scale,
            'running indicators are centered beneath their icons');
        assert(Math.abs(dot.y - icon.y - icon.height - 4 * scale) <= 1 &&
            Math.abs(background.y + background.height - dot.y - dot.height - 7 * scale) <= 1,
        `running indicators keep 4px icon and 7px bottom gaps at size ${dock.dash.iconSize}, scale ${scale}`);
    }
}

function checkLauncherAnchor(launcher) {
    const menu = bounds(launcher.menu.actor);
    const button = bounds(launcher);
    const monitor = Main.layoutManager.primaryMonitor;
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    assert(menu.x >= monitor.x - 1 && menu.x + menu.width <= monitor.x + monitor.width + 1 &&
        menu.y + menu.height <= monitor.y + monitor.height + 1,
    'Applications popup remains within its monitor');
    assert(menu.y >= button.y + button.height - 1 &&
        menu.y <= button.y + button.height + 24 * scale,
    'Applications popup opens directly beneath its panel button');
    const expectedX = Math.min(button.x, monitor.x + monitor.width - menu.width);
    assert(Math.abs(menu.x - expectedX) <= 24 * scale,
        'Applications popup follows the button left edge, not its center or the screen center');
}

function checkPageArrows(launcher) {
    const display = launcher._nativeDisplay;
    const indicators = display._pageIndicators;
    assert(indicators.nPages === display._grid.nPages &&
        indicators.get_children().every((indicator, index) => indicator.can_focus &&
            indicator.accessible_name === `Page ${index + 1} of ${indicators.nPages}`),
    'native page dots remain keyboard-accessible and named');
    assert([display._prevPageArrow, display._nextPageArrow].every(arrow =>
        arrow.can_focus && arrow.has_style_class_name('page-navigation-arrow')),
    'popup retains native page navigation controls');
}

function sampleProcess() {
    const [, statBytes] = GLib.file_get_contents('/proc/self/stat');
    const stat = new TextDecoder().decode(statBytes);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const [, statusBytes] = GLib.file_get_contents('/proc/self/status');
    const status = new TextDecoder().decode(statusBytes);
    return {ticks: Number(fields[11]) + Number(fields[12]), rss: Number(status.match(/VmRSS:\s+(\d+)/)[1])};
}

function checkPanelShadows(enabled = true) {
    const labels = [];
    const icons = [];
    function collect(actor) {
        if (actor instanceof St.Label)
            labels.push(actor);
        if (actor instanceof St.Icon)
            icons.push(actor);
        for (const child of actor.get_children())
            collect(child);
    }
    collect(Main.panel);
    assert(labels.length > 0 && icons.length > 0, 'panel shadow checks cover labels and icons');
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    for (const [actors, property] of [[labels, 'text-shadow'], [icons, 'icon-shadow']]) {
        assert(actors.every(actor => {
            const [, shadow] = actor.get_theme_node().lookup_shadow(property, true);
            if (!enabled)
                return shadow === null;
            const foreground = actor.get_theme_node().get_foreground_color();
            if (foreground.red < 100)
                return shadow && shadow.xoffset === 0 && shadow.yoffset === 0 &&
                    shadow.blur === 6 * scale && shadow.spread === 0 && !shadow.inset &&
                    shadow.color.red === 255 && shadow.color.green === 255 && shadow.color.blue === 255 &&
                    Math.abs(shadow.color.alpha / 255 - 0.38) < 0.01;
            return shadow && shadow.xoffset === 0 && shadow.yoffset === scale &&
                shadow.blur === 3 * scale && shadow.spread === 0 && !shadow.inset &&
                shadow.color.red === 0 && shadow.color.green === 0 && shadow.color.blue === 0 &&
                Math.abs(shadow.color.alpha / 255 - 0.65) < 0.01;
        }), `${property} gives dark controls white halos and light controls black shadows with Panel Translucency ${enabled ? 'enabled' : 'disabled'}`);
    }
}

async function checkPanelFeedback(instance, pointer, screenshotName) {
    await Scripting.waitTestWindows();
    const buttons = [Main.panel.statusArea.activities, instance._launcher,
        Main.panel.statusArea.dateMenu, Main.panel.statusArea.quickSettings];
    const warnings = ['screen-recording-indicator', 'screen-sharing-indicator'].map(name => {
        const actor = new St.Widget({style_class: `panel-button ${name}`, visible: false});
        Main.panel._rightBox.add_child(actor);
        return actor;
    });
    const clockButton = Main.panel.statusArea.dateMenu;
    const clock = clockButton._clockDisplay;
    const states = [[], ['hover'], ['focus'], ['active'], ['checked'],
        ['active', 'hover'], ['checked', 'hover'], ['checked', 'focus']];
    const sides = [St.Side.TOP, St.Side.RIGHT, St.Side.BOTTOM, St.Side.LEFT];
    const color = value => [value.red, value.green, value.blue, value.alpha];
    function feedback(actor) {
        const node = actor.get_theme_node();
        const shadow = node.get_box_shadow();
        return {
            background: color(node.get_background_color()),
            shadow: shadow ? [color(shadow.color), shadow.xoffset, shadow.yoffset,
                shadow.blur, shadow.spread, shadow.inset] : null,
            radii: [0, 1, 2, 3].map(corner => node.get_border_radius(corner)),
            borders: sides.map(side => [node.get_border_width(side), color(node.get_border_color(side))]),
            outline: node.get_outline_width(),
            outlineColor: color(node.get_outline_color()),
            duration: node.get_transition_duration(),
        };
    }
    function snapshot() {
        return states.map(state => {
            for (const button of [...buttons, ...warnings]) {
                for (const pseudo of state)
                    button.add_style_pseudo_class(pseudo);
            }
            // GNOME places the clock's only highlight on its inner label.
            const result = [...buttons, clock, ...warnings].map(feedback);
            assert(result[2].shadow === null && result[2].background[3] === 0,
                `clock has no duplicate outer background in ${state.join('+') || 'rest'} state`);
            for (const item of [result[0], result[1], result[3], result[4]]) {
                assert(item.radii.every(radius => radius > 0), 'panel highlights retain native rounded corners');
                if (state.length > 0)
                    assert(item.shadow?.[0][3] > 0, 'panel hover, focus and pressed highlights remain visible');
            }
            for (const button of [...buttons, ...warnings]) {
                for (const pseudo of state)
                    button.remove_style_pseudo_class(pseudo);
            }
            return result;
        });
    }
    const originalFocus = global.stage.key_focus;
    global.stage.set_key_focus(null);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), 400, 300);
    await settle();
    try {
        instance._settings.set_boolean('automatic-translucency', false);
        await settle();
        const native = snapshot();
        Main.panel.add_style_pseudo_class('overview');
        const nativeOverview = snapshot();
        Main.panel.remove_style_pseudo_class('overview');
        instance._settings.set_boolean('automatic-translucency', true);
        await until(() => instance._appearance._wallpaper.ready, 'wallpaper analysis resumes for panel feedback checks');
        await settle();
        if (Main.panel.has_style_class_name('panthea-dark-text')) {
            for (const state of native) {
                for (const index of [0, 1, 3, 4]) {
                    const shadow = state[index].shadow;
                    if (shadow?.[0][3] > 0)
                        shadow[0].splice(0, 3, 34, 34, 38);
                }
            }
        }
        assert(JSON.stringify(snapshot()) === JSON.stringify(native),
            'panel feedback follows foreground contrast and retains native geometry, timing and warning colors');
        Main.panel.add_style_pseudo_class('overview');
        assert(JSON.stringify(snapshot()) === JSON.stringify(nativeOverview),
            'Overview retains native light hover, focus and pressed feedback, including warning pills');
        Main.panel.remove_style_pseudo_class('overview');
        for (const button of buttons)
            button.add_style_pseudo_class('hover');
        await settle();
        await screenshot(`panel-hover-${screenshotName}`);
        for (const button of buttons)
            button.remove_style_pseudo_class('hover');
        for (const button of buttons) {
            button.grab_key_focus();
            await settle();
            assert(global.stage.key_focus === button && button.has_style_pseudo_class('focus'),
                'panel buttons retain real keyboard focus');
            const target = button === clockButton ? clock : button;
            assert(target.get_theme_node().get_box_shadow()?.color.alpha > 0,
                'keyboard focus has a visible native pill highlight');
        }
        await screenshot(`panel-focus-${screenshotName}`);
    } finally {
        if (!instance._appearance)
            instance._settings.set_boolean('automatic-translucency', true);
        for (const button of buttons) {
            for (const pseudo of ['hover', 'focus', 'active', 'checked'])
                button.remove_style_pseudo_class(pseudo);
        }
        global.stage.set_key_focus(originalFocus);
        for (const warning of warnings)
            warning.destroy();
        await settle();
    }
    await Scripting.waitTestWindows();
}

async function checkOverviewPanel(appearance) {
    const style = Main.panel.get_style();
    const classes = Main.panel.get_style_class_name();
    const node = Main.panel.get_theme_node();
    const alpha = node.get_background_color().alpha;
    const duration = node.get_transition_duration();
    Main.overview.show();
    await settle();
    assert(Main.panel.has_style_pseudo_class('overview') &&
        Main.panel.get_theme_node().get_background_color().alpha === 0,
    'native Overview styling makes the panel fully transparent');
    const dockColor = appearance._dock.background.get_theme_node().get_background_color().to_string();
    assert(!Main.layoutManager.panelBox.get_effect('panthea-panel-blur'), 'Overview has no panel backdrop blur');
    checkPanelShadows();
    appearance._update();
    assert(Main.panel.get_style() === style && Main.panel.get_style_class_name() === classes,
        'Overview and theme color reads leave panel styles installed and unchanged');
    assert(Main.panel.get_theme_node().get_transition_duration() === duration,
        'Overview retains the native panel transition duration');
    Main.overview.hide();
    await settle();
    assert(Main.panel.get_theme_node().get_background_color().alpha === alpha &&
        Main.panel.get_style() === style && Main.panel.get_style_class_name() === classes,
    'leaving Overview restores the desktop panel without reapplying styles');
    assert(appearance._dock.background.get_theme_node().get_background_color().to_string() === dockColor,
        'Overview leaves the dock background unchanged');
}

async function checkWallpaperWindowOverride(instance, name) {
    const panelColor = () => Main.panel.get_theme_node().get_background_color();
    const background = panelColor().to_string();
    const foreground = Main.panel.get_theme_node().get_foreground_color().to_string();
    const dockBackground = instance._dock.background.get_theme_node().get_background_color().to_string();
    const expected = panelColor().alpha === 0 ? dockBackground : background;
    assert(panelColor().alpha === 0 || background === dockBackground,
        `${name}: visible panel and dock backgrounds have identical color and opacity`);
    await Scripting.createTestWindow({maximized: true});
    await Scripting.waitTestWindows();
    const window = global.get_window_actors().map(actor => actor.meta_window)
        .find(candidate => candidate.maximized_vertically && candidate.maximized_horizontally);
    try {
        await settle();
        assert(panelColor().to_string() === expected,
            `${name}: maximization overrides only a transparent wallpaper background`);
        assert(panelColor().alpha === 0 || Main.panel.get_theme_node().get_foreground_color().red ===
            (instance._appearance._wallpaper.state === 'translucent' && !instance._appearance._wallpaper.dark ? 51 : 255),
        `${name}: qualifying windows retain the correct foreground contrast`);
        await screenshot(`wallpaper-${name}-maximized`);
        window.unmaximize();
        await settle();
        window.set_maximize_flags(Meta.MaximizeFlags.VERTICAL);
        await settle();
        assert(window.maximized_vertically && !window.maximized_horizontally &&
            panelColor().to_string() === expected,
        `${name}: vertical-only maximization keeps the same panel treatment`);
        window.unmaximize();
        await settle();
        window.set_maximize_flags(Meta.MaximizeFlags.HORIZONTAL);
        await settle();
        assert(!window.maximized_vertically && window.maximized_horizontally &&
            panelColor().to_string() === expected,
        `${name}: horizontal-only maximization keeps the same panel treatment`);
        assert(instance._dock.background.get_theme_node().get_background_color().to_string() === dockBackground,
            `${name}: partial maximization leaves the dock background unchanged`);
        window.unmaximize(Meta.MaximizeFlags.BOTH);
        await settle();
        assert(panelColor().to_string() === background &&
            Main.panel.get_theme_node().get_foreground_color().to_string() === foreground,
        `${name}: unmaximizing restores the wallpaper background and foreground`);
        window.make_fullscreen();
        await settle();
        assert(panelColor().to_string() === expected && !Main.layoutManager.panelBox.visible &&
            !instance._dock.actor.visible,
        `${name}: fullscreen preserves the selected background and native hidden surfaces`);
        window.unmake_fullscreen();
        await settle();
        assert(panelColor().to_string() === background &&
            Main.panel.get_theme_node().get_foreground_color().to_string() === foreground &&
            instance._dock.background.get_theme_node().get_background_color().to_string() === dockBackground,
        `${name}: leaving fullscreen restores wallpaper styling without changing the dock`);
    } finally {
        await Scripting.destroyTestWindows();
        await settle();
    }
}

export async function run() {
    await settle();
    const extension = Main.extensionManager.lookup('panthea@local');
    assert(extension?.state === ExtensionState.ACTIVE,
        `extension enabled (${extension?.state}, ${extension?.error ?? ''})`);
    let instance = extension.stateObj;
    const settings = instance._settings;
    const {visibilityTargets} = await import(extension.dir.get_child('lib').get_child('shellTargets.js').get_uri());
    if (GLib.getenv('PANTHEA_TEST_START_HIDDEN') === '1') {
        assert(visibilityTargets(Main.panel).every(([, actor]) =>
            actor.get_parent().name === 'panthea-hidden' && !actor.get_parent().visible),
        'saved hidden settings apply during asynchronous Shell startup');
        for (const key of settings.settings_schema.list_keys().filter(key => key.startsWith('show-')))
            settings.set_boolean(key, true);
        await settle();
        const children = Main.panel._leftBox.get_children();
        assert(children.indexOf(instance._launcher.container) ===
            children.indexOf(Main.panel.statusArea.activities.container) + 1,
        'Applications remains after Activities when startup visibility is restored');
    }
    assert(instance._dock.actor.visible, 'dock is visible');
    assert(!Main.overview.dash.visible, 'original Overview dash is hidden');
    const dockHeight = instance._dock.actor.height;
    const monitor = Main.layoutManager.primaryMonitor;
    assert(instance._dock.actor.y + dockHeight === monitor.y + monitor.height, 'dock touches the primary monitor bottom');
    assert(Main.layoutManager.getWorkAreaForMonitor(monitor.index).height < monitor.height, 'dock reserves workspace space');
    instance._dock.dash._onItemDragBegin();
    instance._dock.dash._onItemDragEnd();
    assert(instance._dock.dash._dragMonitor === null, 'completed favorite drags release the dock drag monitor');

    Main.overview.hide();
    await settle();
    const launcher = instance._launcher;
    const keyboard = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const pointer = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), monitor.width / 2, monitor.height / 2);
    await settle();
    const started = GLib.get_monotonic_time();
    launcher.menu.open();
    await settle();
    print(`MEASURE: first menu open and settle ${(GLib.get_monotonic_time() - started) / 1000} ms (includes 300 ms settle)`);
    assert(launcher.menu.isOpen, 'Applications opens');
    checkLauncherAnchor(launcher);
    assert(launcher.catalog.ready, 'application catalog is ready');
    const display = launcher._nativeDisplay;
    const gridItems = () => display._grid.getItemsAtPage(display._grid.currentPage);
    assert(gridItems().length > 0, 'native first page has applications');
    assert(!launcher._count, 'Applications has no count label');
    assert(display._pageIndicators.nPages === display._grid.nPages,
        'native dots show the actual page count');
    const search = bounds(launcher._search);
    assert(search.y + search.height <= bounds(display).y, 'search sits above the native grid');
    assert(!launcher._viewButtons && !launcher._categoryButtons, 'obsolete view and category controls are removed');
    assert(!launcher._results.visible && display.visible, 'unfiltered grid uses native AppDisplay');
    checkPageArrows(launcher);
    assert(!display._prevPageArrow.visible && display._nextPageArrow.visible,
        'native grid initially shows only Next');
    display._nextPageArrow.grab_key_focus();
    await press(keyboard, Clutter.KEY_space);
    assert(display._grid.currentPage === 1, 'native Next supports keyboard activation');
    display._pageIndicators.get_children()[0].grab_key_focus();
    await press(keyboard, Clutter.KEY_space);
    assert(display._grid.currentPage === 0, 'native dots support keyboard activation');
    await screenshot('applications-grid');
    launcher.menu.close();
    await settle();
    launcher.menu.open();
    await settle();

    await press(keyboard, Clutter.KEY_Down);
    assert(global.stage.key_focus === gridItems()[0], 'Down moves from search to native applications');
    await press(keyboard, Clutter.KEY_Right);
    assert(global.stage.key_focus === gridItems()[1], 'Right moves between native applications');
    await press(keyboard, Clutter.KEY_Page_Down);
    assert(display._grid.currentPage === 1, 'Page Down changes native application pages');
    await press(keyboard, Clutter.KEY_Page_Up);
    assert(display._grid.currentPage === 0, 'Page Up restores the first native page');
    const appIcon = gridItems().find(item => item.app);
    appIcon.popupMenu();
    await settle();
    assert(appIcon._menu.isOpen, 'native application context menu opens');
    await screenshot('application-context-menu');
    appIcon._menu.close();
    launcher._search.grab_key_focus();

    const unfilteredHeight = launcher._root.height;
    const unfilteredWidth = launcher._root.width;
    const browsingIconTop = bounds(gridItems()[0].icon.icon).y;
    const unfilteredBackground = launcher.menu.box.get_theme_node().get_background_color();
    assert(!launcher.menu.box.get_style(), 'browsing applications uses the native popup background');
    const searchBounds = bounds(launcher._search);
    const firstName = launcher.catalog.entries[0].info.get_name();
    launcher._search.set_text(firstName);
    await settle();
    assert(launcher._visibleButtons.length > 0 && !display.visible,
        'search uses a separate native results grid');
    const sparseHeight = launcher._visibleButtons[0].height;
    assert(launcher._visibleButtons.every(button => Math.abs(button.height - sparseHeight) < 1),
        'search tiles keep their native height');
    const checkSearchCenter = () => {
        const tiles = launcher._visibleButtons.map(bounds);
        const root = bounds(launcher._root);
        assert(Math.abs((tiles[0].x + tiles.at(-1).x + tiles.at(-1).width) / 2 -
            root.x - root.width / 2) <= 1, 'search results are horizontally centered');
    };
    checkSearchCenter();
    assert(Math.abs(launcher._root.height - unfilteredHeight) <= 1,
        'sparse search preserves the popup height');
    assert(['x', 'y', 'width', 'height'].every(key => Math.abs(bounds(launcher._search)[key] - searchBounds[key]) <= 1),
        'search keeps its original size and position');
    assert(launcher._search.get_secondary_icon()?.icon_name === 'edit-clear-symbolic',
        'populated search has the native clear icon');
    const tile = launcher._visibleButtons[0];
    const iconSizeGap = (tile.icon.iconSize - gridItems()[0].icon.iconSize) / 2 *
        St.ThemeContext.get_for_stage(global.stage).scale_factor;
    assert(Math.abs(bounds(tile.icon.icon).y - iconSizeGap - browsingIconTop) <= 1,
        'search keeps its original gap with independently sized browsing icons');
    assert(launcher._search.contains(global.stage.key_focus) && tile.has_style_pseudo_class('selected'),
        'the top result is selected automatically while typing in search');
    const selectionColor = tile.get_theme_node().get_background_color();
    const popupColor = launcher.menu.box.get_theme_node().get_background_color();
    assert(popupColor.equal(unfilteredBackground), 'search keeps the browsing background');
    assert(selectionColor.alpha > 0 && selectionColor.alpha < 255 && !selectionColor.equal(popupColor),
        'the default selection uses a translucent highlight over the popup background');
    assert(bounds(tile.icon.icon).y + bounds(tile.icon.icon).height <= bounds(tile.icon.label).y,
        'native application icons sit above their labels');

    // Compare with an unmodified native application-search section at the same
    // width, outside Panthea's popup and its scoped CSS.
    const provider = new AppSearchProvider();
    const reference = new GridSearchResults(provider, null);
    reference.width = launcher._root.width;
    Main.uiGroup.add_child(reference);
    try {
        await reference.updateSearch(launcher._matches.map(entry => entry.id), firstName.split(/\s+/));
        await settle();
        const nativeTile = reference.getFirstResult();
        const tileNode = tile.get_theme_node();
        assert([St.Side.TOP, St.Side.RIGHT, St.Side.BOTTOM, St.Side.LEFT].every(side =>
            tileNode.get_padding(side) === nativeTile.get_theme_node().get_padding(side)),
        'search buttons retain comfortable native padding around icons and labels');
        assert(tile.icon.iconSize === (48 + nativeTile.icon.iconSize) / 2 &&
            tile.width < nativeTile.width && tile.height < nativeTile.height &&
            launcher._results._grid.layout_manager.spacing === reference._grid.layout_manager.spacing,
        'search uses midpoint icon sizing and retains native row spacing');
        tile.remove_style_pseudo_class('selected');
        for (const state of ['hover', 'focus', 'selected']) {
            tile.add_style_pseudo_class(state);
            nativeTile.add_style_pseudo_class(state);
            const highlight = tile.get_theme_node().get_background_color();
            assert(highlight.equal(selectionColor) &&
                tile.get_theme_node().get_border_radius(0) === nativeTile.get_theme_node().get_border_radius(0),
            `search ${state} uses a popup highlight and native corners`);
            tile.remove_style_pseudo_class(state);
            nativeTile.remove_style_pseudo_class(state);
        }
    } finally {
        reference.clear();
        reference.destroy();
    }
    launcher._results.highlightDefault();
    checkLauncherAnchor(launcher);
    await screenshot('applications-grid-sparse');

    const searchEntry = launcher.catalog.entries[0];
    const term = searchEntry.info.get_name().split(/\s+/)[0];
    for (let length = 1; length <= Math.min(term.length, 5); length++)
        launcher._search.set_text(term.slice(0, length));
    launcher._search.set_text(term);
    await settle();
    assert(launcher._matches.some(entry => entry.id === searchEntry.id), 'rapid search uses the latest query and native application matches');
    const prefixes = [...new Set(launcher.catalog.entries.flatMap(entry =>
        entry.name.split(/\s+/).flatMap(word => Array.from({length: Math.min(word.length, 6)},
            (_value, index) => word.slice(0, index + 1)))))];
    const pairQuery = prefixes.find(query => launcher.catalog.search(query).length === 2);
    assert(pairQuery, 'installed applications provide a two-result query');
    launcher._search.set_text(pairQuery);
    await settle();
    assert(launcher._visibleButtons.length === 2, 'two-result search displays both matches');
    assert(launcher._visibleButtons[0].has_style_pseudo_class('selected') &&
        !launcher._visibleButtons[1].has_style_pseudo_class('selected'),
    'only the top result has the default selection highlight');
    checkSearchCenter();
    await screenshot('applications-search-pair');

    launcher._search.set_text('panthea-impossible-search-928174');
    await settle();
    assert(launcher._matches.length === 0 && launcher._empty.visible, 'empty search state');
    assert(!display.visible, 'empty search hides the native grid and pagination');
    await screenshot('applications-empty');
    assert(Math.abs(launcher._root.height - unfilteredHeight) <= 1 &&
        Math.abs(launcher._root.width - unfilteredWidth) <= 1,
    'no-results state preserves the popup size');
    // Broad queries keep only the highest-ranked applications that fit one row.
    launcher._search.set_text('a');
    await settle();
    const ranked = (await provider.getInitialResultSet(['a'], null)).filter(id => id.endsWith('.desktop'));
    assert(launcher._visibleButtons.length > 1 && launcher._visibleButtons.length <= 6 &&
        launcher._visibleButtons.map(icon => icon.id).join(',') === ranked.slice(0, launcher._visibleButtons.length).join(','),
    'search shows the highest-ranked native application matches, up to six');
    checkSearchCenter();
    assert(launcher._visibleButtons.every(icon => icon.y === launcher._visibleButtons[0].y),
        'broad search stays in a single row');
    assert(Math.abs(launcher._root.height - unfilteredHeight) <= 1 &&
        Math.abs(launcher._root.width - unfilteredWidth) <= 1,
    'broad search preserves the popup size');
    const cachedFirst = launcher._visibleButtons[0];
    launcher._queueRender();
    await settle();
    assert(launcher._visibleButtons[0] === cachedFirst, 'unchanged search reuses its result actors');
    launcher._search.grab_key_focus();
    await press(keyboard, Clutter.KEY_Down);
    assert(global.stage.key_focus === launcher._visibleButtons[0], 'Down enters the search row');
    await press(keyboard, Clutter.KEY_Right);
    assert(global.stage.key_focus === launcher._visibleButtons[1], 'Right moves across the search row');
    await press(keyboard, Clutter.KEY_Left);
    assert(global.stage.key_focus === launcher._visibleButtons[0], 'Left moves back across the search row');
    await press(keyboard, Clutter.KEY_End);
    assert(global.stage.key_focus === launcher._visibleButtons.at(-1), 'End focuses the last search result');
    await press(keyboard, Clutter.KEY_Home);
    assert(global.stage.key_focus === launcher._visibleButtons[0], 'Home focuses the first search result');
    await press(keyboard, Clutter.KEY_Up);
    assert(launcher._search.contains(global.stage.key_focus), 'Up returns to the search field');
    launcher._search.emit('secondary-icon-clicked');
    await settle();
    assert(display.visible && !launcher._search.get_text() && !launcher._search.get_secondary_icon(),
        'clear button restores the normal grid and removes itself');
    assert(launcher.menu.box.get_theme_node().get_background_color().equal(unfilteredBackground),
        'clearing search keeps the same popup background');
    launcher._search.set_text(term);
    await settle();
    assert(launcher._matches.some(entry => entry.id === searchEntry.id) &&
        launcher._visibleButtons.length <= 6,
    'search uses native matches and the Overview result limit');
    assert(Math.abs(launcher._visibleButtons[0].height - sparseHeight) < 1,
        'search tiles keep the same height for broad and sparse queries');
    launcher._visibleButtons[0].popupMenu();
    await settle();
    assert(launcher._visibleButtons[0]._menu.isOpen, 'search results use native application menus');
    launcher._visibleButtons[0]._menu.close();
    launcher._visibleButtons[0].grab_key_focus();
    await press(keyboard, Clutter.KEY_Menu);
    assert(launcher._visibleButtons[0]._menu.isOpen, 'Menu key opens the native search context menu');
    await press(keyboard, Clutter.KEY_Escape);
    const resultBounds = bounds(launcher._visibleButtons[0]);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(),
        resultBounds.x + resultBounds.width / 2, resultBounds.y + resultBounds.height / 2);
    await settle();
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.PRESSED);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.RELEASED);
    await settle();
    assert(launcher._visibleButtons[0]._menu.isOpen, 'right-click opens the native search context menu');
    launcher._visibleButtons[0]._menu.close();
    launcher._search.grab_key_focus();
    await press(keyboard, Clutter.KEY_Escape);
    assert(launcher.menu.isOpen && display.visible && !launcher._search.get_text(),
        'Escape clears search and restores the native grid');
    launcher._search.set_text(term);
    await settle();
    await press(keyboard, Clutter.KEY_Down);
    await press(keyboard, Clutter.KEY_Escape);
    assert(launcher.menu.isOpen && !launcher._search.get_text() &&
        launcher._search.contains(global.stage.key_focus),
    'Escape from a search result clears search and returns focus to the entry');
    for (const query of ['panthea-impossible-search-928174', '   ']) {
        launcher._search.set_text(query);
        await settle();
        await press(keyboard, Clutter.KEY_Escape);
        assert(launcher.menu.isOpen && display.visible && !launcher._search.get_text(),
            `Escape clears ${query.trim() ? 'an unmatched' : 'a whitespace-only'} search without closing`);
    }
    await press(keyboard, Clutter.KEY_Escape);
    assert(!launcher.menu.isOpen, 'Escape closes the unfiltered menu');
    // Intercept only the test application's launch to exercise Enter without
    // starting an installed application or contacting the user's desktop apps.
    launcher.menu.open();
    await settle();
    launcher._search.set_text(term);
    await settle();
    const resultApp = launcher._visibleButtons[0].app;
    const activate = resultApp.activate;
    let activated = false;
    resultApp.activate = () => { activated = true; };
    try {
        await press(keyboard, Clutter.KEY_Return);
        assert(activated && !launcher.menu.isOpen, 'Enter launches the first search result and closes the popup');
    } finally {
        resultApp.activate = activate;
    }
    await settle();

    for (let repeat = 0; repeat < 3; repeat++) {
        const before = GLib.get_monotonic_time();
        launcher.menu.open();
        print(`MEASURE: retained menu open call ${(GLib.get_monotonic_time() - before) / 1000} ms`);
        await settle();
        checkLauncherAnchor(launcher);
        launcher.menu.close();
        await settle();
    }

    await Scripting.waitTestWindows();
    for (const key of settings.settings_schema.list_keys().filter(key => key.startsWith('show-'))) {
        const targets = visibilityTargets(Main.panel).filter(([targetKey]) => key === targetKey);
        settings.set_boolean(key, false);
        await settle();
        assert(targets.every(([, actor]) => actor.get_parent().name === 'panthea-hidden' && !actor.get_parent().visible),
            `${key} hides only its selected actors (${targets.length} available)`);
        settings.set_boolean(key, true);
        await settle();
    }
    assert(instance._visibility._hidden.size === 0, 'all visibility controls restore their actors');
    const powerIndicator = Main.panel.statusArea.quickSettings._powerProfiles;
    const powerVisible = powerIndicator.visible;
    settings.set_boolean('show-qs-power-mode', false);
    await settle();
    assert(powerIndicator.visible === powerVisible, 'hiding Power Mode tile preserves the panel indicator');
    settings.set_boolean('show-qs-power-mode', true);
    const darkTile = Main.panel.statusArea.quickSettings._darkMode.quickSettingsItems[0];
    settings.set_boolean('show-qs-dark-style', false);
    darkTile.visible = false;
    settings.set_boolean('show-qs-dark-style', true);
    assert(!darkTile.visible, 'restoring a control preserves native availability changes');
    darkTile.visible = true;
    Main.panel.statusArea.quickSettings.menu.open();
    await settle();
    assert(Main.panel.statusArea.quickSettings.menu.isOpen, 'native Quick Settings still opens');
    await screenshot('quick-settings');
    const tileKeys = settings.settings_schema.list_keys().filter(key => key.startsWith('show-qs-'));
    for (const key of tileKeys)
        settings.set_boolean(key, false);
    await settle();
    await screenshot('quick-settings-hidden-tiles');
    assert(Main.panel.statusArea.quickSettings.menu.isOpen, 'Quick Settings remains open while its tiles are hidden live');
    for (const key of tileKeys)
        settings.set_boolean(key, true);
    Main.panel.closeQuickSettings();

    const dash = instance._dock.dash;
    const showAppsButton = dash.showAppsButton;
    assert(settings.get_default_value('show-apps-button').get_boolean() && showAppsButton.visible,
        'Show Apps Button is enabled by default');
    const shownWidth = dash.width;
    settings.set_boolean('show-apps-button', false);
    await settle();
    assert(!showAppsButton.visible && !dash._showAppsIcon.visible && dash.width < shownWidth,
        'hiding Show Apps reclaims its dock width');
    await screenshot('dock-show-apps-hidden');
    const originalMaxWidth = dash._maxWidth;
    dash._maxWidth = 230;
    dash._adjustIconSize();
    const hiddenSize = dash.iconSize;
    dash._showAppsIcon.visible = true;
    dash._adjustIconSize();
    assert(dash.iconSize <= hiddenSize, 'hidden Show Apps is excluded from constrained icon sizing');
    dash._showAppsIcon.visible = false;
    dash._maxWidth = originalMaxWidth;
    for (const size of [0, 2, 1]) {
        settings.set_int('dock-icon-size', size);
        await settle();
        assert(instance._dock.dash.iconSize <= [32, 48, 64][size], `dock size ${size} is applied`);
        checkDockPadding(instance._dock);
        const hiddenHeight = instance._dock.actor.height;
        settings.set_boolean('show-apps-button', true);
        await settle();
        assert(dash.showAppsButton === showAppsButton && showAppsButton.visible,
            'showing Show Apps reuses the native button');
        assert(Math.abs(instance._dock.actor.height - hiddenHeight) < 1,
            `dock height stays correct with Show Apps hidden at size ${size}`);
        checkDockPadding(instance._dock);
        settings.set_boolean('show-apps-button', false);
        await settle();
    }
    // Remove only the test dock's actors temporarily to cover zero visible
    // icons without altering global favorites or running applications.
    const dockItems = dash._box.get_children();
    for (const item of dockItems)
        dash._box.remove_child(item);
    dash._adjustIconSize();
    assert(Number.isFinite(dash.iconSize), 'empty dock sizing remains valid with Show Apps hidden');
    for (const item of dockItems)
        dash._box.add_child(item);
    settings.set_boolean('show-apps-button', true);
    await settle();
    const panelStyle = Main.panel.get_style();
    const dockStyle = instance._dock.background.get_style();
    settings.set_boolean('automatic-translucency', false);
    await settle();
    assert(!instance._appearance, 'automatic translucency can be disabled live');
    checkPanelShadows(false);
    assert(Main.panel.get_style() === panelStyle && instance._dock.background.get_style() === dockStyle,
        'disabling translucency restores the original panel and dock styles');
    assert(!Main.panel.has_style_class_name('panthea-panel') &&
        !instance._dock.background.has_style_class_name('panthea-surface') &&
        !instance._dock.background.has_style_class_name('panthea-surface-light') &&
        !instance._dock.dash.has_style_class_name('panthea-dark-dock') &&
        !instance._dock.dash.has_style_class_name('panthea-light-dock'),
    'disabling translucency removes all surface and foreground overrides');
    settings.set_boolean('automatic-translucency', true);
    await settle();
    assert(instance._appearance, 'automatic translucency can be enabled live');
    await until(() => instance._appearance._wallpaper.ready, 'wallpaper analysis finishes');
    assert(instance._appearance.panelState === instance._appearance._wallpaper.state,
        'unmaximized panel uses the wallpaper-selected appearance');
    const normalDockAlpha = instance._dock.background.get_theme_node().get_background_color().alpha;
    const lightDock = instance._appearance._wallpaper.state === 'translucent' &&
        !instance._appearance._wallpaper.dark;
    assert(Math.abs(normalDockAlpha / 255 - (lightDock ? 0.5 : 0.4)) < 0.01,
        'dock uses wallpaper-selected translucency or the dark fallback');

    // Reset the native window helper's idle timeout before the wallpaper checks.
    await Scripting.waitTestWindows();
    const backgroundSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const savedBackground = new Map(['picture-uri', 'picture-uri-dark', 'picture-options'].map(key =>
        [key, backgroundSettings.get_value(key)]));
    const interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const savedColorScheme = interfaceSettings.get_value('color-scheme');
    const fixtures = [];
    try {
        backgroundSettings.set_string('picture-options', 'zoom');
        interfaceSettings.set_string('color-scheme', 'prefer-dark');
        for (const [name, fill, expected] of [
            ['dark', '<rect width="1024" height="768" fill="#182028"/>', 'transparent-light'],
            ['light', '<rect width="1024" height="768" fill="#eeeeee"/>', 'transparent-dark'],
            ['busy', '<defs><pattern id="p" width="32" height="32" patternUnits="userSpaceOnUse">' +
                '<rect width="32" height="32" fill="white"/><rect width="16" height="32" fill="black"/>' +
                '</pattern></defs><rect width="1024" height="768" fill="url(#p)"/>', 'translucent'],
        ]) {
            const path = `${GLib.getenv('PANTHEA_TEST_OUTPUT')}/wallpaper-${name}.svg`;
            GLib.file_set_contents(path, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768">${fill}</svg>`);
            const file = Gio.File.new_for_path(path);
            fixtures.push(file);
            for (const key of ['picture-uri', 'picture-uri-dark'])
                backgroundSettings.set_string(key, file.get_uri());
            await settle();
            await until(() => instance._appearance._wallpaper.ready && instance._appearance._wallpaper.state === expected,
                `${name} wallpaper selects ${expected}`);
            await settle();
            const alpha = Main.panel.get_theme_node().get_background_color().alpha;
            assert(expected === 'translucent' ? Math.abs(alpha / 255 - 0.4) < 0.01 : alpha === 0,
                `${name} wallpaper selects the default panel background`);
            const foreground = launcher.get_theme_node().get_foreground_color();
            assert(name !== 'light' || foreground.red < 100, 'light wallpaper gives panel controls dark text');
            assert(!Main.layoutManager.panelBox.get_effect('panthea-panel-blur') &&
                Math.abs(instance._dock.background.get_theme_node().get_background_color().alpha / 255 - 0.4) < 0.01,
            `${name} wallpaper keeps blur disabled and selects the dark dock background`);
            await screenshot(`wallpaper-${name}`);
            checkPanelShadows();
            await checkOverviewPanel(instance._appearance);
            await checkPanelFeedback(instance, pointer, name);
            await checkWallpaperWindowOverride(instance, name);
            if (name === 'busy') {
                interfaceSettings.set_string('color-scheme', 'prefer-light');
                await settle();
                await until(() => instance._appearance._wallpaper.ready,
                    'busy wallpaper finishes analysis in light appearance');
                const lightBackground = Main.panel.get_theme_node().get_background_color();
                assert(lightBackground.red === 255 && Math.abs(lightBackground.alpha / 255 - 0.5) < 0.01,
                    'busy wallpaper selects the original light translucent panel in light appearance');
                await checkWallpaperWindowOverride(instance, 'busy-light');
                await checkOverviewPanel(instance._appearance);
                interfaceSettings.set_string('color-scheme', 'prefer-dark');
                await settle();
            }
        }
        for (const key of ['picture-uri', 'picture-uri-dark'])
            backgroundSettings.set_string(key, 'file:///nonexistent/panthea-wallpaper.png');
        await settle();
        await until(() => instance._appearance._wallpaper.ready && instance._appearance._wallpaper.state === 'translucent',
            'unreadable wallpaper uses the foreground contrast fallback');
        await settle();
        const fallback = Main.panel.get_theme_node().get_background_color();
        assert(fallback.red === 0 && fallback.green === 0 && fallback.blue === 0 &&
            Math.abs(fallback.alpha / 255 - 0.4) < 0.01 &&
            fallback.equal(instance._dock.background.get_theme_node().get_background_color()),
        'unreadable wallpaper gives panel and dock the same black background at 40% opacity');
    } finally {
        for (const [key, value] of savedBackground)
            backgroundSettings.set_value(key, value);
        interfaceSettings.set_value('color-scheme', savedColorScheme);
        await settle();
        for (const file of fixtures)
            file.delete(null);
    }

    for (const scheme of ['default', 'prefer-light', 'prefer-dark']) {
        interfaceSettings.set_string('color-scheme', scheme);
        await settle();
        launcher.menu.open();
        await settle();
        assert(launcher.menu.isOpen && display.visible && gridItems().length > 0, `launcher survives ${scheme}`);
        checkLauncherAnchor(launcher);
        checkPageArrows(launcher);
        assert(Main.panel.get_theme_node().get_background_color().alpha < 255, `${scheme} retains translucency`);
        await screenshot(`applications-${scheme}`);
        const browsingBackground = launcher.menu.box.get_theme_node().get_background_color();
        launcher._search.set_text(term);
        await settle();
        assert(launcher._visibleButtons[0].has_style_pseudo_class('selected') &&
            launcher.menu.box.get_theme_node().get_background_color().equal(
                browsingBackground) && !launcher.menu.box.get_style(),
        `${scheme} keeps the native popup background and default result highlight`);
        launcher.menu.close();
        await settle();
        await checkPanelFeedback(instance, pointer, scheme);
    }
    interfaceSettings.set_double('text-scaling-factor', 1.25);
    await settle();
    launcher.menu.open();
    await settle();
    assert(display.height < monitor.height, 'larger text keeps the native grid within the display');
    checkLauncherAnchor(launcher);
    await screenshot('applications-large-text');
    checkPageArrows(launcher);
    checkLauncherAnchor(launcher);
    launcher.menu.close();
    interfaceSettings.reset('text-scaling-factor');
    const themeContext = St.ThemeContext.get_for_stage(global.stage);
    const originalScale = themeContext.scale_factor;
    themeContext.scale_factor = 2;
    await settle();
    launcher.menu.open();
    await settle();
    assert(themeContext.scale_factor === 2, 'launcher sizing is tested at 2× display scale');
    checkDockPadding(instance._dock);
    checkPageArrows(launcher);
    checkLauncherAnchor(launcher);
    launcher._search.set_text('terminal');
    await settle();
    checkLauncherAnchor(launcher);
    assert(!display.visible && launcher._visibleButtons.length > 0 && launcher._visibleButtons.length <= 6,
        'scaled search retains the native row limit');
    checkSearchCenter();
    launcher.menu.close();
    themeContext.scale_factor = originalScale;
    await settle();

    const originalFavorites = global.settings.get_strv('favorite-apps');
    const candidate = launcher.catalog.entries.find(entry => !originalFavorites.includes(entry.id));
    AppFavorites.getAppFavorites().addFavorite(candidate.id);
    await settle();
    assert(instance._dock.dash._box.get_children().some(item => item.child?.app?.get_id() === candidate.id),
        'GNOME favorite changes update the dock');
    global.settings.set_strv('favorite-apps', originalFavorites);
    await settle();
    for (const source of Main.messageTray.getSources()) {
        for (const notification of [...source.notifications])
            notification.destroy();
    }
    instance._dock.dash.showAppsButton.emit('clicked', Clutter.BUTTON_PRIMARY);
    await settle();
    assert(Main.overview.visible && Main.overview.dash.showAppsButton.checked, 'dock Show Apps opens the native Overview application grid');
    const nativeGrid = Main.overview._overview.controls._appDisplay;
    await until(() => nativeGrid.get_transformed_position()[1] + nativeGrid.get_transformed_size()[1] <= instance._dock.actor.y,
        'Overview application grid is allocated above the permanent dock');
    await screenshot('overview');
    Main.overview.hide();
    await settle();

    const desktopPanelColor = Main.panel.get_theme_node().get_background_color().to_string();
    const desktopPanelAlpha = Main.panel.get_theme_node().get_background_color().alpha;
    const desktopDockAlpha = instance._dock.background.get_theme_node().get_background_color().alpha;
    await Scripting.createTestWindow({maximized: true});
    await Scripting.createTestWindow({width: 400, height: 300});
    await Scripting.waitTestWindows();
    await settle();
    const windows = global.get_window_actors().map(actor => actor.meta_window)
        .filter(window => /perf-?helper/i.test(window.get_wm_class() ?? ''));
    for (const window of global.get_window_actors().map(actor => actor.meta_window))
        print(`TEST WINDOW: ${window.get_wm_class()} / ${window.get_title()}`);
    assert(windows.length === 2, 'two native test windows are tracked');
    const maximized = windows.find(window => window.maximized_vertically);
    assert(maximized, 'native window maximization works');
    for (const size of [0, 2, 1]) {
        settings.set_int('dock-icon-size', size);
        await settle();
        checkRunningIndicators(instance._dock);
        await screenshot(`dock-running-indicators-${size}`);
    }
    const indicatorScale = St.ThemeContext.get_for_stage(global.stage);
    const savedIndicatorScale = indicatorScale.scale_factor;
    indicatorScale.scale_factor = 2;
    await settle();
    checkRunningIndicators(instance._dock);
    indicatorScale.scale_factor = savedIndicatorScale;
    await settle();
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const dockGap = () => (instance._dock.background.get_transformed_position()[1] -
        (maximized.get_frame_rect().y + maximized.get_frame_rect().height)) / scale;
    print(`DOCK GAP: ${dockGap()} logical pixels`);
    assert(dockGap() >= 1 && dockGap() <= 2, 'maximized windows stop 1–2px above the visible dock');
    const sharedPanelColor = instance._dock.background.get_theme_node().get_background_color().to_string();
    const windowPanelColor = desktopPanelAlpha === 0 ? sharedPanelColor : desktopPanelColor;
    assert(instance._appearance.panelState === 'translucent' &&
        Main.panel.get_theme_node().get_background_color().to_string() === windowPanelColor,
    'maximized windows preserve wallpaper translucency or override wallpaper transparency');
    assert(!Main.layoutManager.panelBox.get_effect('panthea-panel-blur'),
        'maximized panel has no unmatched backdrop blur');
    checkPanelShadows();
    assert(instance._dock.background.get_theme_node().get_background_color().alpha < 255,
        'dock remains translucent with a maximized window');
    const maximizedDockAlpha = instance._dock.background.get_theme_node().get_background_color().alpha;
    assert(maximizedDockAlpha === desktopDockAlpha,
        'maximized windows do not change dock translucency');
    const uncrowdedHeight = instance._dock.actor.height;
    try {
        global.settings.set_strv('favorite-apps', launcher.catalog.entries.slice(0, 18).map(entry => entry.id));
        await settle();
        assert(instance._dock.dash.iconSize < instance._dock.dash.preferredIconSize,
            'a crowded dock shrinks its icons');
        assert(instance._dock.actor.height < uncrowdedHeight, 'a crowded dock releases unused reserved height');
        checkDockPadding(instance._dock);
        print(`CROWDED DOCK GAP: ${dockGap()} logical pixels`);
        checkRunningIndicators(instance._dock);
        assert(dockGap() >= 1 && dockGap() <= 2, 'crowded docks retain the 1–2px maximized-window gap');
        await screenshot('crowded-dock');
    } finally {
        global.settings.set_strv('favorite-apps', originalFavorites);
        await settle();
    }
    const app = Shell.WindowTracker.get_default().get_window_app(maximized);
    assert(app.get_windows().length === 2, 'GNOME tracks multiple windows for the running application');
    assert(instance._dock.dash._box.get_children().some(item => item.child?.app === app),
        'running application appears in the native dock');
    await screenshot('maximized-window');
    Main.overview.show();
    await until(() => Main.overview.visible, 'Overview opens with a maximized window');
    assert(instance._appearance.panelState === 'translucent',
        'Overview preserves the maximized desktop state');
    assert(Main.panel.get_theme_node().get_background_color().alpha === 0,
        'Overview uses the native fully transparent panel even with a maximized window');
    assert(instance._dock.background.get_theme_node().get_background_color().to_string() === sharedPanelColor,
        'Overview preserves the selected translucent dock background with maximized windows');
    assert(!Main.layoutManager.panelBox.get_effect('panthea-panel-blur'), 'Overview has no panel backdrop blur');
    await screenshot('overview-maximized');
    Main.overview.hide();
    await until(() => !Main.overview.visible, 'Overview closes');
    assert(Main.panel.get_theme_node().get_background_color().to_string() === windowPanelColor,
        'selected translucent appearance returns after Overview with maximized windows');
    const hiding = instance._dock._hiding;
    const normal = windows.find(window => window !== maximized);
    const movePointer = async (x, y) => {
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        await settle();
        await Scripting.sleep(200);
    };
    await movePointer(monitor.x + monitor.width / 2, monitor.y + 100);
    maximized.activate(global.get_current_time());
    settings.set_string('dock-hide-mode', 'focused-maximized');
    await until(() => hiding.hidden, 'hide animation starts after the mode changes');
    if (St.Settings.get().enable_animations) {
        await Scripting.sleep(50);
        assert(instance._dock.dash.translation_y > 0 &&
            instance._dock.dash.translation_y < instance._dock.actor.height,
        'enabled native animation has an intermediate slide position');
    }
    await settle();
    assert(hiding.hidden, 'focused maximized mode hides for the focused maximized window');
    assert(Main.layoutManager.getWorkAreaForMonitor(monitor.index).y +
        Main.layoutManager.getWorkAreaForMonitor(monitor.index).height === monitor.y + monitor.height,
    'automatic hiding releases the bottom work-area reservation');
    assert(maximized.get_frame_rect().y + maximized.get_frame_rect().height === monitor.y + monitor.height,
        'maximized window expands into the released dock space');
    assert(instance._dock.dash.translation_y === instance._dock.actor.height,
        'native animation moves the dock completely offscreen');
    await movePointer(monitor.x + monitor.width / 2, monitor.y + monitor.height - 1);
    assert(!hiding.hidden && instance._dock.dash.translation_y === 0,
        'real pointer motion to the bottom edge reveals the hidden dock');
    await movePointer(monitor.x + monitor.width / 2, monitor.y + monitor.height - 10);
    assert(!hiding.hidden, 'pointer can move from the edge into the revealed dock');
    const menuItem = instance._dock.dash._box.get_children().find(item => item.child?.app);
    menuItem.child.popupMenu();
    await movePointer(monitor.x + 10, monitor.y + 100);
    assert(!hiding.hidden, 'application context menu keeps a revealed dock open');
    menuItem.child._menu.close();
    await settle();
    await Scripting.sleep(250);
    assert(hiding.hidden, 'leaving the dock and closing its menu hides it again');
    normal.move_resize_frame(false, monitor.x + 50, monitor.y + 80, 400, 300);
    normal.activate(global.get_current_time());
    await settle();
    assert(!hiding.hidden, 'focused maximized mode ignores an unfocused maximized window');
    settings.set_string('dock-hide-mode', 'focused-overlap');
    await settle();
    assert(!hiding.hidden, 'focused overlap mode ignores a non-overlapping focused window');
    normal.move_frame(false, monitor.x + monitor.width / 2 - 200, monitor.y + monitor.height - 200);
    await settle();
    assert(hiding.hidden, 'moving the focused window over the dock hides it');
    normal.move_frame(false, monitor.x + 50, monitor.y + 80);
    await settle();
    assert(!hiding.hidden, 'moving the focused window away reveals the dock');
    settings.set_string('dock-hide-mode', 'any-overlap');
    await settle();
    assert(hiding.hidden, 'any overlap mode includes an unfocused maximized window');
    maximized.minimize();
    await settle();
    assert(!hiding.hidden, 'minimized windows do not hide the dock');
    maximized.unminimize();
    normal.activate(global.get_current_time());
    await settle();
    const otherWorkspace = global.workspace_manager.get_workspace_by_index(1);
    otherWorkspace.activate(global.get_current_time());
    await settle();
    assert(!hiding.hidden, 'overlap checks ignore windows on another workspace');
    normal.get_workspace().activate(global.get_current_time());
    await settle();
    assert(hiding.hidden, 'returning to overlapping windows hides the dock');
    maximized.minimize();
    await settle();
    settings.set_string('dock-hide-mode', 'unused');
    await settle();
    assert(hiding.hidden, 'unused mode hides without overlapping windows');
    Main.overview.show();
    await settle();
    assert(!hiding.hidden, 'Overview reveals the dock in automatic modes');
    Main.overview.hide();
    await settle();
    assert(hiding.hidden, 'leaving Overview restores automatic hiding');
    await movePointer(monitor.x + monitor.width / 2, monitor.y + monitor.height - 1);
    assert(!hiding.hidden, 'unused mode also reveals from the bottom edge');
    await movePointer(monitor.x + 10, monitor.y + 100);
    assert(hiding.hidden, 'unused mode hides after the pointer leaves');
    const dockScale = St.ThemeContext.get_for_stage(global.stage);
    const savedDockScale = dockScale.scale_factor;
    dockScale.scale_factor = 2;
    await settle();
    assert(hiding.hidden && instance._dock.dash.translation_y === instance._dock.actor.height,
        'hidden dock retargets its offscreen position after scale changes');
    await movePointer(monitor.x + monitor.width / 2, monitor.y + monitor.height - 1);
    assert(!hiding.hidden && instance._dock.dash.translation_y === 0,
        'edge reveal remains usable after scale changes');
    dockScale.scale_factor = savedDockScale;
    await movePointer(monitor.x + 10, monitor.y + 100);
    settings.set_string('dock-hide-mode', 'never');
    maximized.unminimize();
    maximized.activate(global.get_current_time());
    await settle();
    assert(!hiding.hidden && dockGap() >= 1 && dockGap() <= 2,
        'Never restores the dock and original maximized-window spacing');
    maximized.make_fullscreen();
    await settle();
    assert(instance._appearance.panelState === 'translucent' &&
        Main.panel.get_theme_node().get_background_color().to_string() === windowPanelColor,
    'fullscreen from a maximized window preserves the selected translucent background');
    assert(Main.panel.get_theme_node().get_background_color().alpha < 255,
        'fullscreen does not force an opaque panel');
    assert(!Main.layoutManager.panelBox.get_effect('panthea-panel-blur'),
        'fullscreen has no unmatched panel blur');
    assert(!instance._dock.actor.visible, 'fullscreen covers the dock');
    assert(!Main.layoutManager.panelBox.visible,
        'fullscreen styling does not reveal the native hidden panel');
    settings.set_string('dock-hide-mode', 'unused');
    await movePointer(monitor.x + monitor.width / 2, monitor.y + monitor.height - 1);
    assert(!instance._dock.actor.visible && !hiding._edge.visible,
        'fullscreen suppresses both automatic dock and pointer reveal strip');
    settings.set_string('dock-hide-mode', 'never');
    await movePointer(monitor.x + 10, monitor.y + 100);
    await until(() => maximized.get_frame_rect().height ===
        Main.layoutManager.monitors[maximized.get_monitor()].height,
    'fullscreen retains native full-monitor geometry');
    maximized.unmake_fullscreen();
    await settle();
    assert(Main.panel.get_theme_node().get_background_color().to_string() === windowPanelColor,
        'leaving fullscreen for a maximized window preserves the selected translucent background');
    assert(instance._dock.actor.visible, 'dock returns after fullscreen');
    maximized.unmaximize(Meta.MaximizeFlags.BOTH);
    await settle();
    assert(Main.panel.get_theme_node().get_background_color().to_string() === desktopPanelColor,
        'unmaximizing restores the wallpaper-selected panel');
    const wallpaperPanelColor = Main.panel.get_theme_node().get_background_color().to_string();
    maximized.make_fullscreen();
    await settle();
    assert(Main.panel.get_theme_node().get_background_color().to_string() === windowPanelColor,
        'fullscreen from a normal window selects the appropriate translucent background');
    maximized.unmake_fullscreen();
    await settle();
    assert(Main.panel.get_theme_node().get_background_color().to_string() === wallpaperPanelColor,
    'leaving fullscreen restores the wallpaper-selected panel');
    maximized.maximize(Meta.MaximizeFlags.BOTH);
    await settle();
    maximized.minimize();
    await settle();
    assert(Main.panel.get_theme_node().get_background_color().to_string() === wallpaperPanelColor,
        'minimized maximized windows restore the wallpaper-selected panel');
    maximized.unminimize();
    maximized.activate(global.get_current_time());
    await settle();
    assert(Main.panel.get_theme_node().get_background_color().to_string() === windowPanelColor,
        'restoring a maximized window restores the selected translucent background');
    const workspace = global.workspace_manager.get_workspace_by_index(1);
    workspace.activate(global.get_current_time());
    await settle();
    assert(instance._dock.actor.visible &&
        Main.panel.get_theme_node().get_background_color().to_string() === wallpaperPanelColor,
    'maximized windows on another workspace leave the wallpaper-selected panel');
    maximized.get_workspace().activate(global.get_current_time());
    await settle();
    assert(Main.panel.get_theme_node().get_background_color().to_string() === windowPanelColor,
        'returning to the maximized workspace restores the selected translucent background');
    const nativeDuration = Main.panel.get_theme_node().get_transition_duration();
    let transientDefault = false;
    const styleSignal = Main.panel.connect('style-changed', () => {
        const node = Main.panel.get_theme_node();
        transientDefault ||= !Main.panel.has_style_class_name('panthea-panel') ||
            node.get_background_color().alpha > Math.max(desktopDockAlpha, desktopPanelAlpha) ||
            node.get_transition_duration() !== nativeDuration;
    });
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            maximized.unmaximize(Meta.MaximizeFlags.BOTH);
            await Scripting.sleep(40);
            maximized.maximize(Meta.MaximizeFlags.BOTH);
            await Scripting.sleep(40);
        }
        await settle();
    } finally {
        Main.panel.disconnect(styleSignal);
    }
    assert(nativeDuration > 0 && !transientDefault &&
        Main.panel.get_theme_node().get_background_color().to_string() === windowPanelColor,
    'rapid state changes keep extension styles installed and native transition timing without default-color targets');
    await Scripting.destroyTestWindows();
    await settle();
    assert(Main.panel.get_theme_node().get_background_color().to_string() === wallpaperPanelColor &&
        instance._appearance._windows.size === 0,
    'closing all windows restores wallpaper styling and releases appearance window signals');
    assert(instance._dock._geometryId === 0 && instance._launcher._renderId === 0 &&
        instance._launcher._focusId === 0 && instance._appearance._sourceId === 0,
    'interaction leaves no pending Panthea idle sources');

    let displayDestroyed = false;
    display.connect('destroy', () => { displayDestroyed = true; });
    launcher.menu.open();
    await settle();
    launcher._search.set_text('settings');
    launcher._flushRender();
    settings.set_boolean('applications-enabled', false);
    await settle();
    assert(!instance._launcher && !Main.panel.statusArea['panthea@local'], 'Applications can be disabled live');
    assert(displayDestroyed, 'disabling Applications destroys its native display');
    settings.set_boolean('applications-enabled', true);
    await settle();
    assert(instance._launcher, 'Applications can be enabled live');

    assert(Main.extensionManager.openExtensionPrefs('panthea@local', '', {}), 'native preferences can be requested');
    let preferencesWindow = null;
    for (let attempt = 0; attempt < 20; attempt++) {
        await Scripting.sleep(100);
        preferencesWindow = global.get_window_actors().map(actor => actor.meta_window)
            .find(window => window.get_title() === 'Panthea' || window.get_title() === 'Extension Error');
        if (preferencesWindow)
            break;
    }
    assert(preferencesWindow?.get_title() === 'Panthea', 'GTK4/Libadwaita preferences open without an error page');
    Main.overview.hide();
    preferencesWindow.activate(global.get_current_time());
    await settle();
    await screenshot('preferences');
    const prefsFrame = preferencesWindow.get_frame_rect();
    print(`PREFS FRAME: ${prefsFrame.x},${prefsFrame.y} ${prefsFrame.width}x${prefsFrame.height}`);
    await click(pointer, prefsFrame.x + prefsFrame.width * 0.50, prefsFrame.y + 24);
    assert(!Main.overview.visible, 'preferences tab clicks do not trigger Overview');
    await screenshot('preferences-dock-panel');
    await click(pointer, prefsFrame.x + 220, prefsFrame.y + 364);
    assert(settings.get_string('dock-hide-mode') === 'focused-maximized',
        'Hide Dock radio row changes the persistent setting');
    settings.set_string('dock-hide-mode', 'never');
    await click(pointer, prefsFrame.x + prefsFrame.width * 0.73, prefsFrame.y + 24);
    await screenshot('preferences-visibility');
    pointer.notify_absolute_motion(GLib.get_monotonic_time(),
        prefsFrame.x + prefsFrame.width / 2, prefsFrame.y + prefsFrame.height / 2);
    for (const [section, distance] of [['indicators', 120], ['top-panel', 500]]) {
        pointer.notify_scroll_continuous(GLib.get_monotonic_time(), 0, distance,
            Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.NONE);
        pointer.notify_scroll_continuous(GLib.get_monotonic_time(), 0, 0,
            Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.VERTICAL);
        await settle();
        await screenshot(`preferences-visibility-${section}`);
    }
    preferencesWindow.delete(global.get_current_time());
    await settle();

    for (let cycle = 0; cycle < 3; cycle++) {
        instance._settings.set_boolean('show-apps-button', cycle !== 1);
        instance._settings.set_string('dock-hide-mode', cycle === 1 ? 'unused' : 'never');
        await settle();
        const oldHiding = instance._dock._hiding;
        let edgeDestroyed = false;
        oldHiding._edge.connect('destroy', () => { edgeDestroyed = true; });
        if (cycle === 0) {
            instance._launcher.menu.open();
            await settle();
            instance._launcher._search.set_text('terminal');
            await settle();
            instance._launcher._visibleButtons[0].popupMenu();
            await settle();
        }
        await Main.extensionManager._callExtensionDisableWithRebase('panthea@local');
        await settle();
        assert(Main.overview.dash.visible, `disable cycle ${cycle} restores GNOME Dash`);
        assert(!Main.layoutManager.uiGroup.get_children().some(actor => actor.name === 'panthea-dock'),
            `disable cycle ${cycle} removes dock chrome`);
        assert(edgeDestroyed && oldHiding._windows.size === 0,
            `disable cycle ${cycle} removes reveal strip and window connections`);
        await Main.extensionManager._callExtensionEnable('panthea@local');
        await settle();
        instance = extension.stateObj;
        assert(instance._dock.actor.visible, `enable cycle ${cycle} recreates the dock`);
        assert(instance._settings.get_string('dock-hide-mode') === (cycle === 1 ? 'unused' : 'never'),
            `enable cycle ${cycle} retains Hide Dock choice`);
        assert(instance._dock.dash.showAppsButton.visible === (cycle !== 1),
            `enable cycle ${cycle} retains Show Apps Button visibility`);
    }
    Main.overview.hide();
    await settle();
    await screenshot('desktop');
    const idleBefore = sampleProcess();
    await Scripting.sleep(2000);
    const idleAfter = sampleProcess();
    print(`MEASURE: enabled idle 2 s: ${idleAfter.ticks - idleBefore.ticks} CPU ticks; RSS ${idleAfter.rss} KiB`);
    await Main.extensionManager._callExtensionDisableWithRebase('panthea@local');
    await settle();
    const baselineBefore = sampleProcess();
    await Scripting.sleep(2000);
    const baselineAfter = sampleProcess();
    print(`MEASURE: disabled idle 2 s: ${baselineAfter.ticks - baselineBefore.ticks} CPU ticks; RSS ${baselineAfter.rss} KiB`);
    print('PASS: Panthea Shell integration checks complete');
}
