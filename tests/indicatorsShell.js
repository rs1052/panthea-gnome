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
    assert(findIcon()._pantheaIndicators.count === 4, 'minimized local windows count, other-workspace windows do not');
    const originalWorkspace = global.workspace_manager.get_active_workspace();
    windows[1].change_workspace(originalWorkspace);
    await settle();
    // Keep this empty workspace available while testing a switch away and back.
    Main.wm.keepWorkspaceAlive(originalWorkspace, 15000);
    const originalWorkspaces = windows.map(window => window.get_workspace());
    const workspaceIndicators = [dock.dash, dock.nativeDash].map(dash => findIcon(dash)._pantheaIndicators);
    const originalColors = workspaceIndicators.map(dots => dots._color);
    const checkWorkspace = (current, message, count = 1) => {
        for (const dots of workspaceIndicators) {
            assert(dots.onCurrentWorkspace === current && dots.actor.opacity === 255 &&
                dots.count === count && dots.actor.get_children().filter(dot => dot.visible).length === count,
            `${message}: matching workspace presence, opacity, and ${count} visible dots`);
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
                color.red === 136 && color.green === 136 && color.blue === 136 && color.alpha === 255,
            `${message}: ${current ? 'full icon color' : 'opaque neutral gray'}`);
        }
    };
    try {
        for (const dots of workspaceIndicators) {
            dots._color = 'rgb(230,80,80)';
            dots._syncStyle();
        }
        checkWorkspace(true, 'local window counts are capped at four full-color dots', 4);
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
                    assert(color.red === 136 && color.green === 136 && color.blue === 136 && color.alpha === 255,
                        `${appearance}: remote dots use fully opaque #888888`);
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
        checkWorkspace(true, 'one minimized local window shows one dot despite four windows elsewhere');
        await screenshot('indicator-workspace-one-local');
        windows[2].change_workspace(originalWorkspace);
        await settle();
        checkWorkspace(true, 'two local windows show two dots despite three windows elsewhere', 2);
        await screenshot('indicator-workspace-two-local');
        windows[2].change_workspace(workspace);
        windows[0].change_workspace(workspace);
        await settle();
        checkWorkspace(false, 'moving the last local window away makes the dots smaller and gray');
        workspace.activate(global.get_current_time());
        await settle();
        checkWorkspace(true, 'switching to the app workspace restores full color and local count', 4);
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
    // Exercise installed icons through the same theme lookup and decoder as the dock.
    for (const [id, expected] of [
        ['com.brave.Origin.desktop', 'neutral'],
        ['org.gnome.clocks.desktop', 'red'],
        ['com.brave.Browser.desktop', 'color'],
        ['org.gnome.Nautilus.desktop', 'blue'],
        ['org.gnome.Ptyxis.desktop', 'blue'],
        ['com.microsoft.VSCode.desktop', 'blue'],
        ['discord.desktop', 'blue'],
        ['org.gnome.Software.desktop', 'color'],
        ['org.gnome.Calculator.desktop', 'color'],
        ['org.mozilla.firefox.desktop', 'color'],
    ]) {
        const app = Gio.DesktopAppInfo.new(id);
        if (!app) {
            print(`SKIP: installed icon color for ${id}: app not installed`);
            continue;
        }
        const color = await colors.get(app.get_icon());
        const rgb = color?.match(/^rgb\((\d+),(\d+),(\d+)\)$/)?.slice(1).map(Number);
        assert(expected === 'neutral' ? color === null :
            rgb?.length === 3 && rgb.every(channel => channel >= 0 && channel <= 255),
            `${id}: installed icon produces valid RGB (${color})`);
        const [red, green, blue] = rgb ?? [];
        if (expected === 'neutral')
            assert(color === null, `${id}: monochrome icon uses theme fallback`);
        else if (expected === 'red')
            assert(red > green && red > blue, `${id}: red hand wins over muted clock face`);
        else if (expected === 'blue')
            assert(blue > red && blue > green, `${id}: blue icon retains a blue accent`);
        else
            assert(Math.max(...rgb) - Math.min(...rgb) >= 100,
                `${id}: colored icon retains a chromatic accent`);
        if (expected === 'neutral' || expected === 'red') {
            const texture = findIcon().icon.icon;
            const originalIcon = texture.gicon;
            try {
                texture.gicon = app.get_icon();
                await indicator._readColor();
                await settle();
                const rendered = indicator.actor.get_first_child().get_theme_node().get_background_color();
                assert(expected === 'neutral' ?
                    rendered.equal(findIcon()._dot.get_theme_node().get_background_color()) :
                    rendered.red === red && rendered.green === green && rendered.blue === blue,
                    `${id}: rendered active dots match the extracted accent`);
                await screenshot(`indicator-accent-${expected}`);
            } finally {
                texture.gicon = originalIcon;
                await indicator._readColor();
            }
        }
    }
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
        for (const dash of [dock.dash, dock.nativeDash]) {
            const dots = findIcon(dash)._pantheaIndicators;
            const savedColor = dots._color;
            const classes = ['panthea-dark-dock', 'panthea-light-dock'];
            const original = classes.filter(name => dash.has_style_class_name(name));
            try {
                dots._color = null;
                for (const appearance of classes) {
                    for (const name of classes)
                        dash.remove_style_class_name(name);
                    dash.add_style_class_name(appearance);
                    await settle();
                    dots._syncStyle();
                    const rendered = dots.actor.get_first_child().get_theme_node().get_background_color();
                    const channel = appearance === 'panthea-light-dock' ? 51 : 255;
                    assert(rendered.red === channel && rendered.green === channel &&
                        rendered.blue === channel && rendered.alpha === 255,
                    `${appearance}: monochrome dots follow the native theme color in both docks`);
                }
            } finally {
                for (const name of classes)
                    dash.remove_style_class_name(name);
                for (const name of original)
                    dash.add_style_class_name(name);
                dots._color = savedColor;
                dots._syncStyle();
            }
        }
    } finally {
        file.delete(null);
    }

    const context = St.ThemeContext.get_for_stage(global.stage);
    const originalScale = context.scale_factor;
    const workspaceControls = settings.get_boolean('workspace-controls');
    // Workspace tiles can recenter the whole dock as windows move. Isolate
    // indicator geometry from those independent layout changes.
    settings.set_boolean('workspace-controls', false);
    await settle();
    try {
        for (const scale of [1, 2]) {
            // Refresh the helper's 30-second idle timeout during this long suite.
            await Scripting.waitTestWindows();
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
                        assert(Math.abs(width - (current ? 26 : 4) * scale) < 1 && Math.abs(height - 5 * scale) < 1 &&
                            Math.abs(x + width / 2 - ix - iw / 2) <= 0.5 * scale &&
                            y >= iy + ih && x >= hx && x + width <= hx + hw && y + height <= hy + hh,
                        `${current ? 'four 5px colored dots' : 'one 4px gray dot'} fit beneath ${dash === dock.dash ? 'desktop' : 'Overview'} icons at size ${dash.iconSize}, scale ${scale}`);
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
        settings.set_boolean('workspace-controls', workspaceControls);
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
