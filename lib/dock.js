// SPDX-License-Identifier: GPL-3.0-or-later
// Integrates GNOME Shell 50's GPL-licensed Dash without moving the Overview's actor.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DOCK_SIZES} from '../shared/options.js';
import {Connections} from './signals.js';
import {DockHiding} from './dockHiding.js';

const PantheaDash = GObject.registerClass({
    Signals: {'menu-state-changed': {param_types: [GObject.TYPE_BOOLEAN]}},
},
class PantheaDash extends Dash.Dash {
    _init() {
        super._init();
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
        const spacing = this._box.get_theme_node().get_length('spacing');
        const padding = this.get_theme_node().get_horizontal_padding() +
            this._background.get_theme_node().get_horizontal_padding();
        const separator = this._separator
            ? this._separator.get_preferred_width(-1)[1] + spacing : 0;
        const available = this._maxWidth - padding - separator -
            Math.max(0, items.length - 1) * spacing - items.length * (buttonWidth - iconWidth);
        const upper = items.length
            ? Math.min(this.preferredIconSize, available / items.length / scale)
            : this.preferredIconSize;
        const size = [16, 22, 24, 32, 48, 64].filter(value => value <= upper).at(-1) ?? 16;
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
        this.nativeDash = Main.overview.dash;

        this.dash = new PantheaDash();
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

        this._signals.connect(Main.overview, 'showing', () => this._syncOverview());
        this._signals.connect(Main.overview, 'hidden', () => this._syncOverview());
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
        this._signals.connect(Main.layoutManager, 'monitors-changed', () => this._syncGeometry());
        this._signals.connect(St.ThemeContext.get_for_stage(global.stage), 'changed', () => this._queueGeometry());
        this._signals.connect(this.dash, 'notify::height', () => this._queueGeometry());
        this._signals.connect(this.dash, 'notify::width', () => this._queueGeometry());
        this._signals.connect(this.dash, 'icon-size-changed', () => this._queueGeometry());
        this._syncShowApps();
        this._updateSize();
        this._syncOverview();
    }

    get background() {
        return this.dash._background;
    }

    _syncOverview() {
        // Keep native Overview stacking and input handling, including captions.
        this.dash.visible = !Main.overview.visible;
    }

    _syncShowApps() {
        const visible = this._settings.get_boolean('show-apps-button');
        this.dash.showAppsButton.visible = visible;
        this.dash._showAppsIcon.visible = visible;
        this.dash._showAppsIcon.hideLabel();
        this.dash._queueRedisplay();
        this._queueGeometry();
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
        this.dash.setMaxSize(Math.max(1, monitor.width - 24 * scale), monitor.height / 3);
        this.dash._adjustIconSize();
        const [, naturalHeight] = this.dash.get_preferred_height(monitor.width);
        // Reserve the visible dock plus a two-pixel gap, including when icons shrink.
        const height = Math.ceil(naturalHeight + 2 * scale);
        this.actor.set_position(monitor.x, monitor.y + monitor.height - height);
        this.actor.set_size(monitor.width, height);
        this._hiding.syncGeometry(monitor, height);
    }

    destroy() {
        if (this._geometryId)
            GLib.Source.remove(this._geometryId);
        this._geometryId = 0;
        this._hiding.destroy();
        this._signals.clear();
        // Native Dash owns two hover sources but does not remove them on destroy.
        for (const key of ['_showLabelTimeoutId', '_resetHoverTimeoutId']) {
            if (this.dash[key])
                GLib.Source.remove(this.dash[key]);
            this.dash[key] = 0;
        }
        if (this.dash._dragMonitor)
            this.dash._endItemDrag();
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
        this.actor = null;
        this.dash = null;
    }
}
