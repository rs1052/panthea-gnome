// SPDX-License-Identifier: GPL-3.0-or-later
// All visibility-related GNOME Shell 50 actor paths are kept in this module.

export function visibilityTargets(panel) {
    const area = panel.statusArea;
    const qs = area.quickSettings;
    const tile = name => qs[name]?.quickSettingsItems[0];
    const targets = [
        ['show-qs-power-mode', tile('_powerProfiles'), true],
        ['show-qs-dark-style', tile('_darkMode'), true],
        ['show-qs-night-light', tile('_nightLight'), true],
        ['show-qs-do-not-disturb', tile('_doNotDisturb'), true],
        ['show-qs-keyboard-backlight', tile('_backlight'), true],
        ['show-qs-airplane-mode', tile('_rfkill'), true],
        ['show-panel-activities', area.activities?.container],
        ['show-panel-date', area.dateMenu?.container],
        ['show-panel-keyboard', area.keyboard?.container],
        ['show-panel-accessibility', area.a11y?.container],
        ['show-panel-quick-settings', qs.container],
        ['show-panel-network', qs._network],
        ['show-panel-bluetooth', qs._bluetooth],
        ['show-panel-audio', qs._volumeOutput],
        ['show-panel-power-icon', qs._system?._indicator],
        ['show-panel-power-mode', qs._powerProfiles],
        ['show-panel-night-light', qs._nightLight],
        ['show-panel-screen-sharing', area.screenSharing?.container],
        ['show-panel-screen-recording', area.screenRecording?.container],
    ];
    const dot = area.dateMenu?._indicator;
    if (dot) {
        targets.push(['show-panel-notifications', dot]);
        // GNOME balances the clock with a size-bound spacer opposite the dot.
        const first = area.dateMenu._clockDisplay.get_parent().get_first_child();
        targets.push(['show-panel-notifications', first.name === 'panthea-hidden' ? first.child : first]);
    }
    return targets.filter(([, actor]) => actor);
}
