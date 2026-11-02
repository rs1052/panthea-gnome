// SPDX-License-Identifier: GPL-3.0-or-later
// Run with scripts/panthea test --headless --layout, never in the normal session.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export {init} from './shell.js';
export const METRICS = {};

function assert(condition, message) {
    if (!condition)
        throw new Error(`Panthea layout: ${message}`);
    print(`PASS: ${message}`);
}

async function settle() {
    await Scripting.sleep(300);
    await Scripting.waitLeisure();
}

function point(actor, fraction = 0.5) {
    const [x, y] = actor.get_transformed_position();
    return [x + actor.width * fraction, y + actor.height / 2];
}

function packPages(pages) {
    return new GLib.Variant('aa{sv}', pages.map(ids => Object.fromEntries(ids.map((id, position) =>
        [id, new GLib.Variant('a{sv}', {position: new GLib.Variant('i', position)})]))));
}

export async function run() {
    await settle();
    const extension = Main.extensionManager.lookup('panthea@local');
    const launcher = extension.stateObj._launcher;
    const {layout, catalog} = launcher;
    const settings = extension.stateObj._settings;
    const native = Main.overview._overview.controls.appDisplay;
    const keyboard = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const pointer = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const savedLayout = global.settings.get_value('app-picker-layout');
    const savedFolders = layout.root.get_value('folder-children');
    const savedFavorites = global.settings.get_value('favorite-apps');
    const savedView = settings.get_string('applications-view');
    const createdFolders = new Set();
    const monitorCount = DND.dragMonitors.length;
    const entries = catalog.entries;
    const ids = entries.map(entry => entry.id);
    assert(ids.length > 20, 'fixture has enough apps for cross-page dragging');

    const show = async () => {
        Main.overview.hide();
        await settle();
        launcher.menu.open();
        await settle();
    };
    const tile = id => launcher._visibleButtons.find(button => button.entry.id === id);
    const startDrag = async button => {
        const [x, y] = point(button);
        assert(button._draggable.startGesture.enabled, 'grid tile permits dragging');
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        // Separate gestures when the next source occupies the previous drop
        // target. Otherwise Clutter may combine the synthetic click sequences.
        await Scripting.sleep(500);
        assert(button.contains(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y)),
            'drag source is visible and unobstructed');
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await Scripting.sleep(250);
        // Deliver a motion sequence, as a real pointer does, rather than one
        // jump that can be coalesced with an actor's enter/focus update.
        for (let step = 1; step <= 5; step++) {
            pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + 12 * step, y + 2 * step);
            await Scripting.sleep(40);
        }
        await settle();
        assert(launcher._drag?.id === button.entry.id,
            'pointer motion starts a native DND drag');
    };
    const release = async () => {
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await settle();
    };
    const dragTo = async (source, target, fraction) => {
        await startDrag(source);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), ...point(target, fraction));
        await Scripting.sleep(100);
        await release();
    };
    const nativeItems = async () => {
        launcher.menu.close();
        Main.overview.showApps();
        await settle();
        return native.getAllItems().map(item => item.id);
    };

    try {
        global.settings.set_strv('favorite-apps', []);
        layout.root.set_strv('folder-children', []);
        const initial = [ids[2], ids[1], ids[0], ...ids.slice(3)];
        const initialPages = packPages([initial.slice(0, 5), initial.slice(5)]);
        global.settings.set_value('app-picker-layout', initialPages);
        settings.set_string('applications-view', 'grid');
        await show();
        assert(launcher._matches.map(entry => entry.id).join(',') === initial.join(','),
            'Panthea reads native page/position order and reflows to its own pages');
        assert(global.settings.get_value('app-picker-layout').equal(initialPages),
            'reading a native layout never rewrites it');

        // Simulate backend policy and rejection without changing host dconf
        // profiles. Exercise the real launcher sensitivity and write path.
        const shellSettings = layout.settings;
        try {
            layout.settings = {
                get_value: key => shellSettings.get_value(key), is_writable: () => false,
            };
            launcher._render();
            assert(launcher._visibleButtons.every(button => !button._draggable.startGesture.enabled),
                'locked grid settings disable dragging');
            let rejected = false;
            try {
                layout.reorder(ids[0], ids[1], false, null, entries);
            } catch {
                rejected = true;
            }
            assert(rejected && shellSettings.get_value('app-picker-layout').equal(initialPages),
                'locked writes fail without modifying native settings');
            layout.settings = {
                get_value: key => shellSettings.get_value(key), is_writable: () => true,
                set_value: () => false,
            };
            rejected = false;
            try {
                layout.reorder(ids[0], ids[1], false, null, entries);
            } catch {
                rejected = true;
            }
            assert(rejected && shellSettings.get_value('app-picker-layout').equal(initialPages),
                'backend rejection leaves the native layout unchanged');
        } finally {
            layout.settings = shellSettings;
            launcher._render();
        }

        await dragTo(tile(ids[0]), tile(ids[2]), 0.08);
        assert(launcher._matches[0].id === ids[0], 'edge drop reorders apps without creating a folder');
        assert((await nativeItems())[0] === ids[0], 'Panthea reorder appears in the native GNOME grid');
        native._moveItem(native._items.get(ids[4]), 0, 0);
        native._savePages();
        await show();
        assert(launcher._matches[0].id === ids[4], 'native grid edits synchronize back to Panthea');
        native._moveItem(native._items.get(ids[0]), 0, 0);
        native._savePages();
        await show();

        await dragTo(tile(ids[1]), tile(ids[2]), 0.5);
        let folder = launcher._matches.find(entry => entry.kind === 'folder');
        assert(!!folder, 'app-on-app pointer drop creates a folder');
        createdFolders.add(folder.id);
        const folderId = folder.id;
        assert(layout.folder(folderId).apps.join(',') === [ids[2], ids[1]].join(','),
            'folder creation writes native membership in drop order');
        await dragTo(tile(ids[3]), tile(folderId), 0.5);
        assert(layout.contents(folderId, entries).some(entry => entry.id === ids[3]),
            'dropping on a folder adds membership');
        await dragTo(tile(folderId), tile(ids[0]), 0.08);
        assert(launcher._matches[0].id === folderId, 'folders can be reordered alongside apps');
        await nativeItems();
        assert(native._items.get(folderId).getAppIds().join(',') === [ids[2], ids[1], ids[3]].join(','),
            'GNOME reads Panthea-created folders and membership');
        native._items.get(folderId).open();
        await settle();
        assert(native._currentDialog?.visible, 'native GNOME folder dialog opens with shared membership');
        native._currentDialog.popdown();
        await settle();
        await show();

        tile(folderId).activate();
        await settle();
        assert(launcher._folderId === folderId && launcher._folderBar.visible, 'folders open in Panthea');
        await dragTo(tile(ids[3]), tile(ids[2]), 0.08);
        assert(layout.folder(folderId).apps[0] === ids[3], 'folder pointer drags save internal order');
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), ...point(launcher._folderName));
        await Scripting.sleep(50);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await settle();
        assert(launcher._folderName.clutter_text.editable &&
            launcher._folderName.contains(global.stage.key_focus), 'folder name accepts pointer and keyboard focus');
        launcher._folderName.set_text('Layout test folder');
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Tab, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Tab, Clutter.KeyState.RELEASED);
        await settle();
        assert(launcher._folderName.get_text() === 'Layout test folder', 'leaving the name field preserves an unsaved rename');
        launcher._folderRename.emit('clicked', Clutter.BUTTON_PRIMARY);
        await settle();
        assert(layout.folder(folderId).name === 'Layout test folder' && !layout.folder(folderId).translate,
            'Rename writes a native literal folder name');
        let invalidName = false;
        try {
            layout.rename(folderId, '   ');
        } catch {
            invalidName = true;
        }
        assert(invalidName && layout.folder(folderId).name === 'Layout test folder',
            'empty folder names fail without changing saved settings');
        layout.folders.get(folderId).set_string('name', 'Renamed externally');
        launcher._search.grab_key_focus();
        await settle();
        assert(launcher._folderName.get_text() === 'Renamed externally', 'external folder names synchronize live');
        tile(ids[1]).popupMenu();
        await settle();
        assert(tile(ids[1])._removeItem.visible, 'folder app context menu exposes Remove from Folder');
        tile(ids[1])._removeItem.emit('activate', null);
        await settle();
        assert(!layout.contents(folderId, entries).some(entry => entry.id === ids[1]),
            'Remove from Folder updates native membership');
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
        await settle();
        assert(!launcher._folderId && launcher.menu.isOpen, 'Escape returns from folder to the grid');

        const beforeCancel = global.settings.get_value('app-picker-layout');
        await startDrag(tile(ids[0]));
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
        await settle();
        await release();
        assert(global.settings.get_value('app-picker-layout').equal(beforeCancel) && !launcher._drag,
            'cancelled pointer drags leave the native layout unchanged');
        await startDrag(tile(ids[0]));
        global.settings.set_value('app-picker-layout', packPages([initial.toReversed()]));
        await settle();
        await release();
        assert(!launcher._drag && launcher._matches[0].id === initial.at(-1),
            'external layout changes cancel stale drags and render the latest order');

        // Restore a predictable first page for the cross-page gesture.
        global.settings.set_value('app-picker-layout', packPages([initial]));
        await settle();
        await startDrag(tile(ids[0]));
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), ...point(launcher._nextPageArrow));
        await Scripting.sleep(800);
        assert(launcher._page === 1, 'hovering the existing next-page arrow changes pages during drag');
        const destination = launcher._visibleButtons[0];
        const destinationId = destination.entry.id;
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), ...point(destination, 0.08));
        await release();
        assert(launcher._matches.findIndex(entry => entry.id === ids[0]) + 1 ===
            launcher._matches.findIndex(entry => entry.id === destinationId),
        'cross-page pointer drop preserves the requested global position');

        // Category-based folders keep automatic membership and exclusions.
        const folderSettings = layout.folders.get(folderId);
        const categoryEntry = entries.find(entry => (entry.info.get_categories() ?? '').split(';').filter(Boolean).length);
        const category = categoryEntry.info.get_categories().split(';').filter(Boolean)[0];
        folderSettings.set_strv('categories', [category]);
        folderSettings.set_strv('apps', []);
        folderSettings.set_strv('excluded-apps', []);
        await settle();
        assert(layout.contents(folderId, entries).some(entry => entry.id === categoryEntry.id),
            'category-based native folders appear without explicit app membership');
        await nativeItems();
        assert(native._items.get(folderId).getAppIds().join(',') ===
            layout.contents(folderId, entries).map(entry => entry.id).join(','),
        'automatic folder ordering matches the native grid');
        await show();
        layout.remove(folderId, categoryEntry.id, entries);
        await settle();
        assert(!layout.contents(folderId, entries).some(entry => entry.id === categoryEntry.id),
            'removing category members prevents automatic re-addition');
        if (layout.folders.has(folderId)) {
            layout.add(folderId, categoryEntry.id, entries);
            assert(!layout.folder(folderId).excluded.includes(categoryEntry.id), 'adding a member clears its exclusion');
        }

        // Favorites remain in Panthea, even though native GNOME hides them.
        global.settings.set_strv('favorite-apps', [ids[0]]);
        await settle();
        assert(launcher._matches.some(entry => entry.id === ids[0] || entry.entries?.some(app => app.id === ids[0])),
            'Panthea grid and folders keep native favorites visible');
        settings.set_string('applications-view', 'list');
        await settle();
        const categories = [...launcher._categoryButtons.keys()];
        assert(categories.slice(0, 2).join(',') === 'favorites,all', 'category sidebar starts with Favorites and All Applications');
        launcher._categoryButtons.get('favorites').emit('clicked', Clutter.BUTTON_PRIMARY);
        await settle();
        assert(launcher._matches.map(entry => entry.id).join(',') === ids[0], 'Favorites uses GNOME favorite apps');
        global.settings.set_strv('favorite-apps', [ids[1]]);
        await settle();
        assert(launcher._matches.map(entry => entry.id).join(',') === ids[1], 'Favorites synchronizes live without changing category');
        global.settings.set_strv('favorite-apps', []);
        await settle();
        assert(launcher._empty.visible && launcher._empty.text === 'No favorite applications', 'empty Favorites keeps its message');

        settings.set_string('applications-view', 'grid');
        await settle();
        if (layout.folders.has(folderId)) {
            launcher._openFolder(folderId);
            await settle();
            launcher._folderDissolve.emit('clicked', Clutter.BUTTON_PRIMARY);
            await settle();
            assert(!layout.folders.has(folderId) && !launcher._folderId, 'Dissolve Folder returns apps to the grid');
        }
        const emptied = layout.create(ids[0], ids[1], entries);
        createdFolders.add(emptied);
        layout.remove(emptied, ids[0], entries);
        layout.remove(emptied, ids[1], entries);
        await settle();
        assert(!layout.folders.has(emptied), 'removing the last member deletes the empty folder');
        const temporary = layout.create(ids[0], ids[1], entries);
        createdFolders.add(temporary);
        launcher._openFolder(temporary);
        await settle();
        layout.root.set_strv('folder-children', []);
        await settle();
        assert(!launcher._folderId && launcher._matches.some(entry => entry.id === ids[0]),
            'external deletion of an open folder safely returns to the grid');

        launcher._search.set_text(entries[0].name);
        await settle();
        assert(launcher._visibleButtons.every(button => !button._draggable.startGesture.enabled),
            'search results cannot rewrite the grid layout');
        launcher._search.set_text('');
        await settle();
        launcher._changePage(-launcher._page);
        await startDrag(launcher._visibleButtons[0]);
        await Main.extensionManager._callExtensionDisableWithRebase('panthea@local');
        await release();
        assert(!launcher._dragMonitor && DND.dragMonitors.length === monitorCount,
            'disabling during a drag releases actors, modal grabs, and drag monitors');
        await Main.extensionManager._callExtensionEnable('panthea@local');
        await settle();
        assert(!!extension.stateObj._launcher.layout, 're-enabling restores live layout subscriptions');
        print('PASS: Panthea layout integration checks complete');
    } finally {
        for (const id of createdFolders) {
            const child = layout.folders.get(id);
            if (child) {
                for (const key of child.settings_schema.list_keys())
                    child.reset(key);
            }
        }
        layout.root.set_value('folder-children', savedFolders);
        global.settings.set_value('app-picker-layout', savedLayout);
        global.settings.set_value('favorite-apps', savedFavorites);
        settings.set_string('applications-view', savedView);
    }
}
