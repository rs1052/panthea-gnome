// SPDX-License-Identifier: GPL-3.0-or-later

// This module is shared by the Shell and preferences processes. Keep it GI-free.
export const QUICK_SETTINGS = [
    ['show-qs-power-mode', 'Power Mode'],
    ['show-qs-dark-style', 'Dark Style'],
    ['show-qs-night-light', 'Night Light'],
    ['show-qs-do-not-disturb', 'Do Not Disturb'],
    ['show-qs-keyboard-backlight', 'Keyboard Backlight'],
    ['show-qs-airplane-mode', 'Airplane Mode'],
];

export const QUICK_SETTINGS_INDICATORS = [
    ['show-panel-network', 'Network'],
    ['show-panel-bluetooth', 'Bluetooth'],
    ['show-panel-audio', 'Audio Output'],
    ['show-panel-power-icon', 'Power Icon',
        'Battery percentage continues to follow GNOME Settings.'],
    ['show-panel-power-mode', 'Power Mode'],
    ['show-panel-night-light', 'Night Light'],
];

export const TOP_PANEL = [
    ['show-panel-activities', 'Activities'],
    ['show-panel-date', 'Clock and Calendar'],
    ['show-panel-notifications', 'Notification Dot'],
    ['show-panel-keyboard', 'Keyboard Layout'],
    ['show-panel-accessibility', 'Accessibility'],
    ['show-panel-quick-settings', 'Quick Settings Button',
        'Hiding this removes mouse access to Quick Settings.'],
    ['show-panel-screen-sharing', 'Screen Sharing',
        'Hiding this removes a visible warning while your screen is being shared.'],
    ['show-panel-screen-recording', 'Screen Recording',
        'Hiding this removes a visible warning while your screen is being recorded.'],
];

export const DOCK_SIZES = [32, 48, 64];

export const DOCK_HIDE_MODES = [
    ['never', 'Never'],
    ['focused-maximized', 'When the focused window is maximized'],
    ['focused-overlap', 'When the focused window overlaps the dock'],
    ['any-overlap', 'When any window overlaps the dock'],
    ['unused', 'When not being used'],
];

export const CATEGORIES = [
    ['AudioVideo', 'Sound & Video'],
    ['Development', 'Development'],
    ['Education', 'Education'],
    ['Game', 'Games'],
    ['Graphics', 'Graphics'],
    ['Network', 'Internet'],
    ['Office', 'Office'],
    ['Science', 'Science'],
    ['Settings', 'Settings'],
    ['System', 'System'],
    ['Utility', 'Utilities'],
    ['Other', 'Other'],
];
