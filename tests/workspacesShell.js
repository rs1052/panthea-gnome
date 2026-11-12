// SPDX-License-Identifier: GPL-3.0-or-later
// Run only in the isolated Shell supplied by scripts/panthea test.
import Clutter from 'gi://Clutter';
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
        throw new Error(`Panthea workspaces: ${message}`);
    print(`PASS: ${message}`);
}

async function settle() {
    await Scripting.sleep(350);
    await Scripting.waitLeisure();
}

export async function run() {
    await Scripting.disableHelperAutoExit();
    Main.overview.hide();
    await settle();
    const extension = Main.extensionManager.lookup('panthea@local');
    const dock = extension.stateObj._dock;
    const model = dock._workspaces;
    const manager = global.workspace_manager;
    const mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
    const preferences = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
    const views = [dock.dash.workspaces, dock._nativeWorkspaces];
    const entry = workspace => model.entries.find(item => item.workspace === workspace);
    const button = (workspace, view = views[0]) => view._items.get(workspace);
    const first = manager.get_workspace_by_index(0);
    const second = manager.get_workspace_by_index(1);
    first.activate(global.get_current_time());
    await settle();
    assert(views.every(view => view.count === 1 && !view._items.has(first)),
        'a single empty regular workspace shows only New Workspace in both docks');
    const plus = button(second).icon.icon;
    assert(plus.get_first_child().icon_name === 'list-add-symbolic' &&
        plus.get_first_child().icon_size === Math.floor(dock.dash.iconSize / 2),
    'New Workspace has a centered half-size plus inside a full-size tile');
    assert(button(second)._labelText === 'New Workspace', 'plus tooltip is just New Workspace');
    const output = GLib.getenv('PANTHEA_TEST_OUTPUT');
    if (output) {
        const stream = Gio.File.new_for_path(`${output}/workspace-plus-only.png`)
            .replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
    }
    assert(model.entries.at(-1).isNew && model.entries.filter(item => item.isNew).length === 1,
        'only the trailing dynamic workspace is represented by New Workspace');
    assert(views.every(view => view.actor.get_parent() !== dock.dash._box &&
        !view._box.get_children().some(item => item.child?._delegate?.app)),
    'workspace controls are outside the native application list and have no app drag delegate');

    const windows = [];
    await Scripting.createTestWindow({width: 300, height: 200});
    await Scripting.waitTestWindows();
    await settle();
    assert(views.every(view => view.count === 2 && button(first, view)?.entry.windows.length === 1 &&
        button(first, view).icon.icon.get_n_children() === 1 && button(second, view).entry.isNew),
    'opening the first app reveals its workspace tile alongside New Workspace in both docks');
    entry(first).windows[0].window.delete(global.get_current_time());
    await settle();
    assert(views.every(view => view.count === 1 && !view._items.has(first)),
        'closing the last app hides the single empty workspace tile in both docks');
    for (let i = 0; i < 6; i++) {
        await Scripting.createTestWindow({width: 300, height: 200});
        await Scripting.waitTestWindows();
    }
    await settle();
    const helperWindows = global.get_window_actors().map(actor => actor.meta_window)
        .filter(window => /perf-?helper/i.test(window.get_wm_class() ?? ''));
    windows.push(...helperWindows.slice(0, 5));
    const otherWindow = helperWindows[5];
    assert(views.every(view => view.count === 2 && view._items.has(first)),
        'opening more windows retains the single populated workspace tile');
    const controlsSettings = extension.stateObj._settings;
    controlsSettings.set_boolean('workspace-controls', false);
    await settle();
    assert(views.every(view => !view.actor.visible && view.count === 0),
        'disabling Workspace Controls removes all tiles and the separator from both docks');
    assert(entry(first).windows.length === 6 && manager.n_workspaces === 2,
        'hiding workspace controls preserves windows and native workspace state');
    controlsSettings.set_boolean('workspace-controls', true);
    await settle();
    assert(views.every(view => view.actor.visible && view.count === 2 &&
        button(first, view).entry.windows.length === 6 && button(second, view).entry.isNew),
    'enabling Workspace Controls restores populated tiles and New Workspace live in both docks');
    otherWindow.change_workspace(second);
    await settle();
    assert(views.every(view => view.count === manager.n_workspaces),
        'adding a second regular workspace reveals workspace tiles in both docks');
    assert(windows.length === 5 && entry(first).windows.length === 5,
        'five windows appear on their workspace');
    assert(entry(first).windows.every(item => item.app === entry(first).windows[0].app),
        'multiple windows of the same application remain separate icons');
    assert(button(first).icon.icon.get_n_children() === 4 &&
        button(first).icon.icon.get_last_child().text === '+2', 'tile bounds icons and reports overflow');
    assert(button(first)._labelText === 'Workspace 1 (current)' &&
        button(first).button.accessible_name === 'Workspace 1 (current)' &&
        button(second)._labelText === 'Workspace 2',
    'workspace labels contain only the number and optional current marker');
    button(first).update({...entry(first), windows: [{window: windows[0], app: null}]});
    assert(button(first)._labelText === 'Workspace 1 (current)', 'window count changes do not change the tooltip');
    assert(button(first).icon.icon.get_first_child().icon_name === 'application-x-executable',
        'an unidentified application uses a generic icon');
    button(first).update(entry(first));
    for (const [index, dash] of [dock.dash, dock.nativeDash].entries()) {
        const view = views[index];
        const classes = ['panthea-dark-dock', 'panthea-light-dock'];
        const original = classes.filter(name => dash.has_style_class_name(name));
        const current = button(first, view);
        const inactive = button(second, view);
        try {
            for (const appearance of classes) {
                for (const name of classes)
                    dash.remove_style_class_name(name);
                dash.add_style_class_name(appearance);
                current.button.add_style_pseudo_class('hover');
                inactive.button.add_style_pseudo_class('hover');
                await settle();
                const selected = current.icon.icon.get_theme_node().get_background_color();
                const hovered = inactive.icon.icon.get_theme_node().get_background_color();
                const brightness = color => ((color.red + color.green + color.blue) / 3 * color.alpha +
                    128 * (255 - color.alpha)) / 255;
                assert(selected.alpha >= 160 && brightness(selected) > brightness(hovered) + 25,
                    `${appearance}, view ${index}: current tile is clearly lighter than hovered tiles`);
                const foreground = current.icon.icon.get_theme_node().get_foreground_color();
                assert(foreground.red < 80 && foreground.green < 80 && foreground.blue < 80,
                    `${appearance}, view ${index}: lightened tile keeps a readable dark foreground`);
            }
        } finally {
            current.button.remove_style_pseudo_class('hover');
            inactive.button.remove_style_pseudo_class('hover');
            for (const name of classes)
                dash.remove_style_class_name(name);
            for (const name of original)
                dash.add_style_class_name(name);
        }
    }
    const sequence = entry(first).windows.map(item => item.window.get_stable_sequence()).join(',');
    windows[0].minimize();
    windows[1].activate(global.get_current_time());
    await settle();
    assert(entry(first).windows.length === 5 &&
        entry(first).windows.map(item => item.window.get_stable_sequence()).join(',') === sequence,
    'minimized windows remain listed and focus does not reorder icons');
    windows[0].change_workspace(second);
    await settle();
    assert(entry(first).windows.length === 4 && entry(second).windows.some(item => item.window === windows[0]),
        'moving a window updates both workspace groups');
    windows[1].stick();
    await settle();
    assert(model.entries.every(item => item.windows.some(window => window.window === windows[1])),
        'sticky windows appear on all workspaces');
    windows[1].unstick();
    await settle();
    const seat = global.stage.context.get_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const [buttonX, buttonY] = button(second).button.get_transformed_position();
    const [buttonWidth, buttonHeight] = button(second).button.get_transformed_size();
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), buttonX + buttonWidth / 2, buttonY + buttonHeight / 2);
    await Scripting.sleep(40);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await settle();
    assert(manager.get_active_workspace() === second && !Main.overview.visible,
        'clicking another workspace switches without opening Overview');
    assert(views.every(view => button(second, view).button.has_style_pseudo_class('checked')),
        'both views highlight the active workspace');
    assert(views.every(view => button(second, view)._labelText === 'Workspace 2 (current)' &&
        button(first, view)._labelText === 'Workspace 1'), 'current marker follows workspace activation in both docks');
    button(second).button.grab_key_focus();
    keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_space, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_space, Clutter.KeyState.RELEASED);
    await settle();
    assert(Main.overview.visible, 'keyboard activation of the active workspace opens Overview');
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), 0, 100);
    pointer.run_dispose();
    keyboard.run_dispose();
    button(first, views[1]).button.emit('clicked', Clutter.BUTTON_PRIMARY);
    await settle();
    assert(manager.get_active_workspace() === first && Main.overview.visible,
        'Overview workspace switching keeps Overview open');
    button(first, views[1]).button.emit('clicked', Clutter.BUTTON_PRIMARY);
    await settle();
    assert(!Main.overview.visible, 'active workspace in Overview returns to the desktop');
    const trailing = model.entries.at(-1).workspace;
    button(trailing).button.emit('clicked', Clutter.BUTTON_PRIMARY);
    await settle();
    assert(manager.get_active_workspace() === trailing && mutter.get_boolean('dynamic-workspaces'),
        'New Workspace activates the existing trailing workspace without changing workspace mode');
    assert(button(trailing)._labelText === 'New Workspace', 'active plus tooltip still says only New Workspace');

    mutter.set_boolean('dynamic-workspaces', false);
    preferences.set_int('num-workspaces', 12);
    await settle();
    assert(model.entries.length === 12 && model.entries.every(item => !item.isNew),
        'fixed mode shows every configured workspace and no New Workspace button');
    assert(button(manager.get_workspace_by_index(11)).icon.icon.get_n_children() === 0,
        'empty workspaces use a quiet blank tile instead of a large placeholder symbol');
    preferences.set_strv('workspace-names', ['Writing']);
    await settle();
    assert(entry(first).name === 'Writing' && button(first)._labelText === 'Workspace 1',
        'tooltips use workspace numbers rather than custom names');

    const context = St.ThemeContext.get_for_stage(global.stage);
    const originalScale = context.scale_factor;
    const settings = extension.stateObj._settings;
    settings.set_string('dock-hide-mode', 'unused');
    button(manager.get_active_workspace()).button.grab_key_focus();
    await settle();
    assert(!dock._hiding.hidden, 'keyboard focus on a workspace tile keeps the automatic dock revealed');
    global.stage.set_key_focus(null);
    settings.set_string('dock-hide-mode', 'never');
    for (const scale of [1, 2]) {
        context.scale_factor = scale;
        for (const size of [0, 1, 2]) {
            settings.set_int('dock-icon-size', size);
            await settle();
            assert(views.every(view => [...view._items.values()].every(item =>
                item.icon.iconSize === dock.dash.iconSize)), `workspace tiles follow dock size ${size}, scale ${scale}`);
            assert(Math.abs(button(first).icon.icon.width - dock.dash.iconSize * scale) <= 1,
                `miniature icon grid follows physical scale ${scale}`);
        }
    }
    context.scale_factor = originalScale;
    preferences.set_int('num-workspaces', 36);
    await settle();
    const last = manager.get_workspace_by_index(35);
    global.stage.set_key_focus(null);
    last.activate(global.get_current_time());
    await settle();
    Main.overview.show();
    await settle();
    Main.overview.hide();
    await settle();
    assert(views.every(view => view.scroll.hadjustment.upper > view.scroll.hadjustment.page_size),
        `crowded workspace sections are bounded and scrollable: ${views.map(view =>
            [view.scroll.hadjustment.upper, view.scroll.hadjustment.page_size])}`);
    const activeAdjustment = views[0].scroll.hadjustment;
    const [activeX] = button(last).get_position();
    assert(activeX >= activeAdjustment.value - 1 &&
        activeX + button(last).width <= activeAdjustment.value + activeAdjustment.page_size + 1,
    'active workspace remains visible in the overflow strip');
    button(last).button.grab_key_focus();
    await settle();
    const adjustment = views[0].scroll.hadjustment;
    const [x] = button(last).get_position();
    assert(x >= adjustment.value - 1 && x + button(last).width <= adjustment.value + adjustment.page_size + 1,
        'focused workspace remains visible in the overflow strip');
    if (output) {
        first.activate(global.get_current_time());
        preferences.set_int('num-workspaces', 4);
        await settle();
        const stream = Gio.File.new_for_path(`${output}/workspace-buttons.png`)
            .replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
    }
    for (const window of [...windows, otherWindow])
        window.delete(global.get_current_time());
    await settle();
    assert(model.entries.every(item => item.windows.length === 0), 'closed windows release workspace icons');
    const {WorkspaceButtons} = await import(`${extension.dir.get_uri()}/lib/workspaceButtons.js`);
    for (const dash of [dock.dash, dock.nativeDash]) {
        const view = new WorkspaceButtons(dash, model, settings);
        const items = [...view._items.values()];
        // Shell destroys actor hierarchies without calling the view's destroy().
        view.actor.destroy();
        assert(view.actor === null && !view._signals._connections.length && !view.count,
            'actor destruction disconnects workspace view listeners and releases items');
        assert(items.every(item => !item._labelId && !item._signals._connections.length),
            'actor destruction clears workspace button tooltip timers and listeners');
        model.emit('changed');
        view.destroy();
    }
    const nativeContainer = dock.nativeDash._dashContainer;
    await Main.extensionManager.disableExtension('panthea@local');
    await settle();
    assert(!nativeContainer.get_children().some(actor => actor.has_style_class_name('panthea-workspaces')),
        'disable removes workspace controls from the native Dash');
    assert(!model._signals._connections.length && !model._workspaceSignals._connections.length &&
        !model._windows.size && !model._updateId, 'disable releases model signals, windows, and idle work');
    const {Dock} = await import(`${extension.dir.get_uri()}/lib/dock.js`);
    const nativeChildren = nativeContainer.get_children();
    const chromeCount = Main.layoutManager._trackedActors.length;
    class FailingDock extends Dock {
        _updateSize() {
            throw new Error('workspace initialization test');
        }
    }
    let failed = false;
    try {
        new FailingDock(settings);
    } catch (error) {
        failed = error.message === 'workspace initialization test';
    }
    assert(failed && nativeContainer.get_children().every((actor, i) => actor === nativeChildren[i]) &&
        nativeContainer.get_n_children() === nativeChildren.length &&
        Main.layoutManager._trackedActors.length === chromeCount &&
        !Main.overview.dash.has_style_class_name('panthea-dash'),
    'partial initialization failure removes owned controls and restores the native Dash');
    await Main.extensionManager.enableExtension('panthea@local');
    await settle();
    assert(extension.stateObj._dock._workspaces.entries.length === manager.n_workspaces,
        'workspace controls re-enable cleanly in fixed mode');
    mutter.set_boolean('dynamic-workspaces', true);
    await settle();
    assert(extension.stateObj._dock._workspaces.entries.at(-1).isNew,
        'switching back to dynamic mode restores New Workspace');
    assert(extension.stateObj._dock.dash.workspaces.count === 1 &&
        extension.stateObj._dock._nativeWorkspaces.count === 1,
    'returning to one regular workspace collapses both views back to plus only');
}
