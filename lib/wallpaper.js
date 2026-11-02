// SPDX-License-Identifier: GPL-3.0-or-later

import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {panelState, wallpaperPoint} from '../shared/appearance.js';
import {Connections} from './signals.js';

export class Wallpaper {
    constructor(changed) {
        this._changed = changed;
        this._signals = new Connections();
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._sourceId = 0;
        this._cancellable = null;
        this._fileMonitor = null;
        this.state = 'translucent';
        this.ready = false;
        this._signals.connect(this._background, 'changed', () => this._queueRead());
        this._signals.connect(this._interface, 'changed::color-scheme', () => this._queueRead());
        this._signals.connect(Main.layoutManager, 'monitors-changed', () => this._queueRead());
        this._signals.connect(Main.panel, 'notify::height', () => this._queueRead());
        this._queueRead();
    }

    get dark() {
        return this._interface.get_string('color-scheme') === 'prefer-dark';
    }

    _queueRead() {
        this._cancellable?.cancel();
        if (this._sourceId)
            return;
        this._sourceId = GLib.idle_add_once(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._sourceId = 0;
            this._read();
        });
    }

    async _read() {
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._fileMonitor?.cancel();
        this._fileMonitor = null;
        this.state = 'translucent';
        this.ready = false;
        this._changed();
        let stream = null;
        try {
            const monitor = Main.layoutManager.primaryMonitor;
            if (!monitor)
                return;
            const override = GLib.getenv('SHELL_BACKGROUND_IMAGE');
            const placement = override !== null ? 'zoom' : this._background.get_string('picture-options');
            let image = null;
            if (placement !== 'none') {
                // Other placements and XML slideshows use a readable fallback.
                if (!['zoom', 'scaled', 'stretched', 'spanned'].includes(placement))
                    return;
                const uri = override ??
                    this._background.get_string(this.dark ? 'picture-uri-dark' : 'picture-uri');
                const file = Gio.File.new_for_commandline_arg(uri);
                if (!file.get_path() || file.get_basename()?.endsWith('.xml'))
                    return;
                this._fileMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
                this._fileMonitor.connect('changed', (_monitor, _file, _other, event) => {
                    if (event !== Gio.FileMonitorEvent.CHANGED && event !== Gio.FileMonitorEvent.CREATED)
                        this._queueRead();
                });
                stream = await new Promise((resolve, reject) => {
                    file.read_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                        try {
                            resolve(source.read_finish(result));
                        } catch (error) {
                            reject(error);
                        }
                    });
                });
                image = await new Promise((resolve, reject) => {
                    GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, 1024, 1024, true,
                        cancellable, (_source, result) => {
                            try {
                                resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(result));
                            } catch (error) {
                                reject(error);
                            }
                        });
                });
            }
            if (!cancellable.is_cancelled())
                this.state = this._sample(image, monitor, placement);
        } catch (error) {
            // Missing files, unsupported decoders and cancelled reads are expected.
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this.state = 'translucent';
        } finally {
            if (stream) {
                stream.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
                    try {
                        source.close_finish(result);
                    } catch {
                        // Closing a failed image stream must not affect Shell.
                    }
                });
            }
            if (!cancellable.is_cancelled()) {
                this.ready = true;
                this._changed();
            }
        }
    }

    _sample(image, monitor, placement) {
        const color = key => {
            const [valid, value] = Cogl.Color.from_string(this._background.get_string(key));
            return valid ? [value.red, value.green, value.blue] : [0, 0, 0];
        };
        const primary = color('primary-color');
        const secondary = color('secondary-color');
        const shading = this._background.get_string('color-shading-type');
        let area = monitor;
        if (placement === 'spanned') {
            const monitors = Main.layoutManager.monitors;
            const x = Math.min(...monitors.map(m => m.x));
            const y = Math.min(...monitors.map(m => m.y));
            area = {x, y,
                width: Math.max(...monitors.map(m => m.x + m.width)) - x,
                height: Math.max(...monitors.map(m => m.y + m.height)) - y};
        }
        const width = Math.min(512, monitor.width);
        const height = Math.max(3, Math.min(32, Main.panel.height));
        const pixels = image?.get_pixels();
        const values = [];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const desktopX = monitor.x + (x + 0.5) * monitor.width / width;
                const desktopY = monitor.y + (y + 0.5) * Main.panel.height / height;
                const fraction = shading === 'horizontal' ? (desktopX - area.x) / area.width
                    : shading === 'vertical' ? (desktopY - area.y) / area.height : 0;
                const rgb = primary.map((value, channel) => value + (secondary[channel] - value) * fraction);
                const point = image && wallpaperPoint(desktopX, desktopY,
                    image.width, image.height, area, placement);
                if (point) {
                    const offset = point[1] * image.rowstride + point[0] * image.n_channels;
                    const alpha = image.has_alpha ? pixels[offset + 3] / 255 : 1;
                    for (let channel = 0; channel < 3; channel++)
                        rgb[channel] += (pixels[offset + channel] - rgb[channel]) * alpha;
                }
                values.push(0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2]);
            }
        }
        return panelState(values, width);
    }

    destroy() {
        if (this._sourceId)
            GLib.Source.remove(this._sourceId);
        this._sourceId = 0;
        this._cancellable?.cancel();
        this._fileMonitor?.cancel();
        this._signals.clear();
    }
}
