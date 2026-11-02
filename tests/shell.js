// SPDX-License-Identifier: GPL-3.0-or-later
// Run only through gnome-shell-test-tool, which supplies isolated settings/data.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
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

function checkCategories(launcher) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const appFont = launcher._visibleButtons[0]._label.get_theme_node().get_font();
    for (const button of launcher._categoryButtons.values()) {
        if (!button.visible)
            continue;
        const node = button.get_theme_node();
        const label = button.child;
        const font = node.get_font();
        assert(Math.abs(node.get_padding(St.Side.LEFT) - 14 * scale) < 1 &&
            Math.abs(node.get_padding(St.Side.RIGHT) - 14 * scale) < 1 &&
            Math.abs(bounds(label).x - bounds(button).x - node.get_padding(St.Side.LEFT)) <= 2 * scale,
        `${button.label} is left-aligned with 14px horizontal padding`);
        assert(font.get_size() === appFont.get_size(), `${button.label} keeps the application font size`);
        assert(font.get_weight() === (button.checked ? 500 : 400) &&
            label.opacity === (button.checked ? 255 : 204),
        `${button.label} uses the selected or muted category typography`);
        if (button.checked) {
            assert(node.get_background_color().alpha > 0 && node.get_border_radius(0) > 0,
                'selected category retains its native rounded background');
        }
    }
}

function checkPageArrows(launcher) {
    const {x, width} = bounds(launcher._root);
    const body = bounds(launcher._body);
    const dots = bounds(launcher._pageIndicators);
    assert(Math.abs(dots.x + dots.width / 2 - (x + width / 2)) < 1,
        'page dots remain centered in the launcher');
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const dotAreas = launcher._pageIndicators.get_children().map(bounds);
    assert(launcher._pageIndicators.get_children().every((indicator, index) =>
        indicator.accessible_name === `Page ${index + 1} of ${launcher._pageIndicators.nPages}` &&
        indicator._tooltip.label.text === indicator.accessible_name),
    'page dots have accessible names and matching tooltips for the current page count');
    for (const [arrow, name] of [[launcher._previousPageArrow, 'Previous page'],
        [launcher._nextPageArrow, 'Next page']]) {
        assert(arrow.accessible_name === name && arrow._tooltip.label.text === name,
            `${name} has an accessible name and matching tooltip`);
    }
    assert(dotAreas.every(area => area.width >= 32 * scale && area.height >= 32 * scale),
        'page dots have at least 32px targets');
    assert(dotAreas.every((area, index) => index === 0 ||
        area.x >= dotAreas[index - 1].x + dotAreas[index - 1].width),
    'page dot targets do not overlap');
    assert(launcher._pageIndicators.get_children().every(indicator =>
        indicator.get_theme_node().get_transition_duration() === 0),
    'page dot focus outlines update without an inherited transition delay');
    for (const arrow of [launcher._previousPageArrow, launcher._nextPageArrow]) {
        if (!arrow.visible)
            continue;
        const area = bounds(arrow);
        assert(area.width >= 40 * scale && area.height >= 40 * scale &&
            arrow.child.icon_size === 16,
        'page arrows have at least 40px targets with compact 16px chevrons');
        assert(Math.abs(area.y + area.height / 2 - (body.y + body.height / 2)) < 1,
            `${arrow.accessible_name} is vertically centered`);
        assert(launcher._visibleButtons.every(button => {
            const app = bounds(button);
            return app.x + app.width <= area.x || app.x >= area.x + area.width;
        }), `${arrow.accessible_name} never overlaps application tiles`);
        assert(arrow.has_style_class_name('panthea-page-arrow') &&
            !arrow.has_style_class_name('page-navigation-arrow'),
        'chevrons do not inherit native circular button styling');
    }
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
                return shadow === null;
            return shadow && shadow.xoffset === 0 && shadow.yoffset === scale &&
                shadow.blur === 3 * scale && shadow.spread === 0 && !shadow.inset &&
                shadow.color.red === 0 && shadow.color.green === 0 && shadow.color.blue === 0 &&
                Math.abs(shadow.color.alpha / 255 - 0.45) < 0.01;
        }), `${property} leaves dark controls unshadowed and keeps soft black shadows on light controls with Panel Translucency ${enabled ? 'enabled' : 'disabled'}`);
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
    assert(launcher._visibleButtons.length > 0, 'first page has applications');
    assert(launcher._visibleButtons.length <= launcher._pageSize, 'application actors are bounded by page size');
    assert(!launcher._count, 'Applications has no count label');
    assert(launcher._pageIndicators.nPages === Math.ceil(launcher._matches.length / launcher._pageSize),
        'native dots show the actual page count');
    const search = bounds(launcher._search);
    const view = bounds(launcher._viewButtons.get('grid'));
    assert(Math.abs(search.y + search.height / 2 - (view.y + view.height / 2)) < 1 &&
        search.x + search.width <= view.x,
    'search and view controls share one row without overlap');
    assert(launcher._root.get_children().length === 3, 'the old toolbar row is reclaimed');
    assert(!launcher._previousPageArrow.visible && launcher._nextPageArrow.visible,
        'only Next is shown on the first grid page');
    const firstGridTile = bounds(launcher._visibleButtons[0]);
    assert(launcher._nextPageArrow.get_theme_node().get_background_color().alpha === 0,
        'chevrons have no background at rest');
    await screenshot('applications-arrow-rest');
    const nextArrow = bounds(launcher._nextPageArrow);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(),
        nextArrow.x + nextArrow.width / 2, nextArrow.y + nextArrow.height / 2);
    await settle();
    await until(() => launcher._nextPageArrow._tooltip.label.visible,
        'hovering a chevron shows its delayed tooltip');
    assert(launcher._nextPageArrow._tooltip.label.text === 'Next page' &&
        launcher._nextPageArrow._tooltip.label.has_style_class_name('dash-label'),
    'chevron tooltips use the accessible name and native view-button style');
    await screenshot('applications-arrow-hover');
    assert(launcher._nextPageArrow.hover, 'page arrows respond to pointer hover');
    assert(launcher._nextPageArrow.get_theme_node().get_background_color().alpha > 0,
        'hover adds a subtle chevron background');
    pointer.notify_absolute_motion(GLib.get_monotonic_time(),
        search.x + search.width / 2, search.y + search.height / 2);
    await settle();
    assert(!launcher._nextPageArrow.hover &&
        launcher._nextPageArrow.get_theme_node().get_background_color().alpha === 0,
    'leaving a chevron removes its hover background');
    assert(!launcher._nextPageArrow._tooltip.label.visible,
        'leaving a chevron hides its tooltip');
    launcher._nextPageArrow.grab_key_focus();
    await settle();
    await screenshot('applications-arrow-focus');
    assert(launcher._nextPageArrow.get_theme_node().get_background_color().alpha > 0,
        'keyboard focus highlights the chevron without pointer hover');
    assert(launcher._nextPageArrow.get_theme_node().get_border_color(St.Side.TOP).alpha > 0 &&
        launcher._nextPageArrow.get_theme_node().get_border_width(St.Side.TOP) >= 2,
    'keyboard-focused chevrons have a distinct visible outline');
    checkPageArrows(launcher);
    await press(keyboard, Clutter.KEY_space);
    assert(launcher._page === 1, 'Next supports keyboard activation');
    assert(launcher._previousPageArrow.visible, 'Previous appears after leaving the first page');
    const nextGridTile = bounds(launcher._visibleButtons[0]);
    assert(['x', 'y', 'width', 'height'].every(key =>
        Math.abs(firstGridTile[key] - nextGridTile[key]) < 1),
    'changing arrow visibility never displaces or resizes application tiles');
    if (launcher._pageIndicators.nPages > 2)
        assert(launcher._nextPageArrow.visible, 'both arrows appear on a middle page');
    checkPageArrows(launcher);
    launcher._previousPageArrow.grab_key_focus();
    launcher._previousPageArrow._tooltip.show();
    const previousArrow = bounds(launcher._previousPageArrow);
    await click(pointer, previousArrow.x + 3,
        previousArrow.y + previousArrow.height / 2);
    assert(launcher._page === 0 && !launcher._previousPageArrow.visible,
        'clicking Previous returns to the first page and hides it');
    assert(!launcher._previousPageArrow._tooltip.label.visible,
        'a disappearing chevron hides its tooltip');
    assert(global.stage.key_focus === launcher._nextPageArrow,
        'focus moves to Next when Previous disappears');
    launcher._changePage(launcher._pageIndicators.nPages - 2 - launcher._page);
    launcher._nextPageArrow.grab_key_focus();
    launcher._nextPageArrow._tooltip.show();
    await press(keyboard, Clutter.KEY_space);
    assert(launcher._page === launcher._pageIndicators.nPages - 1 && !launcher._nextPageArrow.visible,
        'Next hides on reaching the last page');
    assert(!launcher._nextPageArrow._tooltip.label.visible,
        'reaching the last page hides the Next tooltip');
    assert(global.stage.key_focus === launcher._previousPageArrow,
        'focus moves to Previous when Next disappears');
    checkPageArrows(launcher);
    launcher._changePage(-launcher._page);
    const dots = launcher._pageIndicators.get_children();
    assert(dots[0].child.opacity > dots[1].child.opacity, 'the active dot is more prominent');
    dots[1].emit('clicked', Clutter.BUTTON_PRIMARY);
    await settle();
    assert(launcher._page === 1, 'clicking a page dot changes pages');
    launcher._pageIndicators.get_children()[0].emit('clicked', Clutter.BUTTON_PRIMARY);
    await settle();
    const secondDot = launcher._pageIndicators.get_children()[1];
    const dotArea = bounds(secondDot);
    await click(pointer, dotArea.x + 3, dotArea.y + dotArea.height / 2);
    assert(launcher._page === 1, 'page dots activate outside the small visible glyph');
    launcher._changePage(-launcher._page);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(),
        dotArea.x + dotArea.width / 2, dotArea.y + dotArea.height / 2);
    await settle();
    assert(secondDot.hover, 'page dots respond to pointer hover');
    await until(() => secondDot._tooltip.label.visible,
        'hovering a page dot shows its delayed tooltip');
    assert(secondDot._tooltip.label.text === `Page 2 of ${launcher._pageIndicators.nPages}` &&
        secondDot._tooltip.label.has_style_class_name('dash-label'),
    'dot tooltips use the accessible name and native view-button style');
    await screenshot('applications-dot-tooltip');
    const dotHoverOpacity = secondDot.child.opacity;
    const dotHoverScale = secondDot.child.scale_x;
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), search.x, search.y);
    secondDot.grab_key_focus();
    await settle();
    assert(!secondDot._tooltip.label.visible, 'leaving a page dot hides its tooltip');
    assert(!secondDot.hover && secondDot.child.opacity === dotHoverOpacity &&
        secondDot.child.scale_x === dotHoverScale,
    'keyboard-focused dots match their hover appearance');
    assert(secondDot.get_theme_node().get_border_color(St.Side.TOP).alpha > 0 &&
        secondDot.get_theme_node().get_border_width(St.Side.TOP) >= 2,
    'keyboard-focused page dots have a distinct visible outline');
    await screenshot('applications-dot-focus');
    await press(keyboard, Clutter.KEY_ISO_Left_Tab);
    assert(global.stage.key_focus === launcher._pageIndicators.get_children()[0],
        'keyboard navigation reaches the previous page dot');
    await press(keyboard, Clutter.KEY_Tab);
    assert(global.stage.key_focus === secondDot, 'Tab reaches the next page dot');
    await press(keyboard, Clutter.KEY_space);
    assert(launcher._page === 1 && secondDot.can_focus, 'page dots support keyboard focus and activation');
    await press(keyboard, Clutter.KEY_Page_Up);
    launcher._search.grab_key_focus();
    await settle();
    assert(secondDot.child.opacity < dotHoverOpacity,
        'leaving an inactive page dot restores its resting appearance');
    await screenshot('applications-grid');
    const paginationTooltips = [launcher._nextPageArrow._tooltip,
        ...launcher._pageIndicators.get_children().map(indicator => indicator._tooltip)];
    for (const tooltip of paginationTooltips)
        tooltip.show();
    assert(paginationTooltips.every(tooltip => tooltip.label.visible),
        'pagination tooltips are visible before closing the menu');
    launcher.menu.close();
    assert(paginationTooltips.every(tooltip => !tooltip.label.visible),
        'closing the menu immediately hides all pagination tooltips');
    await settle();
    launcher.menu.open();
    await settle();

    await press(keyboard, Clutter.KEY_Down);
    assert(global.stage.key_focus === launcher._visibleButtons[0], 'Down moves from search to applications');
    await press(keyboard, Clutter.KEY_Right);
    assert(global.stage.key_focus === launcher._visibleButtons[1], 'Right moves between applications');
    await press(keyboard, Clutter.KEY_Page_Down);
    assert(launcher._page === 1, 'Page Down changes application pages');
    await press(keyboard, Clutter.KEY_Page_Up);
    assert(launcher._page === 0, 'Page Up restores the first page');
    launcher._visibleButtons[0].popupMenu();
    await settle();
    assert(launcher._visibleButtons[0]._menu.isOpen, 'native application context menu opens');
    await screenshot('application-context-menu');
    launcher._visibleButtons[0]._menu.close();
    launcher._search.grab_key_focus();

    const gridHeight = launcher._visibleButtons[0].height;
    const gridTop = launcher._visibleButtons[0].get_transformed_position()[1];
    const gridLeft = launcher._visibleButtons[0].get_transformed_position()[0];
    const firstName = launcher.catalog.entries[0].info.get_name();
    const firstDot = launcher._pageIndicators.get_children()[0];
    firstDot._tooltip.show();
    let removedDotTooltipDestroyed = false;
    launcher._pageIndicators.get_children().at(-1)._tooltip.label.connect('destroy', () => {
        removedDotTooltipDestroyed = true;
    });
    launcher._search.set_text(firstName);
    await settle();
    assert(launcher._visibleButtons.length > 0 && launcher._visibleButtons.length < launcher._pageSize,
        'search can produce a sparse page');
    assert(firstDot.accessible_name === 'Page 1 of 1' &&
        firstDot._tooltip.label.text === 'Page 1 of 1' && !firstDot._tooltip.label.visible,
    'page-count changes update names and tooltips and hide single-page tooltips');
    assert(removedDotTooltipDestroyed, 'removed page dots destroy their tooltip actors');
    const sparseHeight = launcher._visibleButtons[0].height;
    const sparseTop = launcher._visibleButtons[0].get_transformed_position()[1];
    const sparseLeft = launcher._visibleButtons[0].get_transformed_position()[0];
    assert(launcher._visibleButtons.every(button => Math.abs(button.height - sparseHeight) < 1) &&
        Math.abs(sparseHeight - gridHeight) < 1,
    'sparse grid rows keep their standard height');
    assert(Math.abs(sparseTop - gridTop) < 1 && Math.abs(sparseLeft - gridLeft) < 1,
        'sparse grid rows start at the top left');
    assert(!launcher._previousPageArrow.visible && !launcher._nextPageArrow.visible,
        'single-page search results hide both arrows');
    checkLauncherAnchor(launcher);
    await screenshot('applications-grid-sparse');

    const searchEntry = launcher.catalog.entries[0];
    const term = searchEntry.info.get_name().split(/\s+/)[0];
    for (let length = 1; length <= Math.min(term.length, 5); length++)
        launcher._search.set_text(term.slice(0, length));
    launcher._search.set_text(term);
    await settle();
    assert(launcher._matches.some(entry => entry.id === searchEntry.id), 'rapid search uses the latest query and native application matches');

    launcher._search.set_text('panthea-impossible-search-928174');
    await settle();
    assert(launcher._matches.length === 0 && launcher._empty.visible, 'empty search state');
    assert(!launcher._pageIndicators.visible, 'empty results hide page dots');
    assert(!launcher._previousPageArrow.visible && !launcher._nextPageArrow.visible,
        'empty results hide both arrows');
    await screenshot('applications-empty');
    launcher._search.set_text('');
    // Keep the test helper alive while the expanded launcher checks run.
    await Scripting.waitTestWindows();
    settings.set_string('applications-view', 'list');
    await settle();
    assert(launcher._sidebarScroll.visible, 'list view has categories');
    checkLauncherAnchor(launcher);
    checkCategories(launcher);
    assert(!launcher._previousPageGutter.visible && !launcher._nextPageGutter.visible,
        'list view has no arrow gutters');
    assert(!launcher._pageIndicators.visible && launcher._page === 0 &&
        launcher._visibleButtons.length === launcher._matches.length &&
        launcher._matches.length > launcher._pageSize,
    'list view exposes every result without pagination');
    const listAdjustment = launcher._resultsScroll.vadjustment;
    assert(listAdjustment.upper > listAdjustment.page_size,
        'long lists have a bounded scrollable viewport');
    const scrollArea = bounds(launcher._resultsScroll);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(),
        scrollArea.x + scrollArea.width / 2, scrollArea.y + scrollArea.height / 2);
    await settle();
    const sidebarValue = launcher._sidebarScroll.vadjustment.value;
    pointer.notify_discrete_scroll(GLib.get_monotonic_time(),
        Clutter.ScrollDirection.DOWN, Clutter.ScrollSource.WHEEL);
    await settle();
    assert(listAdjustment.value > 0 && launcher._sidebarScroll.vadjustment.value === sidebarValue,
        'mouse wheel scrolls results independently of the category sidebar');
    const wheelValue = listAdjustment.value;
    pointer.notify_scroll_continuous(GLib.get_monotonic_time(), 0, 40,
        Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.NONE);
    pointer.notify_scroll_continuous(GLib.get_monotonic_time(), 0, 0,
        Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.VERTICAL);
    await settle();
    assert(listAdjustment.value > wheelValue,
        'continuous touchpad-style scrolling moves list results');
    const scrollbar = launcher._resultsScroll.get_children().find(actor =>
        actor instanceof St.ScrollBar && actor.orientation === Clutter.Orientation.VERTICAL);
    const scrollBounds = bounds(scrollbar);
    const beforeScrollbarClick = listAdjustment.value;
    await click(pointer, scrollBounds.x + scrollBounds.width / 2,
        scrollBounds.y + scrollBounds.height - 8);
    assert(listAdjustment.value > beforeScrollbarClick, 'native scrollbar supports pointer scrolling');
    launcher._categoryButtons.get('all').emit('clicked', Clutter.BUTTON_PRIMARY);
    await settle();
    launcher._search.grab_key_focus();
    await press(keyboard, Clutter.KEY_Down);
    await press(keyboard, Clutter.KEY_End);
    assert(global.stage.key_focus === launcher._visibleButtons.at(-1) && listAdjustment.value > 0,
        'End focuses and scrolls to the last list result');
    const lastResult = bounds(launcher._visibleButtons.at(-1));
    const viewport = bounds(launcher._resultsScroll);
    assert(lastResult.y >= viewport.y - 1 &&
        lastResult.y + lastResult.height <= viewport.y + viewport.height + 1,
    'keyboard-focused list results remain visible');
    await press(keyboard, Clutter.KEY_Page_Up);
    assert(launcher._page === 0 && global.stage.key_focus !== launcher._visibleButtons.at(-1),
        'Page Up navigates the continuous list without changing pages');
    await press(keyboard, Clutter.KEY_Home);
    assert(listAdjustment.value === 0, 'Home scrolls back to the first list result');
    launcher._search.grab_key_focus();
    await press(keyboard, Clutter.KEY_Page_Down);
    assert(listAdjustment.value > 0 && launcher._page === 0,
        'Page Down scrolls the list from search without pagination');
    launcher._categoryButtons.get('all').emit('clicked', Clutter.BUTTON_PRIMARY);
    await settle();
    assert(listAdjustment.value === 0, 'category selection resets list scrolling');
    launcher._categoryButtons.get('favorites').emit('clicked', Clutter.BUTTON_PRIMARY);
    const savedFavorites = global.settings.get_strv('favorite-apps');
    try {
        global.settings.set_strv('favorite-apps', []);
        await settle();
        assert(launcher._visibleButtons.length === 0 && launcher._empty.visible &&
            launcher._empty.text === 'No favorite applications' && !launcher._pageIndicators.visible,
        'empty Favorites retains its message without pagination');
    } finally {
        global.settings.set_strv('favorite-apps', savedFavorites);
    }
    launcher._search.set_text(term);
    await settle();
    assert(!launcher._sidebarScroll.visible && !launcher._pageIndicators.visible &&
        launcher._matches.some(entry => entry.id === searchEntry.id) &&
        launcher._visibleButtons.length === launcher._matches.length,
    'list search spans all categories and remains unpaginated');
    launcher._search.set_text('panthea-impossible-search-928174');
    await settle();
    assert(launcher._empty.visible && launcher._visibleButtons.length === 0 &&
        !launcher._pageIndicators.visible,
    'empty list search retains its message without pagination');
    launcher._search.set_text('');
    launcher._categoryButtons.get('all').emit('clicked', Clutter.BUTTON_PRIMARY);
    await settle();
    const fullListHeight = launcher._visibleButtons[0].height;
    const fullListTop = launcher._visibleButtons[0].get_transformed_position()[1];
    const sparseCategory = [...launcher._categoryButtons.keys()].find(id => {
        if (id === 'all' || id === 'favorites')
            return false;
        const count = launcher.catalog.entries.filter(entry => entry.category === id).length;
        return count > 0 && count < launcher._pageSize;
    });
    assert(sparseCategory, 'a partly filled category exists');
    launcher._categoryButtons.get(sparseCategory).emit('clicked', Clutter.BUTTON_PRIMARY);
    await settle();
    const listHeight = launcher._visibleButtons[0].height;
    const listTop = launcher._visibleButtons[0].get_transformed_position()[1];
    const listBottom = launcher._visibleButtons.at(-1).y + listHeight;
    assert(launcher._visibleButtons.every(button => Math.abs(button.height - listHeight) < 1) &&
        Math.abs(listHeight - fullListHeight) < 1 && listBottom <= launcher._body.height,
    'sparse list rows keep their standard height');
    assert(Math.abs(listTop - fullListTop) < 1, 'sparse list rows start at the top');
    checkCategories(launcher);
    for (const [view, text] of [['grid', 'Grid View'], ['list', 'Category View']]) {
        const button = launcher._viewButtons.get(view);
        assert(button.accessible_name === text, `${text} is the tooltip label`);
        button._tooltip.show();
        await settle();
        assert(button._tooltip.label.visible && button._tooltip.label.text === text,
            `${text} tooltip appears`);
        assert(button._tooltip.label.has_style_class_name('dash-label'), 'tooltips use the native Shell style');
        if (view === 'grid')
            await screenshot('view-tooltip');
        button._tooltip.hide();
    }
    await screenshot('applications-list');
    launcher._viewButtons.get('grid')._tooltip.show();
    await settle();
    assert(launcher._viewButtons.get('grid')._tooltip.label.visible, 'view tooltip is visible before closing');
    launcher.menu.close();
    await settle();
    assert([...launcher._viewButtons.values()].every(button => !button._tooltip.label.visible),
        'closing the menu hides view tooltips');

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
    assert(Math.abs(normalDockAlpha / 255 - (lightDock ? 0.5 : 0.3)) < 0.01,
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
            assert(expected === 'translucent' ? Math.abs(alpha / 255 - 0.3) < 0.01 : alpha === 0,
                `${name} wallpaper selects the default panel background`);
            const foreground = launcher.get_theme_node().get_foreground_color();
            assert(name !== 'light' || foreground.red < 100, 'light wallpaper gives panel controls dark text');
            assert(!Main.layoutManager.panelBox.get_effect('panthea-panel-blur') &&
                Math.abs(instance._dock.background.get_theme_node().get_background_color().alpha / 255 - 0.3) < 0.01,
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
        assert(launcher.menu.isOpen && launcher._visibleButtons.length > 0, `launcher survives ${scheme}`);
        checkLauncherAnchor(launcher);
        checkCategories(launcher);
        settings.set_string('applications-view', 'grid');
        await settle();
        checkPageArrows(launcher);
        settings.set_string('applications-view', 'list');
        await settle();
        assert(Main.panel.get_theme_node().get_background_color().alpha < 255, `${scheme} retains translucency`);
        await screenshot(`applications-${scheme}`);
        launcher.menu.close();
        await settle();
        await checkPanelFeedback(instance, pointer, scheme);
    }
    interfaceSettings.set_double('text-scaling-factor', 1.25);
    await settle();
    launcher.menu.open();
    await settle();
    assert(launcher._body.height < monitor.height, 'larger text keeps results within the display');
    checkLauncherAnchor(launcher);
    checkCategories(launcher);
    await screenshot('applications-large-text');
    settings.set_string('applications-view', 'grid');
    await settle();
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
    settings.set_string('applications-view', 'list');
    await settle();
    checkLauncherAnchor(launcher);
    assert(!launcher._pageIndicators.visible &&
        launcher._visibleButtons.length === launcher._matches.length,
    'scaled list view remains continuous without pagination');
    launcher.menu.close();
    themeContext.scale_factor = originalScale;
    await settle();

    const originalFavorites = global.settings.get_strv('favorite-apps');
    const candidate = launcher.catalog.entries.find(entry => !originalFavorites.includes(entry.id));
    launcher.catalog.favorites.addFavorite(candidate.id);
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

    const launcherTooltipLabels = [launcher._previousPageArrow, launcher._nextPageArrow,
        ...launcher._pageIndicators.get_children(), ...launcher._viewButtons.values()]
        .map(button => button._tooltip.label);
    let destroyedLauncherTooltips = 0;
    for (const label of launcherTooltipLabels)
        label.connect('destroy', () => destroyedLauncherTooltips++);
    settings.set_boolean('applications-enabled', false);
    await settle();
    assert(!instance._launcher && !Main.panel.statusArea['panthea@local'], 'Applications can be disabled live');
    assert(destroyedLauncherTooltips === launcherTooltipLabels.length,
        'disabling Applications destroys all tooltip actors');
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
