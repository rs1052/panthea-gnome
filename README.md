# Panthea

A native GNOME Shell extension for Fedora 44, GNOME 50, and Wayland. Panthea adds an Applications menu, a bottom dock, adaptive translucency, and visibility controls. It does not install Pantheon or replace Quick Settings.

This is a personal-use extension. Review the code and test it before enabling it in your normal session. GNOME Shell extensions run inside the desktop process.

## Build and test

Run these commands from this directory:

```bash
bash scripts/panthea check
bash scripts/panthea build
```

The bundle is `dist/panthea@local.shell-extension.zip`. Runtime dependencies are the GJS, GTK4, Libadwaita, and GNOME libraries already provided by Fedora Workstation. Node.js is used only for syntax checking, not at runtime. You can build the bundle without a JavaScript package manager or transpiler.

### Nested development session

Install Fedora's development-session package:

```bash
sudo dnf install mutter-devkit
```

Start a separate desktop in a window:

```bash
bash scripts/panthea dev
```

The script builds and installs Panthea into temporary XDG directories and enables it using a separate settings backend and session bus. It does not enable Panthea or change extension settings in your normal desktop. Close the development window to exit. Restart this command after changing JavaScript because the Shell caches imported modules. Preferences apply live without a restart.

Open a terminal inside the development desktop to open preferences:

```bash
gnome-extensions prefs panthea@local
```

GNOME 50 uses `--devkit`, not the older `--nested` flag. The underlying documented command is `dbus-run-session gnome-shell --devkit --wayland`. Panthea's wrapper also isolates settings, extension installation, cache, and runtime files. The system bus and host PipeWire server remain shared. The development desktop is not a security sandbox.

Shell logs appear in the launching terminal. For normal-session logs, use:

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell
```

Run the bounded integration checks with a visible development window or a headless compositor:

```bash
bash scripts/panthea test --devkit
bash scripts/panthea test --headless
bash scripts/panthea test --headless --no-animations
bash scripts/panthea test --headless --layout
bash scripts/panthea test --headless --layout --no-animations
```

The tests use Fedora's `gnome-shell-test-tool`, an isolated settings backend, and the built extension bundle. The `--no-animations` run repeats the checks with GNOME animations disabled. Tests stop after two minutes if Shell does not finish. Screenshots are written to `/tmp/opencode/panthea-tests/`. The environment may log unavailable session services or input-method warnings that require comparison with an unmodified nested Shell before attribution.

The focused `--layout` suite checks native layout and folder synchronization, pointer dragging, cross-page moves, folder controls, live favorites, and drag cleanup. It uses the same isolated settings backend and does not change your normal GNOME layout.

## Install in your normal session

First disable overlapping launcher, dock, visibility, and panel-style extensions. Known active overlaps cause Panthea to refuse activation rather than change another extension's settings. These include Dash to Dock, Bottom Dash Panel, Just Perfection, ArcMenu, AutoColor Top Bar, and Transparent Top Bar.

```bash
bash scripts/panthea install
```

Save your work, log out, and log back in so GNOME discovers the installation and loads fresh modules. Then run:

```bash
gnome-extensions enable panthea@local
gnome-extensions prefs panthea@local
```

Do not use `Alt+F2`, `r` to restart a Wayland session. GNOME 50 no longer supports that workflow.

Disable or remove Panthea with:

```bash
gnome-extensions disable panthea@local
bash scripts/panthea remove
```

Disabling removes the dock and launcher and restores the original Dash styles and any hidden native controls. Uninstalling preserves preferences for a later reinstall. It does not modify system GNOME files. If Panthea causes trouble, disable it using a terminal or GNOME Extensions before re-enabling overlapping extensions.

## Behavior

### Applications

- Applications sits immediately after Activities and remains clickable if Activities is hidden.
- The launcher searches applications using GNOME's native desktop-file search and usage ranking. It respects hidden applications and GNOME's parental-control filter.
- Grid view is paginated. List view shows Favorites first, All Applications second, and the remaining desktop-file categories alphabetically. Favorites uses GNOME's favorite apps and updates live. List results use one vertically scrollable list with no pagination controls. Both views use the same applications and native icons. Sparse results keep standard row sizes and start at the top left. Grid page dots show the actual page count and hide when only one page remains.
- The grid reads and edits GNOME's `org.gnome.shell` / `app-picker-layout` and `org.gnome.desktop.app-folders` settings, with no separate layout storage. Native ordering, folder names, membership, category rules, and exclusions update live. Panthea fits the overall order into its own pages rather than copying GNOME's page sizes. Apps without saved positions follow positioned items alphabetically. Favorites remain visible in Panthea's grid and folders even though GNOME's native grid hides them.
- Drag an app or folder onto a tile's side edge to reorder it. Drop an app onto another app's center to create a folder, or onto a folder's center to add it. Hold a drag over a page arrow to move between pages. Open a folder to reorder its apps, rename it, or dissolve it. Use an app's context menu inside a folder to remove it. Dissolving a folder returns its apps to the grid without uninstalling anything. Only completed edits update GNOME's native grid, and external layout changes cancel stale drags without saving them. Grid editing is unavailable during search, in category lists, or when the required settings are locked.
- The launcher remembers its view. Search spans all applications rather than only the selected category.
- View buttons sit beside search. Grid pages have edge arrows with reserved gutters that keep arrows clear of applications. Arrows appear only when another page exists. Chevrons have at least 40×40 logical-pixel targets, and page dots have at least 32×32 targets. Both show keyboard focus outlines. Focused dots also use their hover appearance. The menu keeps its width and adapts the column count to the available space.
- Right-click an application, or press the Menu key or Shift+F10, for GNOME's native application menu, including favorites and window actions.
- Enter launches the first search result. Down moves from search into results. Arrow keys navigate results, Page Up/Down change grid pages or scroll the list, and Ctrl+1/Ctrl+2 change views. List results scroll independently of the category sidebar and keep keyboard-focused applications visible. Changing the category, query, or view resets list scrolling. Click a grid page dot to jump to that page, or focus it with Tab and press Space. The view buttons show "Grid View" and "Category View" tooltips using GNOME Shell's native style. Pagination tooltips use the same style and match their accessible names: "Previous page", "Next page", and "Page X of Y". Tab uses native focus navigation.
- Escape clears a search first, returns from an open folder next, then closes the menu. GNOME's Super key, Overview, application grid, and shortcuts are not replaced.

Search does not run commands, query files, calculate expressions, or load Pantheon search plugins. Categories come from desktop-file metadata rather than a separate menu library.

### Dock and panel

- The dock is centered at the bottom of the primary monitor. Changes to the primary monitor reposition it.
- Small, Medium, and Large select maximum icon sizes of 32, 48, and 64 logical pixels. The native Dash shrinks icons when space is limited.
- In Never mode, maximized windows stop 1-2 logical pixels above the visible dock. The reserved area follows its height when additional applications make the icons smaller.
- Hide Dock offers five radio choices: Never (default), When the focused window is maximized, When the focused window overlaps the dock, When any window overlaps the dock, and When not being used. Overlap uses window frames on the active workspace, excluding minimized windows. Maximized means maximized in both directions on the dock's monitor.
- Never reserves space above the dock. Automatic modes release that reservation; revealed docks overlay windows rather than resizing them back and forth. Move the pointer to the bottom edge beneath the dock to reveal it. Hover, keyboard focus, application menus, dragging, and Overview keep it open. Slides use native GNOME animations and respect disabled animations. Window and pointer events drive updates without periodic polling.
- Actual fullscreen applications temporarily cover both the dock and its reveal strip and retain GNOME's full-monitor geometry. The selected hiding behavior resumes when fullscreen ends.
- Favorites, running applications across workspaces, multiple windows, drag-and-drop favorite management, application menus, and Show Apps come from GNOME's Dash. There is no separate favorites database or window tracker.
- Show Apps Button in Dock & Panel preferences shows or hides the dock's native button and reclaims its width. It is enabled by default. GNOME's shortcuts and other access to Show Apps remain unchanged.
- Panel Translucency uses the wallpaper-selected appearance by default. Calm wallpapers use a fully transparent panel with light or dark controls. Busy wallpapers use white at 50% opacity with dark controls in light appearance, or black at 30% opacity with light controls in dark appearance. A non-minimized normal window on the primary monitor's active workspace that is fully maximized or fullscreen replaces only a fully transparent panel background with the dock's dark translucent background. Existing light or dark translucent panel backgrounds remain unchanged. When no window qualifies, the wallpaper-selected appearance returns. Native panel transitions animate the change. Fullscreen styling never reveals the panel or dock or changes window geometry. Overview retains GNOME's transparent panel and light controls, without changing the dock background.
- Wallpaper analysis reads a downscaled image asynchronously on wallpaper, appearance, or monitor changes, not by capturing the screen or polling. It accounts for zoom, scaled, stretched, and spanned placement, background colors, and gradients. Unsupported placements, XML slideshows, and unreadable images use the light or dark translucent fallback for the system appearance. Contrast and sharpness follow Wingpanel's approach, but downsampling makes this an approximation rather than a pixel-identical reproduction.
- Panel and dock backgrounds derive from the same wallpaper-selected state and share their color and opacity definitions. When the wallpaper selects a translucent panel, the dock uses that same light or dark background regardless of window state. When the wallpaper selects a transparent panel, the dock uses black at 30% opacity instead. Overview keeps the panel transparent without changing the dock background. Controls on each surface follow its foreground contrast. Blur is disabled on both because GNOME's native background effect does not mask the dock's rounded corners cleanly. Turning Panel Translucency off restores theme-defined panel and dock styling. The existing `automatic-translucency` settings key is unchanged.

GNOME handles the lock screen. Panthea is enabled only for the normal user session, not the login screen or unlock dialog.

### Preferences and visibility

Preferences use GTK4 and Libadwaita. The pages are Applications, Dock & Panel, and Visibility. Visibility groups dropdown controls under Quick Settings, its panel status icons under Quick Settings Indicators, and all other panel elements under Top Panel. Search is available in the preferences window.

Visibility settings hide interface elements without stopping services or changing power profiles, radios, or Night Light. Restoring a control uses GNOME's current hardware and service availability. Unsupported hardware controls remain hidden. All visibility settings default to shown.

Hiding the whole Quick Settings button removes mouse access to that menu. Hiding screen-sharing or recording indicators removes visible warnings. The preferences explain these consequences. Camera and microphone privacy indicators are not included in those settings.

## Source inventory

The Just Perfection inventory was checked against installed version 37 and the GitHub mirror at commit `a46f18957422210411f5675e462c73d47e79266e`. GitLab access was blocked, so equivalence to GitLab HEAD was not independently verified.

### Visibility options and source

| Just Perfection key | Panthea setting | GNOME 50 target |
| --- | --- | --- |
| `quick-settings` | Quick Settings button (Top Panel) | Whole native menu button |
| `quick-settings-dark-mode` | Dark Style tile (Quick Settings) | Dark Style tile |
| `quick-settings-night-light` | Night Light tile (Quick Settings) | Night Light tile, when supported |
| `quick-settings-do-not-disturb` | Do Not Disturb tile (Quick Settings) | Do Not Disturb tile, available since GNOME 49 |
| `quick-settings-backlight` | Keyboard Backlight tile (Quick Settings) | Keyboard brightness tile, not the display brightness slider |
| `quick-settings-airplane-mode` | Airplane Mode tile (Quick Settings) | Airplane Mode tile, subject to radio availability |

Just Perfection does not provide a Power Mode tile visibility option. Panthea includes it separately. Just Perfection's `power-icon` controls the panel's power icon, not Power Mode.

### Top panel controls

Panthea includes Just Perfection's relevant Activities, clock/calendar, notification dot, keyboard layout, accessibility, power icon, Quick Settings button, screen-sharing indicator, and screen-recording indicator controls. It adds independent network, Bluetooth, audio-output, Power Mode, and Night Light indicators.

The power-icon setting hides the icon only. Battery percentage continues to follow GNOME's existing setting. The notification-dot setting also hides GNOME's balancing spacer. Whole-panel hiding, panel-in-Overview modes, repositioning, sizing, and unrelated Just Perfection features are not included.

## Code and maintenance

| Component | Responsibility |
| --- | --- |
| `extension.js` | Lifecycle, live feature switches, panel registration, overlap checks |
| `lib/dock.js` | Extension-owned native Dash, bounded icon sizing, bottom geometry, struts |
| `lib/dockHiding.js` | Event-driven hiding, edge reveal, native slide transitions, stationary work-area reservation |
| `lib/launcher.js` | Retained native popup, search, bounded button pool, keyboard navigation, native application menus |
| `lib/catalog.js` | Cached application metadata, native search, favorites, parental filtering |
| `lib/appLayout.js`, `shared/appLayout.js` | Native layout and folder settings, ordering, membership, and edits |
| `lib/appearance.js`, `lib/wallpaper.js` | Wallpaper analysis, adaptive backgrounds, native Overview styling |
| `lib/shellTargets.js` | GNOME 50 visibility actor paths |
| `lib/visibility.js` | Reversible hidden parents that preserve native actor visibility bindings |
| `prefs.js`, `shared/`, `schemas/` | Separate preferences UI, common labels/model logic, GSettings contract |

The dock uses a new instance of GNOME's Dash. Moving the existing Overview Dash would couple desktop placement to Overview allocation and startup animations. A fully independent dock would duplicate favorites, drag-and-drop, application menus, and window behavior. The small native subclass bounds icon size and clears completed drag-monitor references. The hidden Overview Dash retains a layout slot matching the permanent dock's height. Panthea does not replace existing Shell methods or prototypes.

The launcher uses St widgets and native application APIs rather than embedding GNOME's full Overview application display. Embedding that display would also bring Overview transitions and folder editing without providing the required category-list view.

GLib, Gio, GObject, GTK4, Libadwaita, and GSettings provide the platform APIs. Shell, St, Clutter, Mutter, and Shell JavaScript UI classes depend on the GNOME version and do not form a stable extension ABI. Unavoidable private integrations include Dash internals, Overview Dash visibility/height, panel containers, Quick Settings actor paths and grid metadata, and application menus. Layout editing also uses native drag cancellation and GNOME's folder-deletion guard while resetting deleted folder settings. These integrations require review against each GNOME release. Support is deliberately limited to GNOME 50 rather than bypassing version validation.

Application catalog work yields after a three-millisecond budget per idle dispatch. Search uses GNOME's cached native search. The menu reuses a pool of application buttons bounded by the catalog size. Grid view keeps only one page parented, while list view parents all matching results inside a native scroll view. Results update when their data or layout changes. Updates are triggered by settings, applications, favorites, themes, monitors, workspaces, and window state, not polling. Native animations and reduced-animation behavior remain in GNOME's control.

Essential actors and styles are created during `enable()`. Catalog preparation runs in bounded idle work. There are no arbitrary startup delays. GNOME controls when extensions load, so Panthea cannot guarantee that the unmodified desktop is never drawn before `enable()`. A loading message is available if the launcher opens before application metadata or parental controls are ready. Real-login startup recording is still required.

## Acceptance checks

Automated checks cover syntax, schema validation, category/pagination logic, settings inventory, native Shell activation, launcher views and navigation, visibility restoration, dock sizing, and enable/disable cycles. The desktop test also exercises application menus, favorites, maximization, fullscreen, workspaces, appearance changes, and preferences. Consult the actual test output rather than treating this list as a claim that every check passed.

Before normal use, finish these real-desktop checks:

- Record a fresh login and look for unmodified-panel flashes, incorrect dock size, or temporary work-area changes.
- Check first and repeated menu openings, rapid search, category changes, context menus, and keyboard-only operation.
- Test native favorite reordering and multiple windows, including windows on different workspaces.
- Toggle visibility while menus are open and while hardware availability changes.
- Change primary monitors, connect/disconnect displays, and test fractional scaling and mixed-DPI displays.
- Check maximization, tiling, fullscreen video/games, workspace transitions, light/dark appearance, larger text, and reduced animations.
- Compare idle and active CPU, memory, and frame timings with Panthea disabled and enabled under the same workload. Nested-session samples are diagnostic, not a real-session performance guarantee.
- Disable and re-enable Panthea, including while the launcher or an application menu is open. Confirm the native desktop returns without stale actors or errors.

## References and license

- [GNOME extension development](https://gjs.guide/extensions/development/creating.html), [best practices](https://gjs.guide/extensions/review-guidelines/best-practices.html), and [compatibility guidance](https://gjs.guide/extensions/overview/updates-and-breakage.html).
- [GNOME Shell 50.6](https://github.com/GNOME/gnome-shell/tree/50.6), including Dash, application menus, panel, Quick Settings, and the native test tool.
- [Just Perfection source](https://github.com/jrahmatzadeh/just-perfection/tree/a46f18957422210411f5675e462c73d47e79266e/src) for the visibility inventory.
- [Elementary Applications Menu](https://github.com/elementary/applications-menu), [Wingpanel](https://github.com/elementary/wingpanel), [Gala](https://github.com/elementary/gala), [Settings](https://github.com/elementary/settings), and [Granite](https://github.com/elementary/granite) as behavior and layout references, not dependencies.
- [Wingpanel background states](https://github.com/elementary/wingpanel/blob/main/wingpanel-interface/BackgroundManager.vala), [panel styling](https://github.com/elementary/wingpanel/blob/main/data/styles/Application.css), and [elementary Dock styling](https://github.com/elementary/dock/blob/main/data/Application.css) inform the adaptive appearance. Panthea uses GNOME APIs rather than Pantheon's compositor protocol or texture readback.
- [Bottom Dash Panel](https://github.com/fthx/bottom-dash-panel) and [Dash to Dock](https://github.com/micheleg/dash-to-dock) as dock integration references. Panthea does not adopt their startup delays, full-extension restarts for settings, or larger compatibility layers.

Panthea is GPL-3.0-or-later. See `LICENSE` for the complete GPL version 3 text. Native GNOME modules retain their upstream licenses. No Pantheon assets, widgets, or code are bundled.
