// SPDX-License-Identifier: GPL-3.0-or-later
import St from 'gi://St';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export {init} from './shell.js';
export const METRICS = {};

function assert(value, message) {
    if (!value)
        throw new Error(`Panthea dock: ${message}`);
    print(`PASS: ${message}`);
}

async function settle() {
    await Scripting.sleep(350);
    await Scripting.waitLeisure();
}

function bounds(actor) {
    return [...actor.get_transformed_position(), ...actor.get_transformed_size()];
}

function matchingBounds(actor, expected, message) {
    const actual = bounds(actor);
    assert(actual.every((value, index) => Math.abs(value - expected[index]) <= 1),
        `${message}: ${actual} matches ${expected}`);
}

async function checkHandoff(dock, desktop, overview, action, message, animated = false) {
    const frames = [];
    const adjustment = Main.overview._overview.controls._stateAdjustment;
    const id = global.stage.connect('after-paint', () => {
        if (dock.nativeDash.mapped) {
            const items = dock.nativeDash._box.get_children().filter(item =>
                item.child?._delegate?.icon && !item.animatingOut);
            if (dock.nativeDash._showAppsIcon.visible)
                items.push(dock.nativeDash._showAppsIcon);
            frames.push({progress: Math.clamp(adjustment.value, 0, 1),
                rect: bounds(dock.nativeDash._background),
                desktop: dock.dash.visible ? bounds(dock.background) : null,
                desktopOpacity: dock.dash.visible ? dock.actor.opacity : 0,
                nativeOpacity: dock.nativeDash._dashContainer.opacity,
                aspects: items.map(item => {
                    const texture = item.child._delegate.icon.icon;
                    const [, , width, height] = bounds(texture);
                    return width / height / (texture.width / texture.height);
                }),
                sizes: items.map(item => {
                    const icon = item.child._delegate.icon;
                    const [width] = icon.icon.get_transformed_size();
                    return width - icon.iconSize * St.ThemeContext.get_for_stage(global.stage).scale_factor;
                })});
        }
    });
    try {
        await action();
        await settle();
    } finally {
        global.stage.disconnect(id);
    }
    const badFrame = frames.find(frame =>
        frame.rect.some((value, index) => !Number.isFinite(value) || Math.abs(value - overview[index]) > 1) ||
        (frame.desktop && frame.desktop.some((value, index) => Math.abs(value - desktop[index]) > 1)));
    const instantExit = !St.Settings.get().enable_animations && !dock.nativeDash.mapped && dock.dash.visible;
    assert((frames.length > 0 || instantExit) && !badFrame,
        `${message}: neither dock moves or resizes${badFrame ? `: ${JSON.stringify({desktop, overview, badFrame})}` : ''}`);
    assert(frames.every(frame => frame.desktopOpacity === 0 || frame.nativeOpacity === 0),
        `${message}: no overlapping/doubled icon rows`);
    assert(frames.every(frame => {
        const progress = St.Settings.get().enable_animations ? frame.progress : 1;
        return Math.abs(frame.desktopOpacity - Math.round(255 * Math.clamp((0.5 - progress) / 0.25, 0, 1))) <= 1 &&
            Math.abs(frame.nativeOpacity - Math.round(255 * Math.clamp((progress - 0.5) / 0.25, 0, 1))) <= 1;
    }), `${message}: opacity follows progress without a separate animation`);
    assert(frames.every(frame => frame.sizes.every(delta => Math.abs(delta) <= 1)),
        `${message}: icons stay at their natural sizes`);
    assert(frames.every(frame => frame.aspects.every(ratio => Math.abs(ratio - 1) < 0.01)),
        `${message}: icons keep their aspect ratio on every painted frame`);
    if (animated && St.Settings.get().enable_animations) {
        assert(frames.some(frame =>
            (frame.desktopOpacity > 0 && frame.desktopOpacity < 255) ||
            (frame.nativeOpacity > 0 && frame.nativeOpacity < 255)),
        `${message}: intermediate opacity is painted`);
    }
    assert(dock.actor.opacity === (Main.overview.visible ? 0 : 255) &&
        dock.nativeDash._dashContainer.opacity === 255,
    `${message}: endpoint opacities are restored`);
}

async function checkDifferentGeometry(dock, label) {
    const background = dock.nativeDash._background;
    const savedStyle = background.get_style();
    const keyboard = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    try {
        // Deliberately different padding/margins expose handoff bugs that a
        // matching settled-size test cannot detect.
        background.set_style('padding: 12px 16px; margin-bottom: 20px;');
        Main.overview.show();
        await settle();
        const overview = bounds(background);
        Main.overview.hide();
        await settle();
        const desktop = bounds(dock.background);
        assert(desktop.some((value, index) => Math.abs(value - overview[index]) > 2),
            `${label}: desktop and Overview really have different bounds`);
        await checkHandoff(dock, desktop, overview, () => {
            keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Super_L, Clutter.KeyState.PRESSED);
            keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Super_L, Clutter.KeyState.RELEASED);
        }, `${label}: keyboard entry`, true);
        assert(Main.overview.visible, 'Super opens Overview');
        await checkHandoff(dock, desktop, overview, () => Main.overview.hide(), `${label}: exit`, true);
        matchingBounds(dock.background, desktop, `${label}: desktop endpoint`);
        await checkHandoff(dock, desktop, overview, () => Main.overview.showApps(), `${label}: Show Apps entry`, true);
        Main.overview.hide();
        await settle();

        // Drive the same native handlers as the swipe tracker, including
        // reversing before release and cancelling to either endpoint.
        let captured = false;
        const gesture = async (values, end) => {
            const record = !captured && label === 'size 1, scale 1' && GLib.getenv('PANTHEA_TEST_OUTPUT');
            let frame = 0;
            const tracker = {confirmSwipe() {}};
            Main.overview._gestureBegin(tracker);
            for (const value of values) {
                Main.overview._gestureUpdate(tracker, value);
                await Scripting.sleep(40);
                if (record) {
                    const stream = Gio.File.new_for_path(`${record}/dock-dissolve-${String(frame++).padStart(2, '0')}.png`)
                        .replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                    await new Shell.Screenshot().screenshot(false, stream);
                    stream.close(null);
                    captured = true;
                }
            }
            Main.overview._gestureEnd(tracker, 100, end);
        };
        const entry = label === 'size 1, scale 1'
            ? [0.1, 0.25, 0.375, 0.5, 0.625, 0.75, 0.9, 0.6, 0.3] : [0.2, 0.6, 0.3];
        await checkHandoff(dock, desktop, overview, () => gesture(entry, 0),
            `${label}: reversed/cancelled entry`);
        assert(!Main.overview.visible && dock.dash.visible, 'cancelled entry restores desktop');
        await checkHandoff(dock, desktop, overview, () => gesture([0.2, 0.6, 0.9], 1),
            `${label}: completed entry gesture`);
        await checkHandoff(dock, desktop, overview, () => gesture([0.8, 0.4, 0.7], 1),
            `${label}: reversed/cancelled exit`);
        assert(Main.overview.visible && !dock.dash.visible, 'cancelled exit restores Overview');
        await checkHandoff(dock, desktop, overview, () => gesture([0.8, 0.4, 0.1], 0),
            `${label}: completed exit gesture`);
    } finally {
        Main.overview.hide();
        background.set_style(savedStyle);
        keyboard.run_dispose();
        await settle();
    }
}

async function checkFadeInput(dock) {
    const pointer = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const click = async rect => {
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), rect[0] + rect[2] / 2, rect[1] + rect[3] / 2);
        await Scripting.sleep(30);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await Scripting.sleep(40);
    };
    const button = dock.dash.showAppsButton;
    const rect = bounds(button);
    let clicked = false;
    const id = button.connect('clicked', () => { clicked = true; });
    const tracker = {confirmSwipe() {}};
    try {
        Main.overview._gestureBegin(tracker);
        Main.overview._gestureUpdate(tracker, 0.375);
        await Scripting.sleep(40);
        if (St.Settings.get().enable_animations)
            assert(dock.dash.visible && dock.actor.opacity > 0 && dock.actor.opacity < 255,
                'input check runs while the desktop dock is fading');
        await click(rect);
        assert(!clicked, 'fading desktop buttons cannot activate in Overview');
    } finally {
        button.disconnect(id);
        Main.overview._gestureEnd(tracker, 100, 0);
        await settle();
    }
    try {
        Main.overview.show();
        await settle();
        await click(bounds(dock.nativeDash.showAppsButton));
        await settle();
        assert(Main.overview._overview.controls._stateAdjustment.value === 2,
            'native Show Apps remains clickable after the handoff');
    } finally {
        Main.overview.hide();
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 0, 100);
        await settle();
        pointer.run_dispose();
    }
}

export async function run() {
    await Scripting.disableHelperAutoExit();
    Main.overview.hide();
    await settle();
    const extension = Main.extensionManager.lookup('panthea@local');
    const {_dock: dock, _settings: settings} = extension.stateObj;
    const context = St.ThemeContext.get_for_stage(global.stage);
    const originalScale = context.scale_factor;
    const favorites = global.settings.get_strv('favorite-apps');
    try {
        for (const scale of [1, 2]) {
            context.scale_factor = scale;
            for (const size of [0, 2, 1]) {
                for (const showApps of [true, false]) {
                    settings.set_int('dock-icon-size', size);
                    settings.set_boolean('show-apps-button', showApps);
                    await settle();
                    const background = bounds(dock.background);
                    const icon = dock.dash._box.get_first_child().child.icon.icon;
                    const iconBounds = bounds(icon);
                    for (const apps of [false, true]) {
                        if (apps)
                            Main.overview.showApps();
                        else
                            Main.overview.show();
                        await settle();
                        assert(dock.nativeDash.iconSize === dock.dash.iconSize,
                            `matching icon size, scale ${scale}, size ${size}, Show Apps ${showApps}`);
                        matchingBounds(dock.nativeDash._background, background, 'Overview background');
                        matchingBounds(dock.nativeDash._box.get_first_child().child.icon.icon,
                            iconBounds, 'Overview first icon');
                        Main.overview.hide();
                        await settle();
                        matchingBounds(dock.background, background, 'desktop background restored');
                    }
                }
            }
        }
        settings.set_boolean('show-apps-button', true);
        for (const scale of [1, 2]) {
            context.scale_factor = scale;
            for (const size of [0, 2, 1]) {
                settings.set_int('dock-icon-size', size);
                await settle();
                await checkDifferentGeometry(dock, `size ${size}, scale ${scale}`);
            }
        }
        context.scale_factor = originalScale;
        await settle();
        await checkFadeInput(dock);
        global.settings.set_strv('favorite-apps', Shell.AppSystem.get_default().get_installed()
            .filter(app => app.should_show())
            .slice(0, 30).map(app => app.get_id()));
        settings.set_int('dock-icon-size', 2);
        await settle();
        const crowded = bounds(dock.background);
        const frames = [];
        const paintId = global.stage.connect('after-paint', () => {
            if (dock.nativeDash.mapped)
                frames.push(bounds(dock.nativeDash._background));
        });
        try {
            Main.overview.show();
            await settle();
        } finally {
            global.stage.disconnect(paintId);
        }
        assert(frames.length > 0 && frames.every(frame =>
            frame.every((value, index) => Math.abs(value - crowded[index]) <= 1)),
        'Overview entry keeps background bounds stable on every painted frame');
        matchingBounds(dock.nativeDash._background, crowded, 'crowded Overview dock');
        assert(dock.dash.iconSize < 64, 'crowded docks shrink icons together');
        Main.overview.hide();
        await settle();
        await checkDifferentGeometry(dock, 'crowded dock');
        Main.overview.show();
        await settle();
        const output = GLib.getenv('PANTHEA_TEST_OUTPUT');
        if (output) {
            const stream = Gio.File.new_for_path(`${output}/dock-aligned-overview.png`)
                .replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            await new Shell.Screenshot().screenshot(false, stream);
            stream.close(null);
        }
        for (const size of [0, 2, 1]) {
            settings.set_int('dock-icon-size', size);
            await settle();
            const overview = bounds(dock.nativeDash._background);
            Main.overview.hide();
            await settle();
            matchingBounds(dock.background, overview, 'live Overview size change matches desktop');
            Main.overview.show();
            await settle();
        }
        for (const mode of ['unused', 'focused-maximized', 'focused-overlap', 'any-overlap', 'never']) {
            settings.set_string('dock-hide-mode', mode);
            await settle();
            assert(dock.nativeDash.mapped && !dock.dash.visible, `${mode}: only Overview dock is visible`);
            const overview = bounds(dock.nativeDash._background);
            Main.overview.hide();
            settings.set_string('dock-hide-mode', 'never');
            await settle();
            matchingBounds(dock.background, overview, `${mode}: revealed desktop matches Overview`);
            Main.overview.show();
            await settle();
        }
    } finally {
        Main.overview.hide();
        context.scale_factor = originalScale;
        global.settings.set_strv('favorite-apps', favorites);
    }
    settings.set_int('dock-icon-size', 0);
    await settle();
    Main.overview.show();
    await settle();
    const constrainedSize = dock.nativeDash.iconSize;
    const nativeDash = dock.nativeDash;
    const actors = [nativeDash, nativeDash._background, nativeDash._dashContainer];
    const transforms = actors.map(actor =>
        [actor.scale_x, actor.scale_y, actor.translation_x, actor.translation_y]);
    const tracker = {confirmSwipe() {}};
    Main.overview._gestureBegin(tracker);
    Main.overview._gestureUpdate(tracker, 0.5);
    await Scripting.sleep(40);
    await Main.extensionManager.disableExtension('panthea@local');
    await settle();
    assert(actors.every((actor, i) => [actor.scale_x, actor.scale_y, actor.translation_x, actor.translation_y]
        .every((value, j) => value === transforms[i][j])), 'disabling mid-gesture restores native transforms');
    assert(nativeDash._background.opacity === 255 && nativeDash._dashContainer.opacity === 255,
        'disabling mid-gesture restores native opacities');
    assert(dock._transition._signals._connections.length === 0, 'disable disconnects all handoff signals');
    Main.overview._gestureEnd(tracker, 100, 0);
    await settle();
    assert(!Main.overview.dash.has_style_class_name('panthea-dash'), 'native Dash styling restored');
    Main.overview.show();
    await settle();
    assert(Main.overview.dash.iconSize > constrainedSize, 'native Dash sizing restored');
    Main.overview.hide();
    await Main.extensionManager.enableExtension('panthea@local');
    await settle();
    assert(extension.stateObj._dock, 'dock re-enables cleanly');
}
