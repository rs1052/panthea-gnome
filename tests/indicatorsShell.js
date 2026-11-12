// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export {init} from './shell.js';
export const METRICS = {};

function assert(value, message) {
    if (!value)
        throw new Error(`Panthea indicators: ${message}`);
    print(`PASS: ${message}`);
}

async function settle() {
    await Scripting.sleep(300);
    await Scripting.waitLeisure();
}

async function screenshot(name) {
    const output = GLib.getenv('PANTHEA_TEST_OUTPUT');
    if (!output)
        return;
    const stream = Gio.File.new_for_path(`${output}/${name}.png`)
        .replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
}

export async function run() {
    await Scripting.disableHelperAutoExit();
    Main.overview.hide();
    await settle();
    const extension = Main.extensionManager.lookup('panthea@local');
    const instance = extension.stateObj;
    const settings = instance._settings;
    const dock = instance._dock;
    const icons = dash => dash._box.get_children().map(item => item.child).filter(icon => icon?.app);
    assert(settings.get_boolean('window-count-indicators'), 'window-count indicators default to on');
    const windows = [];
    let app;
    const findIcon = (dash = dock.dash) => icons(dash).find(icon => icon.app === app);
    for (let count = 1; count <= 5; count++) {
        await Scripting.createTestWindow({width: 300, height: 200});
        await Scripting.waitTestWindows();
        // Native Overview Dash defers redisplay while hidden.
        Main.overview.show();
        await settle();
        const current = global.get_window_actors().map(actor => actor.meta_window)
            .filter(window => /perf-?helper/i.test(window.get_wm_class() ?? ''));
        windows.splice(0, windows.length, ...current);
        app = Shell.WindowTracker.get_default().get_window_app(windows[0]);
        for (const dash of [dock.dash, dock.nativeDash]) {
            const indicator = findIcon(dash)._pantheaIndicators;
            assert(windows.length === count && indicator.count === Math.min(count, 4) &&
                indicator.actor.get_children().filter(dot => dot.visible).length === Math.min(count, 4),
            `${count} windows show ${Math.min(count, 4)} dots in ${dash === dock.dash ? 'desktop' : 'Overview'} dock`);
        }
        Main.overview.hide();
        await settle();
    }
    windows[0].minimize();
    const workspace = global.workspace_manager.get_workspace_by_index(1);
    windows[1].change_workspace(workspace);
    await settle();
    assert(findIcon()._pantheaIndicators.count === 4, 'minimized and other-workspace windows count');
    const originalWorkspace = global.workspace_manager.get_active_workspace();
    // Keep this empty workspace available while testing a switch away and back.
    Main.wm.keepWorkspaceAlive(originalWorkspace, 15000);
    const originalWorkspaces = windows.map(window => window.get_workspace());
    const workspaceIndicators = [dock.dash, dock.nativeDash].map(dash => findIcon(dash)._pantheaIndicators);
    const originalColors = workspaceIndicators.map(dots => dots._color);
    const checkWorkspace = (current, message) => {
        for (const dots of workspaceIndicators) {
            assert(dots.onCurrentWorkspace === current && dots.actor.opacity === 255 &&
                dots.count === 4, `${message}: matching workspace presence, opacity, and unchanged count`);
            const size = current ? 5 : 4;
            // Overview defers style updates while its Dash is unmapped.
            dots.actor.ensure_style();
            for (const dot of dots.actor.get_children())
                dot.ensure_style();
            assert(dots.actor.get_children().filter(dot => dot.visible).every(dot =>
                dot.get_preferred_width(-1)[1] === size && dot.get_preferred_height(-1)[1] === size),
            `${message}: ${size}px dots`);
            const color = dots.actor.get_first_child().get_theme_node().get_background_color();
            assert(current ? color.red === 230 && color.green === 80 && color.blue === 80 :
                color.red === 153 && color.green === 153 && color.blue === 153 && color.alpha === 255,
            `${message}: ${current ? 'full icon color' : 'opaque neutral gray'}`);
        }
    };
    try {
        for (const dots of workspaceIndicators) {
            dots._color = 'rgb(230,80,80)';
            dots._syncStyle();
        }
        checkWorkspace(true, 'an app spanning workspaces has full-color dots');
        for (const window of windows)
            window.change_workspace(workspace);
        await settle();
        checkWorkspace(false, 'an app running only elsewhere has gray dots in both docks');
        for (const dash of [dock.dash, dock.nativeDash]) {
            const classes = ['panthea-dark-dock', 'panthea-light-dock'];
            const original = classes.filter(name => dash.has_style_class_name(name));
            const dots = findIcon(dash)._pantheaIndicators;
            try {
                for (const appearance of classes) {
                    for (const name of classes)
                        dash.remove_style_class_name(name);
                    dash.add_style_class_name(appearance);
                    dots._syncStyle();
                    const color = dots.actor.get_first_child().get_theme_node().get_background_color();
                    assert(color.red === 153 && color.green === 153 && color.blue === 153 && color.alpha === 255,
                        `${appearance}: remote dots use fully opaque #999999`);
                }
            } finally {
                for (const name of classes)
                    dash.remove_style_class_name(name);
                for (const name of original)
                    dash.add_style_class_name(name);
                dots._syncStyle();
            }
        }
        windows[0].change_workspace(originalWorkspace);
        await settle();
        assert(windows[0].minimized, 'workspace cue test retains a minimized window');
        checkWorkspace(true, 'a minimized window on the current workspace still counts as present');
        windows[0].change_workspace(workspace);
        await settle();
        checkWorkspace(false, 'moving the last local window away makes the dots smaller and gray');
        workspace.activate(global.get_current_time());
        await settle();
        checkWorkspace(true, 'switching to the app workspace restores full color');
        originalWorkspace.activate(global.get_current_time());
        await settle();
        checkWorkspace(false, 'switching away restores the gray cue');
        windows[0].stick();
        await settle();
        checkWorkspace(true, 'sticky windows are present on every workspace');
        windows[0].unstick();
        await settle();
        assert(windows[0].located_on_workspace(originalWorkspace),
            'GNOME places an unstuck window on the current workspace');
        checkWorkspace(true, 'unsticking follows GNOME workspace placement');
        windows[0].change_workspace(workspace);
        await settle();
        checkWorkspace(false, 'moving the unstuck window away restores the gray cue');
    } finally {
        windows.forEach((window, index) => window.change_workspace(originalWorkspaces[index]));
        workspaceIndicators.forEach((dots, index) => { dots._color = originalColors[index]; });
        await settle();
        for (const dots of workspaceIndicators)
            dots._syncStyle();
    }
    await screenshot('indicator-workspace-local');
    for (const window of windows)
        window.change_workspace(workspace);
    await settle();
    await screenshot('indicator-workspace-elsewhere');
    windows.forEach((window, index) => window.change_workspace(originalWorkspaces[index]));
    await settle();
    const indicator = findIcon()._pantheaIndicators;
    settings.set_boolean('window-count-indicators', false);
    await settle();
    assert(!indicator.actor.visible && findIcon()._dot.opacity === 255 && findIcon()._dot.visible,
        'off restores the native running dot live');
    settings.set_boolean('window-count-indicators', true);
    await settle();
    assert(indicator.actor.visible && findIcon()._dot.opacity === 0, 'on restores count dots live');

    const colors = dock.dash._indicatorColors;
    const path = `${GLib.getenv('PANTHEA_TEST_OUTPUT')}/indicator-red.svg`;
    GLib.file_set_contents(path,
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path fill="red" d="M0 0h64v64H0z"/></svg>');
    const file = Gio.File.new_for_path(path);
    try {
        const icon = new Gio.FileIcon({file});
        assert(await colors.get(icon) === 'rgb(230,80,80)', 'async file-icon decoding extracts dominant hue');
        for (const dash of [dock.dash, dock.nativeDash]) {
            const texture = findIcon(dash).icon.icon;
            const dots = findIcon(dash)._pantheaIndicators;
            const originalIcon = texture.gicon;
            try {
                texture.gicon = icon;
                await dots._readColor();
                assert(dots._color === 'rgb(230,80,80)' && dots._colors === colors,
                    'both docks use the same extracted app-icon color and cache');
            } finally {
                texture.gicon = originalIcon;
                await dots._readColor();
            }
        }
        assert(colors.get(icon) === colors.get(icon), 'icon color loads reuse cached promises');
        assert(await colors.get(Gio.ThemedIcon.new('panthea-nonexistent-icon-39821')) === null,
            'missing icon resolves to theme fallback without an error');
        assert(await colors.get(null) === null, 'unavailable icon resolves to theme fallback');
        const savedColor = indicator._color;
        indicator._color = null;
        indicator._syncStyle();
        assert(indicator.actor.get_first_child().get_theme_node().get_background_color()
            .equal(findIcon()._dot.get_theme_node().get_background_color()), 'fallback uses the native theme color');
        indicator._color = savedColor;
        indicator._syncStyle();
    } finally {
        file.delete(null);
    }

    const context = St.ThemeContext.get_for_stage(global.stage);
    const originalScale = context.scale_factor;
    try {
        for (const scale of [1, 2]) {
            context.scale_factor = scale;
            for (const size of [0, 1, 2]) {
                settings.set_int('dock-icon-size', size);
                await settle();
                const iconBounds = new Map();
                for (const current of [false, true]) {
                    windows.forEach((window, index) => window.change_workspace(
                        current ? originalWorkspaces[index] : workspace));
                    await settle();
                    for (const dash of [dock.dash, dock.nativeDash]) {
                        if (dash === dock.nativeDash)
                            Main.overview.show();
                        await settle();
                        const icon = findIcon(dash);
                        const row = icon._pantheaIndicators.actor;
                        const [x, y] = row.get_transformed_position();
                        const [width, height] = row.get_transformed_size();
                        const [ix, iy] = icon.icon.icon.get_transformed_position();
                        const [iw, ih] = icon.icon.icon.get_transformed_size();
                        const [hx, hy] = icon.icon.get_transformed_position();
                        const [hw, hh] = icon.icon.get_transformed_size();
                        assert(Math.abs(width - (current ? 26 : 22) * scale) < 1 && Math.abs(height - 5 * scale) < 1 &&
                            Math.abs(x + width / 2 - ix - iw / 2) <= 0.5 * scale &&
                            y >= iy + ih && x >= hx && x + width <= hx + hw && y + height <= hy + hh,
                        `four ${current ? '5px colored' : '4px gray'} dots fit beneath ${dash === dock.dash ? 'desktop' : 'Overview'} icons at size ${dash.iconSize}, scale ${scale}`);
                        for (const dot of row.get_children().filter(child => child.visible)) {
                            const [, dy] = dot.get_transformed_position();
                            const [dw, dh] = dot.get_transformed_size();
                            assert(Math.abs(dw - (current ? 5 : 4) * scale) < 1 && Math.abs(dw - dh) < 1 &&
                                Math.abs(dy + dh - y - height) < 1, 'dots retain their size and shared bottom alignment');
                        }
                        if (current)
                            assert([ix, iy, iw, ih].every((value, index) =>
                                Math.abs(value - iconBounds.get(dash)[index]) <= 1),
                            'changing indicator size does not move or resize application icons');
                        else
                            iconBounds.set(dash, [ix, iy, iw, ih]);
                    }
                    Main.overview.hide();
                    await settle();
                }
            }
        }
    } finally {
        context.scale_factor = originalScale;
        settings.set_int('dock-icon-size', 1);
    }
    await settle();
    const stream = Gio.File.new_for_path(`${GLib.getenv('PANTHEA_TEST_OUTPUT')}/window-count-indicators.png`)
        .replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
    Main.overview.show();
    await settle();
    const overviewIcon = findIcon(dock.nativeDash);
    assert(overviewIcon._pantheaIndicators.count === 4 && overviewIcon._dot.opacity === 0 &&
        overviewIcon._pantheaIndicators._color === findIcon()._pantheaIndicators._color,
    'Overview bottom dock matches desktop counts and colors');
    settings.set_boolean('window-count-indicators', false);
    await settle();
    assert([findIcon(), overviewIcon].every(icon => icon._dot.opacity === 255 &&
        !icon._pantheaIndicators.actor.visible), 'off restores single dots in both docks while Overview is open');
    settings.set_boolean('window-count-indicators', true);
    await settle();
    assert([findIcon(), overviewIcon].every(icon => icon._dot.opacity === 0 &&
        icon._pantheaIndicators.actor.visible), 'on restores count dots in both docks while Overview is open');
    const grid = Main.overview._overview.controls._appDisplay;
    const gridIcons = grid.getAllItems().filter(icon => icon.app);
    assert(gridIcons.length > 0 && gridIcons.every(icon => !icon._pantheaIndicators && icon._dot.opacity === 255 &&
        !icon._iconContainer.get_children().some(child => child.has_style_class_name('panthea-window-indicators'))),
    'Overview application-grid tiles retain native single dots');
    const overviewStream = Gio.File.new_for_path(`${GLib.getenv('PANTHEA_TEST_OUTPUT')}/overview-window-count-indicators.png`)
        .replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    await new Shell.Screenshot().screenshot(false, overviewStream);
    overviewStream.close(null);
    Main.overview.hide();
    // The helper is window-backed and cannot be pinned as a favorite. Keep a
    // separate native item to inspect the zero-window state after Dash removes it.
    const retainedItem = dock.dash._createAppItem(app);
    Main.uiGroup.add_child(retainedItem);
    retainedItem.hide();
    const retained = retainedItem.child._pantheaIndicators;
    for (let remaining = 4; remaining >= 0; remaining--) {
        windows.pop().delete(global.get_current_time());
        await settle();
        assert(retained.count === Math.min(remaining, 4) &&
            retained.actor.visible === (remaining > 0),
        `closing windows updates dots to ${Math.min(remaining, 4)}`);
        if (remaining > 0)
            assert(findIcon(dock.nativeDash)._pantheaIndicators.count === Math.min(remaining, 4),
                'Overview dock follows window closures');
    }
    Main.overview.show();
    await settle();
    assert(!dock._nativeIndicators.has(overviewIcon) && overviewIcon._pantheaIndicators === undefined,
        'removed Overview app icons release their indicator');
    Main.overview.hide();
    retainedItem.destroy();
    const oldIndicator = icons(dock.dash)[0]._pantheaIndicators;
    const nativeIcons = icons(dock.nativeDash);
    const nativeIndicators = nativeIcons.map(icon => icon._pantheaIndicators);
    instance.disable();
    assert(oldIndicator._source === null && !oldIndicator._signals._connections.length &&
        !oldIndicator._windows._connections.length, 'disable releases indicator actors and signals');
    assert(dock._nativeIndicators.size === 0 && nativeIcons.every(icon => !icon._pantheaIndicators && icon._dot.opacity === 255) &&
        nativeIndicators.every(dots => dots._source === null && !dots._signals._connections.length &&
            !dots._windows._connections.length), 'disable removes Overview indicators and restores native dot opacity');
    instance.enable();
    await settle();
    assert(instance._dock && settings.get_boolean('window-count-indicators'), 're-enable preserves indicator preference');
    assert(icons(instance._dock.nativeDash).every(icon => icon._pantheaIndicators && icon._dot.opacity === 0),
        're-enable attaches indicators to existing Overview dock icons');
}
