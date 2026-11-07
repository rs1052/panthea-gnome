// SPDX-License-Identifier: GPL-3.0-or-later
// Run only through the isolated gnome-shell-test-tool session.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export {init} from './shell.js';
export const METRICS = {};

function assert(value, message) {
    if (!value)
        throw new Error(`Panthea layout: ${message}`);
    print(`PASS: ${message}`);
}
async function settle() {
    await Scripting.sleep(350);
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
function pages(view) {
    return Array.from({length: view._grid.nPages}, (_, page) =>
        view._grid.getItemsAtPage(page).filter(item => item.visible).map(item => item.id));
}
function popupPages(nativePages) {
    const items = nativePages.flat();
    return Array.from({length: Math.ceil(items.length / 15)}, (_, index) =>
        items.slice(index * 15, (index + 1) * 15));
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
    const seat = global.stage.context.get_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), 600, 400);
    await settle();
    const extension = Main.extensionManager.lookup('panthea@local');
    const launcher = extension.stateObj._launcher;
    const display = launcher._nativeDisplay;
    const native = Main.overview._overview.controls.appDisplay;
    const root = new Gio.Settings({schema_id: 'org.gnome.desktop.app-folders'});
    // Startup signals populate native actors before its initial deferred refresh.
    // Repeated popup refreshes must not keep shifting apps absent from the map.
    assert(native._overviewHiddenId === 0, 'startup fixture precedes native deferred refresh');
    display._redisplay();
    const startupOrder = JSON.stringify(pages(display));
    for (let i = 0; i < 3; i++)
        display._redisplay();
    assert(JSON.stringify(pages(display)) === startupOrder,
        'repeated startup refreshes preserve application and folder order');
    // Shell starts in Overview, which owns a modal grab of its own.
    Main.overview.hide();
    await settle();
    const monitorCount = DND.dragMonitors.length;
    const modalCount = Main.modalCount;
    const press = async key => {
        keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
        await settle();
    };
    const show = async () => {
        Main.overview.hide();
        await settle();
        launcher.menu.open();
        await settle();
    };
    const nativePages = async () => {
        launcher.menu.close();
        Main.overview.showApps();
        await settle();
        return pages(native);
    };
    const startDrag = async source => {
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), ...point(source));
        await Scripting.sleep(500);
        const [x, y] = point(source);
        assert(source.contains(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y)),
            'native drag source is unobstructed');
        pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.PRESSED);
        await Scripting.sleep(50);
        for (let step = 1; step <= 5; step++) {
            pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + step * 4, y + step * 2);
            await Scripting.sleep(40);
        }
        await settle();
        assert(source._dragging, 'pointer starts native drag');
        const dragActor = source._draggable._dragActor;
        const [dragWidth, dragHeight] = dragActor.get_transformed_size();
        const dragScale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        assert(Math.max(dragWidth, dragHeight) > 0 &&
            Math.max(dragWidth, dragHeight) <= 32 * dragScale + 1,
        `apps and folders use drag icons no larger than 32px (${dragWidth}×${dragHeight}, scale ${dragScale})`);
        if (!source.app)
            assert(dragActor.style_class === source.style_class && !dragActor.label.visible &&
                source.icon.label.visible,
            'folder drag icons retain native tile styling but hide only the dragged label');
    };
    const release = async () => {
        pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED);
        await settle();
    };
    const dragTo = async (source, target, fraction = 0.5) => {
        await startDrag(source);
        const [x, y] = point(target, fraction);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + 2, y);
        await Scripting.sleep(50);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        await Scripting.sleep(700);
        await release();
    };

    const savedAtStart = global.settings.get_value('app-picker-layout');
    const geometry = () => [display._grid.layoutManager.columnsPerPage,
        display._grid.layoutManager.rowsPerPage, launcher._root.width, display.height,
        launcher.menu.actor.width, launcher.menu.actor.height];
    await show();
    const firstGeometry = geometry();
    const firstOrder = pages(display);
    await screenshot('applications-first-open');
    const originalOrder = await nativePages();
    await show();
    assert(JSON.stringify(geometry()) === JSON.stringify(firstGeometry),
        `first-open geometry survives visiting Overview (${firstGeometry} -> ${geometry()})`);
    assert(JSON.stringify(firstOrder) === JSON.stringify(popupPages(originalOrder)),
        'first-open order matches Overview repaginated into 15-item pages');
    assert(display._grid.layoutManager.columnsPerPage === 5 &&
        display._grid.layoutManager.rowsPerPage === 3,
    'first-open grid uses five columns and three rows');
    assert(JSON.stringify(pages(display)) === JSON.stringify(popupPages(originalOrder)),
        'initial application and folder order follows Overview');
    assert(global.settings.get_value('app-picker-layout').equal(savedAtStart),
        'initial opening preserves saved layout');
    await screenshot('applications-compact');
    const theme = St.ThemeContext.get_for_stage(global.stage);
    const initialScale = theme.scale_factor;
    launcher.menu.close();
    theme.scale_factor = initialScale * 2;
    await show();
    // Font metrics settle after the newly scaled popup is first mapped.
    launcher._queueRender();
    await settle();
    const scaledGeometry = geometry();
    const scaledOrder = await nativePages();
    await show();
    assert(JSON.stringify(geometry()) === JSON.stringify(scaledGeometry) &&
        display._grid.layoutManager.columnsPerPage === 5 &&
        display._grid.layoutManager.rowsPerPage === 3,
    `scaled five-by-three geometry stays stable (${scaledGeometry} -> ${geometry()})`);
    assert(JSON.stringify(pages(display)) === JSON.stringify(popupPages(scaledOrder)),
        'scaled popup follows native order with continuous pages');
    await screenshot('applications-scaled');
    const scaledItems = display._grid.getItemsAtPage(0);
    for (const index of [0, 5]) {
        const [, y] = scaledItems[index].get_transformed_position();
        const [, nextY] = scaledItems[index + 5].get_transformed_position();
        assert(y + scaledItems[index].height <= nextY,
            'scaled grid rows do not overlap');
    }
    launcher.menu.close();
    theme.scale_factor = initialScale;
    await show();
    launcher._queueRender();
    await settle();
    const restoredGeometry = geometry();
    const restoredOrder = await nativePages();
    await show();
    assert(JSON.stringify(geometry()) === JSON.stringify(restoredGeometry) &&
        JSON.stringify(restoredGeometry) === JSON.stringify(firstGeometry) &&
        JSON.stringify(pages(display)) === JSON.stringify(popupPages(restoredOrder)),
    'restoring scale restores stable menu geometry');
    assert(global.settings.get_value('app-picker-layout').equal(savedAtStart),
        'scale and Overview visits do not save layout');
    global.settings.set_strv('favorite-apps', []);
    root.set_strv('folder-children', []);
    // Incomplete saved layouts also contain apps placed by GNOME at runtime.
    const sample = native.getAllItems().map(item => item.id);
    global.settings.set_value('app-picker-layout', packPages([sample.slice(0, 4).reverse()]));
    const partialOrder = await nativePages();
    await show();
    assert(JSON.stringify(pages(display)) === JSON.stringify(popupPages(partialOrder)),
        'incomplete saved layout follows Overview runtime positions');
    // Overview can retain runtime positions for apps absent from the saved map.
    // Notify through its normal view-loaded signal without inventing new storage.
    const runtimeItem = native._grid.getItemsAtPage(0).at(-1);
    native._moveItem(runtimeItem, 0, 4);
    native.emit('view-loaded');
    const runtimeOrder = pages(native);
    const savedPartial = global.settings.get_value('app-picker-layout');
    await show();
    assert(JSON.stringify(pages(display)) === JSON.stringify(popupPages(runtimeOrder)),
        'popup uses native runtime page mapping rather than independently sorting apps');
    assert(global.settings.get_value('app-picker-layout').equal(savedPartial),
        'following runtime page positions does not rewrite saved layout');
    await nativePages();
    native._redisplay();
    const ids = native.getAllItems().map(item => item.id);
    assert(ids.length >= 36, 'fixture has enough apps for a 24 + 12 page layout');
    const capacity = display._grid.itemsPerPage;
    const overflowPages = [ids.slice(0, 24), ids.slice(24, 36)];
    global.settings.set_strv('favorite-apps', ids.slice(36));
    const overflowLayout = packPages(overflowPages);
    global.settings.set_value('app-picker-layout', overflowLayout);
    const overflowOrder = await nativePages();
    await show();
    assert(overflowOrder.map(page => page.length).join(',') === '24,12' &&
        pages(display).map(page => page.length).join(',') === '15,15,6' &&
        JSON.stringify(pages(display)) === JSON.stringify(popupPages(overflowOrder)),
    'native 24 + 12 pages become 15 + 15 + 6 popup pages without losing order');
    assert(global.settings.get_value('app-picker-layout').equal(overflowLayout),
        'packing native overflow does not rewrite saved page boundaries');

    // Fifteen top-level items fit on one Overview page. Extracting a folder
    // member needs a second popup page, but must not create an Overview page.
    global.settings.set_strv('favorite-apps', ids.slice(16));
    global.settings.set_value('app-picker-layout', packPages([ids.slice(0, 16)]));
    await nativePages();
    await show();
    display.createFolder(ids.slice(0, 2));
    await settle();
    const extractionFolder = display._folderIcons.find(icon =>
        ids.slice(0, 2).every(id => icon.getAppIds().includes(id)));
    assert(pages(display).map(page => page.length).join(',') === '15',
        'folder extraction starts with fifteen top-level items');
    extractionFolder.open();
    await settle();
    const extracted = extractionFolder.view.getAllItems()[0];
    const extractedId = extracted.id;
    await startDrag(extracted);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), ...point(display, 0.05));
    await Scripting.sleep(700);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), ...point(display._nextPageIndicator, 0.1));
    await Scripting.sleep(1200);
    assert(display._grid.currentPage === 1, 'folder drag can navigate to the popup overflow page');
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), ...point(display));
    await Scripting.sleep(400);
    await release();
    assert(!extractionFolder.getAppIds().includes(extractedId) && display._items.has(extractedId),
        'drop on the overflow page extracts the folder member into the popup');
    const extractedOrder = pages(display);
    assert(extractedOrder.map(page => page.length).join(',') === '15,1',
        'folder extraction creates only the required popup overflow page');
    const extractedNativeOrder = await nativePages();
    assert(extractedNativeOrder.length === 1 &&
        JSON.stringify(extractedNativeOrder.flat()) === JSON.stringify(extractedOrder.flat()),
    'folder extraction shares order without creating an unnecessary Overview page');
    root.set_strv('folder-children', []);
    global.settings.set_strv('favorite-apps', []);
    await nativePages();
    const initialPages = [ids.slice(0, capacity).reverse(), ids.slice(capacity, capacity + 15),
        ids.slice(capacity + 15)];
    const initial = packPages(initialPages);
    global.settings.set_value('app-picker-layout', initial);
    await show();
    assert(JSON.stringify(pages(display)) === JSON.stringify(popupPages(initialPages)),
        'Panthea packs sparse native pages continuously in native order');
    assert(global.settings.get_value('app-picker-layout').equal(initial), 'opening does not rewrite layout');
    assert(display._grid.itemsPerPage === 15, 'popup capacity is 15 without changing Overview');
    assert(display._grid.layoutManager.columnsPerPage === 5 &&
        display._grid.layoutManager.rowsPerPage === 3, 'popup uses five columns and three rows');
    const [searchX] = launcher._search.get_transformed_position();
    const [rootX] = launcher._root.get_transformed_position();
    assert(Math.abs(searchX + launcher._search.width / 2 - rootX - launcher._root.width / 2) <= 1,
        'search is horizontally centered above the grid');
    assert(Math.abs(launcher._search.width - 312 * theme.scale_factor) <= 1,
        'search retains its centered 312px width');
    const workArea = Main.layoutManager.getWorkAreaForMonitor(
        Main.layoutManager.findMonitorForActor(launcher).index);
    assert(launcher._root.width === Math.min(672 * theme.scale_factor, workArea.width * 0.75) &&
        display.height === Math.min(308 * theme.scale_factor,
            workArea.height - launcher._search.get_preferred_height(launcher._search.width)[1] -
            64 * theme.scale_factor), 'popup retains its original browsing dimensions');
    assert(launcher._search.contains(global.stage.key_focus), 'search automatically receives focus');
    const monitor = Main.layoutManager.findMonitorForActor(launcher);
    assert(launcher.menu.actor.width < monitor.width * 0.85 &&
        launcher.menu.actor.height < monitor.height * 0.85, 'compact popup leaves desktop space visible');
    assert(display._grid.layoutManager.iconSize === 56, 'roomier grid uses 56px icons');
    assert(display._nextPageArrow.get_theme_node().get_background_color().alpha === 0,
        'resting arrows have no circular background');
    const scale = theme.scale_factor;
    const padding = display._grid.layoutManager.pagePadding;
    assert(padding.left <= display._nextPageArrow.width + 8 * scale &&
        padding.right <= display._nextPageArrow.width + 8 * scale,
    'side gutters only reserve arrows and small margins');
    assert(display._nextPageArrow.width === 40 * scale &&
        display._nextPageArrow.height === 40 * scale, 'arrow button dimensions remain unchanged');
    assert(display._grid.layoutManager.rowSpacing === 14 * scale &&
        display._grid.layoutManager.columnSpacing === 24 * scale, 'tiles use roomier native grid spacing');
    const firstTile = display._grid.getItemsAtPage(0)[0];
    const tileTheme = firstTile.get_theme_node();
    assert(tileTheme.get_padding(St.Side.TOP) === 4 * scale &&
        tileTheme.get_padding(St.Side.BOTTOM) === 4 * scale &&
        tileTheme.get_padding(St.Side.LEFT) === 4 * scale &&
        tileTheme.get_padding(St.Side.RIGHT) === 4 * scale, 'app padding fits larger icons within the unchanged height');
    assert(padding.left === 44 * scale && padding.right === 44 * scale,
        'gutters reserve only the unchanged arrow width and 4px inner padding');
    assert(launcher._root.get_theme_node().get_padding(St.Side.LEFT) === 6 * scale &&
        launcher._root.get_theme_node().get_padding(St.Side.RIGHT) === 6 * scale,
    'outer gutter padding is reduced without changing vertical section padding');
    const searchBottom = launcher._search.get_transformed_position()[1] + launcher._search.height;
    const searchGap = firstTile.get_transformed_position()[1] - searchBottom;
    assert(searchGap >= 8 * scale && searchGap <= 28 * scale,
        'first row sits comfortably below search without excess vertical space');
    const lastColumn = display._grid.getItemsAtPage(0)[4];
    const gridCenter = (firstTile.get_transformed_position()[0] +
        lastColumn.get_transformed_position()[0] + lastColumn.width) / 2;
    assert(Math.abs(gridCenter - rootX - launcher._root.width / 2) <= 1,
        'five application columns are centered beneath search');
    const indicators = display._pageIndicators;
    const lastRow = display._grid.getItemsAtPage(0)[10];
    const gridBottom = lastRow.get_transformed_position()[1] + lastRow.height;
    const paginationGap = indicators.get_transformed_position()[1] - gridBottom;
    assert(paginationGap >= 0 && paginationGap <= 28 * scale,
        'pagination follows the final row without excess vertical space');
    assert(Math.abs(indicators.get_transformed_position()[0] + indicators.width / 2 -
        rootX - launcher._root.width / 2) <= 1, 'page indicators are centered below the grid');
    assert(firstTile.get_transformed_position()[0] - display.get_transformed_position()[0] <=
        display._nextPageArrow.width + 48 * scale,
    'visible grid starts near the arrow gutter instead of centering in excess space');
    const tileSize = firstTile.get_size();
    for (const [index, item] of display._grid.getItemsAtPage(0).entries()) {
        assert(item.get_size().every((size, axis) => Math.abs(size - tileSize[axis]) <= 1),
            `tile ${index + 1} has uniform dimensions`);
        const [x, y] = item.get_transformed_position();
        const [columnX] = display._grid.getItemsAtPage(0)[index % 5].get_transformed_position();
        const [, rowY] = display._grid.getItemsAtPage(0)[Math.floor(index / 5) * 5].get_transformed_position();
        assert(Math.abs(x - columnX) <= 1 && Math.abs(y - rowY) <= 1,
            `tile ${index + 1} aligns with its row and column`);
    }
    firstTile.add_style_pseudo_class('hover');
    await settle();
    assert(firstTile.get_size().every((size, index) => size === tileSize[index]) &&
        !firstTile.icon.label.clutter_text.line_wrap, 'hover does not expand application tiles');
    firstTile.remove_style_pseudo_class('hover');
    display._nextPageArrow.emit('clicked', 1);
    await settle();
    assert(display._grid.currentPage === 1, 'chevron changes native page');
    display._pageIndicators.get_children()[0].emit('clicked', 1);
    await settle();
    assert(display._grid.currentPage === 0, 'clickable dots change native page');
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), ...point(display));
    await settle();
    pointer.notify_discrete_scroll(GLib.get_monotonic_time(), Clutter.ScrollDirection.DOWN,
        Clutter.ScrollSource.WHEEL);
    await settle();
    assert(display._grid.currentPage === 1, 'mouse wheel changes native page');
    await press(Clutter.KEY_Page_Up);
    assert(display._grid.currentPage === 0, 'Page Up changes native page');

    let first = display._grid.getItemsAtPage(0);
    const middleMoved = first[12].id;
    const middleTarget = first[11].id;
    await dragTo(first[12], first[11], 0.03);
    first = display._grid.getItemsAtPage(0);
    assert(first.findIndex(item => item.id === middleMoved) <
        first.findIndex(item => item.id === middleTarget),
    'quick pointer drag reorders icons in a full middle row');
    const moved = first[3].id;
    await dragTo(first[3], first[0], 0.03);
    assert(display._grid.getItemsAtPage(0)[0].id === moved, 'native edge drag reorders icons');
    let expectedPages = JSON.stringify(pages(display));
    assert(JSON.stringify(popupPages(await nativePages())) === expectedPages,
        'pointer reorder synchronizes to GNOME');
    assert(pages(native).length === Math.ceil(pages(display).flat().length / native._grid.itemsPerPage) &&
        pages(native).slice(0, -1).every(page => page.length === native._grid.itemsPerPage),
    'pointer reorder saves Overview-sized pages rather than popup-sized pages');
    native._moveItem(native._items.get(moved), 1, 0);
    native._savePages();
    await show();
    assert(JSON.stringify(pages(display)) === JSON.stringify(popupPages(pages(native))),
        'GNOME edits synchronize to Panthea in continuous order');

    first = display._grid.getItemsAtPage(0);
    const crossPageId = first[0].id;
    await startDrag(first[0]);
    // Stay outside GNOME's outer 20px immediate-switch region so this checks
    // the delayed page hint, not an immediate switch followed by a repeat.
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), ...point(display._nextPageIndicator, 0.1));
    await Scripting.sleep(1200);
    assert(display._grid.currentPage === 1, 'native drag hint switches pages');
    await settle();
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), ...point(display._grid.getItemsAtPage(1)[0], 0.03));
    await Scripting.sleep(400);
    await release();
    const crossPageOrder = pages(display);
    assert(crossPageOrder.flat().indexOf(crossPageId) === capacity - 1,
        'cross-page pointer drop preserves its position after filling the earlier vacancy');
    assert(crossPageOrder.slice(0, -1).every(page => page.length === capacity),
        'completed cross-page drag leaves only the last page partially filled');
    expectedPages = JSON.stringify(pages(display));
    assert(JSON.stringify(popupPages(await nativePages())) === expectedPages,
        'cross-page move synchronizes to GNOME');
    assert(pages(native).length === Math.ceil(crossPageOrder.flat().length / native._grid.itemsPerPage),
        'cross-page move creates only pages required by Overview capacity');
    await show();

    first = display._grid.getItemsAtPage(0);
    const members = [first[0].id, first[1].id];
    await dragTo(first[1], first[0]);
    let folder = display._folderIcons.find(item => members.every(id => item.getAppIds().includes(id)));
    assert(folder, 'app-on-app pointer drop creates native folder');
    const folderId = folder.id;
    const folderTarget = display._grid.getItemsAtPage(0).at(-1);
    await dragTo(folder, folderTarget, 0.97);
    assert(display._grid.getItemsAtPage(0).at(-1).id === folderId,
        'native edge drag reorders folders');
    const added = display._grid.getItemsAtPage(0).find(item => item.app);
    const addedId = added.id;
    await dragTo(added, folder);
    assert(folder.getAppIds().includes(addedId), 'pointer drop adds application to native folder');
    expectedPages = JSON.stringify(pages(display));
    assert(JSON.stringify(popupPages(await nativePages())) === expectedPages, 'native folder order synchronizes to GNOME');
    assert(native._items.get(folderId).getAppIds().includes(addedId), 'folder membership synchronizes to GNOME');
    native._moveItem(native._items.get(folderId), 1, 0);
    native._savePages();
    await show();
    folder = display._items.get(folderId);
    assert(JSON.stringify(pages(display)) === JSON.stringify(popupPages(pages(native))),
        'GNOME folder order synchronizes to Panthea across page boundaries');
    display.goToPage(display._grid.getItemPosition(folder)[0], false);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), monitor.width - 5, monitor.height - 5);
    launcher._search.grab_key_focus();
    await settle();
    const folderSize = folder.get_size();
    const baseColor = folder.get_theme_node().get_background_color().to_string();
    assert(folder.get_theme_node().get_background_color().alpha > 0,
        'folder has a distinct resting background');
    folder.add_style_pseudo_class('hover');
    await settle();
    assert(folder.get_theme_node().get_background_color().to_string() !== baseColor,
        'folder hover adds feedback over its resting background');
    assert(folder.get_size().every((size, index) => size === folderSize[index]),
        'folder hover keeps its geometry unchanged');
    await screenshot('applications-compact-folder-hover');
    folder.remove_style_pseudo_class('hover');
    const savedWithFolder = global.settings.get_value('app-picker-layout');
    launcher.menu.close();
    await show();
    assert(global.settings.get_value('app-picker-layout').equal(savedWithFolder),
        'reopening with native folders does not rewrite layout');
    display.goToPage(display._grid.getItemPosition(folder)[0]);
    await settle();
    folder.grab_key_focus();
    folder.open();
    await settle();
    let dialog = display._currentDialog;
    assert(dialog?._isOpen && dialog.mapped && launcher.menu.isOpen && !Main.overview.visible,
        'native folder overlay opens above popup without Overview');
    assert(dialog.contains(global.stage.key_focus), 'native folder receives keyboard focus');
    dialog._editButton.checked = true;
    dialog._entry.set_text('Native layout test');
    await press(Clutter.KEY_Return);
    assert(folder._folder.get_string('name') === 'Native layout test', 'native folder name editing saves');
    await press(Clutter.KEY_Escape);
    assert(!dialog._isOpen && launcher.menu.isOpen, 'Escape closes folder and retains popup');
    assert(global.stage.key_focus === folder, 'closing folder restores focus to its source');
    folder.open();
    await settle();
    const source = folder.view.getAllItems()[0];
    const removedId = source.id;
    const savedBeforeCancel = global.settings.get_value('app-picker-layout');
    await startDrag(source);
    await press(Clutter.KEY_Escape);
    await release();
    assert(!source._draggable._grab, 'Escape cancels folder drag and releases modal grab');
    assert(global.settings.get_value('app-picker-layout').equal(savedBeforeCancel),
        'cancelling a folder drag preserves the saved layout');
    // Return to the popup grid, not the desktop outside its drop area. Native
    // folder dragging dismisses the overlay after dwelling outside the folder.
    await dragTo(source, display, 0.05);
    await settle();
    assert(!folder.getAppIds().includes(removedId) && display._items.has(removedId),
        'dragging out of native folder returns app to grid');
    // Native FolderView removes its settings when its last effective app leaves.
    for (const item of [...folder.view.getAllItems()])
        folder.view.removeApp(item.app);
    await settle();
    assert(!root.get_strv('folder-children').includes(folderId), 'native behavior removes empty folder');

    await show();
    const favoriteId = display.getAllItems().find(item => item.app).id;
    global.settings.set_strv('favorite-apps', [favoriteId]);
    await settle();
    assert(!display._items.has(favoriteId), 'grid follows native favorite exclusion');
    const savedBeforeSearch = global.settings.get_value('app-picker-layout');
    launcher._search.set_text(launcher.catalog.byId.get(favoriteId).name);
    await settle();
    assert(launcher._matches.some(entry => entry.id === favoriteId), 'search includes favorites');
    launcher._search.set_text('terminal');
    await settle();
    assert(launcher._matches.length > 0 && !display.visible, 'application search keeps separate results');
    launcher._search.grab_key_focus();
    await press(Clutter.KEY_Down);
    assert(global.stage.key_focus === launcher._visibleButtons[0], 'Down focuses the first search result');
    launcher._visibleButtons[0].popupMenu();
    await settle();
    assert(launcher._visibleButtons[0]._menu.isOpen, 'search application context menu remains usable');
    launcher._visibleButtons[0]._menu.close();
    await press(Clutter.KEY_Escape);
    assert(display.visible && launcher.menu.isOpen && !launcher._search.get_text(),
        'Escape clears search and restores the native grid');
    launcher._search.set_text('panthea-no-such-application');
    await settle();
    assert(launcher._empty.visible && launcher._matches.length === 0, 'empty search state remains available');
    launcher._search.set_text('');
    await settle();
    assert(global.settings.get_value('app-picker-layout').equal(savedBeforeSearch),
        'searching and clearing search leave the saved layout unchanged');
    display.goToPage(0);
    await settle();
    const orderBeforeClose = JSON.stringify(pages(display));
    await startDrag(display._grid.getItemsAtPage(0).find(item => item.app));
    launcher.menu.close();
    await release();
    assert(DND.dragMonitors.length === monitorCount, 'closing popup during drag clears native drag monitors');
    assert(Main.modalCount === modalCount, 'closing popup during drag releases input grabs');
    assert(JSON.stringify(pages(display)) === orderBeforeClose,
        'closing popup during drag preserves application order');
    await show();
    display.createFolder(display._grid.getItemsAtPage(0).filter(item => item.app).slice(0, 2).map(item => item.id));
    await settle();
    display._folderIcons[0].open();
    await settle();
    const openFolderId = display._folderIcons[0].id;
    root.set_strv('folder-children', root.get_strv('folder-children').filter(id => id !== openFolderId));
    await settle();
    assert(!display._currentDialog && launcher.menu.isOpen, 'external deletion closes native folder safely');
    display.createFolder(display._grid.getItemsAtPage(0).filter(item => item.app).slice(0, 2).map(item => item.id));
    await settle();
    display._folderIcons[0].open();
    await settle();
    const ownedDialog = display._currentDialog;
    let dialogDestroyed = false;
    ownedDialog.connect('destroy', () => { dialogDestroyed = true; });
    await Main.extensionManager._callExtensionDisableWithRebase('panthea@local');
    await settle();
    global.settings.set_value('app-picker-layout', initial);
    await settle();
    assert(DND.dragMonitors.length === monitorCount, 'disabling with folder open leaves no drag monitors');
    assert(dialogDestroyed && Main.modalCount === modalCount,
        'disabling destroys the native folder overlay and releases input grabs');
    await Main.extensionManager._callExtensionEnable('panthea@local');
    await settle();
    assert(Main.extensionManager.lookup('panthea@local').stateObj._launcher._nativeDisplay,
        'native popup survives disable and re-enable');
    const reopened = Main.extensionManager.lookup('panthea@local').stateObj._launcher;
    reopened.menu.open();
    await settle();
    assert(reopened._search.contains(global.stage.key_focus), 're-enabled popup accepts keyboard focus');
    reopened.menu.close();
    await settle();
    assert(Main.modalCount === modalCount, 're-enabled popup releases its input grab');
}
