// SPDX-License-Identifier: GPL-3.0-or-later
// Run only in the isolated Shell supplied by scripts/panthea test.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export {init} from './shell.js';
export const METRICS = {};

function assert(value, message) {
    if (!value)
        throw new Error(`Panthea panel clock: ${message}`);
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
    const settings = extension.stateObj._settings;
    const {formatPanelClock} = await import(extension.dir.get_child('lib').get_child('panelClock.js').get_uri());
    const dateMenu = Main.panel.statusArea.dateMenu;
    const display = dateMenu._clockDisplay;
    const nativeClock = dateMenu._clock;
    const interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const saved = new Map(['clock-format', 'clock-show-seconds', 'clock-show-date', 'clock-show-weekday']
        .map(key => [key, interfaceSettings.get_value(key)]));
    assert(settings.get_default_value('panel-date-format').get_int32() === 1 &&
        settings.get_int('panel-date-format') === 1 && extension.stateObj._panelClock &&
        display.text === formatPanelClock(GLib.DateTime.new_now_local(), extension.stateObj._panelClock._clock.clock),
    'Full date is enabled by default');
    settings.set_int('panel-date-format', 0);
    await settle();
    assert(display.text === nativeClock.clock,
        'GNOME Default leaves the native panel clock unchanged');

    // Fixed instants cover midnight and the same instant on either side of a time-zone boundary.
    const before = GLib.DateTime.new_from_iso8601('2026-11-13T23:59:00Z', null);
    const after = before.add_minutes(1);
    const elsewhere = before.to_timezone(GLib.TimeZone.new_offset(3600));
    for (const date of [before, after, elsewhere, before.add_days(-10)]) {
        assert(formatPanelClock(date, '12:00') === `${date.format('%A')}, ${date.format('%B')} ${date.get_day_of_month()}, 12:00`,
            `long date has a full weekday and month, without a padded day: ${date.format('%F %z')}`);
    }
    assert(formatPanelClock(before, '') !== formatPanelClock(after, '') &&
        formatPanelClock(after, '') === formatPanelClock(elsewhere, ''),
    'date formatting follows midnight and the supplied time zone');

    try {
        settings.set_int('panel-date-format', 1);
        await settle();
        const clock = extension.stateObj._panelClock;
        const checkLong = () => assert(display.text === formatPanelClock(GLib.DateTime.new_now_local(), clock._clock.clock),
            'panel displays the local long date followed by native time');
        checkLong();
        for (const format of ['12h', '24h']) {
            for (const seconds of [false, true]) {
                interfaceSettings.set_string('clock-format', format);
                interfaceSettings.set_boolean('clock-show-seconds', seconds);
                await settle();
                checkLong();
                print(`PASS: native ${format} time with seconds ${seconds}`);
            }
        }
        interfaceSettings.set_boolean('clock-show-date', false);
        interfaceSettings.set_boolean('clock-show-weekday', false);
        await settle();
        checkLong();
        nativeClock.notify('clock');
        clock._clock.notify('timezone');
        await settle();
        checkLong();
        assert(dateMenu.label_actor === display, 'native accessible clock label is retained');
        dateMenu.menu.open();
        await settle();
        assert(dateMenu.menu.isOpen, 'native calendar still opens with the long date');
        dateMenu.menu.close();
        await settle();

        const output = GLib.getenv('PANTHEA_TEST_OUTPUT');
        if (output) {
            const stream = Gio.File.new_for_path(`${output}/panel-clock-long.png`)
                .replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            await new Shell.Screenshot().screenshot(false, stream);
            stream.close(null);
        }
        settings.set_int('panel-date-format', 0);
        await settle();
        assert(!extension.stateObj._panelClock && display.text === nativeClock.clock,
            'selecting GNOME Default restores the current native clock');
        settings.set_int('panel-date-format', 1);
        await settle();
        for (let repeat = 0; repeat < 2; repeat++) {
            await Main.extensionManager.disableExtension(extension.uuid);
            await settle();
            assert(display.text === nativeClock.clock, 'disabling Panthea restores the native clock');
            await Main.extensionManager.enableExtension(extension.uuid);
            await settle();
            assert(extension.stateObj._panelClock && display.text ===
                formatPanelClock(GLib.DateTime.new_now_local(), extension.stateObj._panelClock._clock.clock),
            're-enabling Panthea restores the saved long format');
        }
        settings.set_int('panel-date-format', 0);
        await settle();
        interfaceSettings.set_boolean('clock-show-seconds', false);
        await settle();
        assert(display.text === nativeClock.clock, 'native clock binding still updates after cleanup');

        assert(Main.extensionManager.openExtensionPrefs(extension.uuid, '', {}), 'preferences can be requested');
        let preferencesWindow = null;
        for (let attempt = 0; attempt < 30; attempt++) {
            await Scripting.sleep(100);
            preferencesWindow = global.get_window_actors().map(actor => actor.meta_window)
                .find(window => ['Panthea', 'Extension Error'].includes(window.get_title()));
            if (preferencesWindow)
                break;
        }
        assert(preferencesWindow?.get_title() === 'Panthea', 'date-format preferences open without errors');
        preferencesWindow.activate(global.get_current_time());
        await settle();
        const frame = preferencesWindow.get_frame_rect();
        print(`PREFS FRAME: ${frame.x},${frame.y} ${frame.width}x${frame.height}`);
        const pointer = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 400, 300);
        await settle();
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), frame.x + frame.width / 2, frame.y + 24);
        await Scripting.sleep(50);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await Scripting.sleep(50);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await settle();
        settings.reset('panel-date-format');
        await settle();
        assert(extension.stateObj._panelClock, 'resetting the preference restores Full date');
        if (output) {
            const stream = Gio.File.new_for_path(`${output}/panel-clock-preferences.png`)
                .replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            await new Shell.Screenshot().screenshot(false, stream);
            stream.close(null);
        }
        preferencesWindow.delete(global.get_current_time());
        await settle();
    } finally {
        settings.reset('panel-date-format');
        for (const [key, value] of saved)
            interfaceSettings.set_value(key, value);
    }
}
