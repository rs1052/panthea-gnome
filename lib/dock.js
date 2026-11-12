// SPDX-License-Identifier: GPL-3.0-or-later
// Integrates GNOME Shell 50's GPL-licensed Dash without moving the Overview's actor.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DOCK_SIZES} from '../shared/options.js';
import {Connections} from './signals.js';
import {DockHiding} from './dockHiding.js';
import {DockTransition} from './dockTransition.js';
import {IndicatorColors, WindowIndicators} from './windowIndicators.js';
import {Workspaces} from './workspaces.js';
import {WorkspaceButtons} from './workspaceButtons.js';

const PantheaDash = GObject.registerClass({
    Signals: {'menu-state-changed': {param_types: [GObject.TYPE_BOOLEAN]}},
},
class PantheaDash extends Dash.Dash {
    _init(settings) {
        super._init();
        this._indicatorSettings = settings;
        this._indicatorColors = new IndicatorColors();
        this.connect('destroy', () => this._indicatorColors.destroy());
        this.preferredIconSize = 48;
        // Native Dash binds the background height to Show Apps' allocation.
        // A hidden button is not allocated, so use its themed icon height
        // instead. Keep the native width binding intact.
        this._backgroundSizer = this._background.get_first_child();
        for (const constraint of this._backgroundSizer.get_constraints()) {
            if (constraint instanceof Clutter.BindConstraint &&
                constraint.coordinate === Clutter.BindCoordinate.HEIGHT)
                this._backgroundSizer.remove_constraint(constraint);
        }
    }

    _createAppItem(app) {
        const item = super._createAppItem(app);
        const icon = item.child;
        icon._pantheaIndicators = new WindowIndicators(icon, this._indicatorSettings, this._indicatorColors);
        return item;
    }

    // The native size chooser has no configurable upper bound. Keep this
    // override local to our instance, retaining native redisplay, DND and icons.
    _adjustIconSize() {
        if (this._maxWidth < 0)
            return;

        const items = this._box.get_children().filter(item =>
            item.child?._delegate?.icon && !item.animatingOut);
        if (this._showAppsIcon.visible)
            items.push(this._showAppsIcon);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // The retained native icon also provides the background's height when
        // no buttons are visible. Never divide by zero for an empty dock.
        const first = (items[0] ?? this._showAppsIcon).child;
        const icon = first._delegate.icon;
        icon.icon.ensure_style();
        const [, iconWidth] = icon.icon.get_preferred_width(-1);
        const [, buttonWidth] = first.get_preferred_width(-1);
        const [, iconHeight] = icon.icon.get_preferred_height(-1);
        const [, buttonHeight] = first.get_preferred_height(-1);
        const spacing = this._box.get_theme_node().get_length('spacing');
        const padding = this.get_theme_node().get_horizontal_padding() +
            this._background.get_theme_node().get_horizontal_padding();
        const separator = this._separator
            ? this._separator.get_preferred_width(-1)[1] + spacing : 0;
        const workspaceCount = this.workspaces?.count ?? 0;
        const workspaceSeparator = workspaceCount ? this.workspaces.separator.get_preferred_width(-1)[1] : 0;
        const count = items.length + workspaceCount;
        const available = this._maxWidth - padding - separator - workspaceSeparator -
            Math.max(0, items.length - 1) * spacing - count * (buttonWidth - iconWidth);
        const availableHeight = this._maxHeight - this.margin_top - this.margin_bottom -
            this._background.get_theme_node().get_vertical_padding() -
            this.get_theme_node().get_vertical_padding() - (buttonHeight - iconHeight);
        const widthLimit = count
            ? Math.min(this.preferredIconSize, available / count / scale)
            : this.preferredIconSize;
        const upper = Math.min(widthLimit, availableHeight / scale);
        const size = [16, 22, 24, 32, 48, 64].filter(value => value <= upper).at(-1) ?? 16;
        // Only the workspace strip scrolls if the minimum size cannot fit.
        // Keep native app items outside it so favorite DND remains unchanged.
        const tileWidth = size * scale + buttonWidth - iconWidth;
        this.workspaceMaxWidth = Math.max(tileWidth, this._maxWidth - padding - separator -
            workspaceSeparator - items.length * tileWidth - Math.max(0, items.length - 1) * spacing);
        this.workspaceButtonWidth = tileWidth;
        this.workspaces?.setSize(size, tileWidth, this.workspaceMaxWidth);
        if (size === this.iconSize) {
            this._syncBackgroundHeight();
            return;
        }

        this.iconSize = size;
        for (const item of items)
            item.child._delegate.icon.setIconSize(size);
        this._showAppsIcon.icon.setIconSize(size);
        this._syncBackgroundHeight();
        if (this._separator)
            this._separator.height = size * scale;
        this.emit('icon-size-changed');
    }

    _syncBackgroundHeight() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const height = this.iconSize * scale;
        this._backgroundSizer.height = this._showAppsIcon.icon.get_theme_node()
            .adjust_preferred_height(height, height)[1];
    }

    _endItemDrag() {
        super._endItemDrag();
        // Native Dash retains the removed monitor. Clear our instance's
        // reference so disable() cannot remove that monitor a second time.
        this._dragMonitor = null;
    }

    _itemMenuStateChanged(item, opened) {
        super._itemMenuStateChanged(item, opened);
        this.emit('menu-state-changed', opened);
    }
});

export class Dock {
    constructor(settings) {
        this._settings = settings;
        this._signals = new Connections();
        this._geometryId = 0;
        this._separatorId = 0;
        this._separatorStopped = false;
        this._nativeIndicators = new Map();
        try {
            this._init(settings);
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    _init(settings) {
        this.nativeDash = Main.overview.dash;
        this._originalShowAppsVisible = this.nativeDash.showAppsButton.visible;
        this._originalShowAppsIconVisible = this.nativeDash._showAppsIcon.visible;
        this.nativeDash.add_style_class_name('panthea-dash');
        this._nativeBackgroundSizer = this.nativeDash._background.get_first_child();
        this._nativeHeightConstraint = this._nativeBackgroundSizer.get_constraints().find(constraint =>
            constraint instanceof Clutter.BindConstraint &&
            constraint.coordinate === Clutter.BindCoordinate.HEIGHT);
        this._nativeBackgroundHeight = this._nativeBackgroundSizer.height;
        this._nativeBackgroundHeightSet = this._nativeBackgroundSizer.height_set;
        if (this._nativeHeightConstraint)
            this._nativeBackgroundSizer.remove_constraint(this._nativeHeightConstraint);

        this.dash = new PantheaDash(settings);
        for (const dash of [this.dash, this.nativeDash])
            this._signals.connect(dash, 'destroy', () => this._stopSeparatorSize());
        this._workspaces = new Workspaces();
        this.dash.workspaces = new WorkspaceButtons(this.dash, this._workspaces, settings);
        this._nativeWorkspaces = new WorkspaceButtons(this.nativeDash, this._workspaces, settings);
        let workspaceCount = this.dash.workspaces.count;
        this._signals.connect(this._workspaces, 'changed', () => {
            if (workspaceCount === this.dash.workspaces.count)
                return;
            workspaceCount = this.dash.workspaces.count;
            this._queueGeometry();
        });
        this._signals.connect(this.nativeDash._box, 'child-added', () => this._syncNativeIndicators());
        this._signals.connect(this.nativeDash._box, 'child-removed', () => this._syncNativeIndicators());
        this._syncNativeIndicators();
        this.dash.add_style_class_name('panthea-dash');
        this.dash.reactive = true;
        this.dash.track_hover = true;
        this.actor = new St.Widget({
            name: 'panthea-dock',
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
        });
        this.dash.x_align = Clutter.ActorAlign.CENTER;
        this.dash.y_align = Clutter.ActorAlign.END;
        this.actor.add_child(this.dash);
        Main.layoutManager.addChrome(this.actor, {trackFullscreen: true});
        this._hiding = new DockHiding(this, settings);

        this._transition = new DockTransition(this);
        this._signals.connect(this.nativeDash, 'icon-size-changed', () => this._syncNativeIconSize());
        this._signals.connect(this.nativeDash, 'notify::allocation', () => {
            if (this.nativeDash._maxHeight !== this.dash._maxHeight)
                this._queueGeometry();
        });
        this._signals.connect(this.dash.showAppsButton, 'clicked', () => {
            if (Main.overview.visible)
                this.nativeDash.showAppsButton.checked = this.dash.showAppsButton.checked;
            else
                Main.overview.showApps();
        });
        this._signals.connect(this.nativeDash.showAppsButton, 'notify::checked', () => {
            this.dash.showAppsButton.checked = this.nativeDash.showAppsButton.checked;
        });
        this._signals.connect(settings, 'changed::dock-icon-size', () => this._updateSize());
        this._signals.connect(settings, 'changed::show-apps-button', () => this._syncShowApps());
        this._signals.connect(settings, 'changed::workspace-controls', () => this._queueGeometry());
        this._signals.connect(Main.layoutManager, 'monitors-changed', () => this._syncGeometry());
        this._signals.connect(St.ThemeContext.get_for_stage(global.stage), 'changed', () => this._queueGeometry());
        this._signals.connect(this.dash, 'notify::height', () => this._queueGeometry());
        this._signals.connect(this.dash, 'notify::width', () => this._queueGeometry());
        this._signals.connect(this.dash, 'icon-size-changed', () => this._queueGeometry());
        this._syncShowApps();
        this._updateSize();
    }

    get background() {
        return this.dash._background;
    }

    _syncNativeIndicators() {
        const icons = new Set(this.nativeDash._box.get_children()
            .map(item => item.child).filter(icon => icon?.app && icon._dot));
        for (const [icon, indicator] of this._nativeIndicators) {
            if (!icons.has(icon)) {
                indicator.destroy();
                this._nativeIndicators.delete(icon);
            }
        }
        for (const icon of icons) {
            if (!this._nativeIndicators.has(icon)) {
                const indicator = new WindowIndicators(icon, this._settings, this.dash._indicatorColors);
                icon._pantheaIndicators = indicator;
                this._nativeIndicators.set(icon, indicator);
            }
        }
        this._queueSeparatorSize();
    }

    _syncShowApps() {
        const visible = this._settings.get_boolean('show-apps-button');
        this.dash.showAppsButton.visible = visible;
        this.dash._showAppsIcon.visible = visible;
        this.dash._showAppsIcon.hideLabel();
        this.dash._queueRedisplay();
        this.nativeDash.showAppsButton.visible = visible;
        this.nativeDash._showAppsIcon.visible = visible;
        this.nativeDash._showAppsIcon.hideLabel();
        this.nativeDash._queueRedisplay();
        this._queueGeometry();
    }

    _syncNativeIconSize() {
        const dash = this.nativeDash;
        // Native Dash emits before applying its chosen size to the icons.
        // Use the shared width- and height-bounded size in both directions.
        dash.iconSize = this.dash.iconSize;
        this._nativeWorkspaces.setSize(dash.iconSize, this.dash.workspaceButtonWidth,
            this.dash.workspaceMaxWidth);
        for (const item of [...dash._box.get_children(), dash._showAppsIcon])
            item.child?._delegate?.icon?.setIconSize(dash.iconSize);
        const height = dash.iconSize * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._nativeBackgroundSizer.height = dash._showAppsIcon.icon.get_theme_node()
            .adjust_preferred_height(height, height)[1];
        this._queueSeparatorSize();
    }

    _queueSeparatorSize() {
        if (this._separatorId || this._separatorStopped)
            return;
        // Native redisplay creates and sizes separators after choosing icons.
        // Apply the shared, scaled height after it finishes, before redraw.
        this._separatorId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._separatorId = 0;
            const height = this.dash.iconSize * St.ThemeContext.get_for_stage(global.stage).scale_factor;
            for (const dash of [this.dash, this.nativeDash]) {
                if (dash._separator) {
                    dash._separator.remove_transition('height');
                    dash._separator.height = height;
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopSeparatorSize() {
        this._separatorStopped = true;
        if (this._separatorId)
            global.compositor.get_laters().remove(this._separatorId);
        this._separatorId = 0;
    }

    _updateSize() {
        this.dash.preferredIconSize = DOCK_SIZES[this._settings.get_int('dock-icon-size')];
        this._syncGeometry();
        this.dash._queueRedisplay();
    }

    _queueGeometry() {
        if (this._geometryId)
            return;
        this._geometryId = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this._geometryId = 0;
            this._syncGeometry();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncGeometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // Overview owns its available height. Respect that same limit on the
        // desktop so its allocation cannot squash only the Overview dock.
        const maxHeight = this.nativeDash._maxHeight > 0
            ? this.nativeDash._maxHeight : monitor.height / 3;
        this.dash.setMaxSize(Math.max(1, monitor.width - 24 * scale), maxHeight);
        this.dash._adjustIconSize();
        const [, naturalHeight] = this.dash.get_preferred_height(monitor.width);
        // Reserve the visible dock plus a two-pixel gap, including when icons shrink.
        const height = Math.ceil(naturalHeight + 2 * scale);
        this.actor.set_position(monitor.x, monitor.y + monitor.height - height);
        this.actor.set_size(monitor.width, height);
        this._syncNativeIconSize();
        this.nativeDash._queueRedisplay();
        this._hiding.syncGeometry(monitor, height);
    }

    destroy() {
        if (this._geometryId)
            GLib.Source.remove(this._geometryId);
        this._geometryId = 0;
        this._stopSeparatorSize();
        this._transition?.destroy();
        this._hiding?.destroy();
        this._signals.clear();
        this._nativeWorkspaces?.destroy();
        this.dash?.workspaces?.destroy();
        this._workspaces?.destroy();
        for (const indicator of this._nativeIndicators.values())
            indicator.destroy();
        this._nativeIndicators.clear();
        // Native Dash owns two hover sources but does not remove them on destroy.
        for (const key of ['_showLabelTimeoutId', '_resetHoverTimeoutId']) {
            if (this.dash?.[key])
                GLib.Source.remove(this.dash[key]);
            if (this.dash)
                this.dash[key] = 0;
        }
        if (this.dash?._dragMonitor)
            this.dash._endItemDrag();
        if (this.actor) {
            // Finish initial allocation while staged if enable() failed before
            // the first frame, rather than leaving an unallocated chrome actor.
            if (this.actor.get_stage()) {
                this.actor.get_allocation_box();
                Main.layoutManager.removeChrome(this.actor);
            }
            this.actor.destroy();
        } else {
            this.dash?.destroy();
        }
        if (!this.nativeDash)
            return;
        this.nativeDash.remove_style_class_name('panthea-dash');
        this.nativeDash.showAppsButton.visible = this._originalShowAppsVisible;
        this.nativeDash._showAppsIcon.visible = this._originalShowAppsIconVisible;
        this._nativeBackgroundSizer?.set_height(this._nativeBackgroundHeightSet ? this._nativeBackgroundHeight : -1);
        if (this._nativeHeightConstraint)
            this._nativeBackgroundSizer.add_constraint(this._nativeHeightConstraint);
        if (this.nativeDash._separator)
            this.nativeDash._separator.height = this.nativeDash.iconSize;
        this.nativeDash._queueRedisplay();
        this.actor = null;
        this.dash = null;
    }
}
