// SPDX-License-Identifier: GPL-3.0-or-later

// Wingpanel's brightness/contrast thresholds, applied to a bounded image sample
// rather than compositor readback. Acutance is approximate after downscaling.
// https://github.com/elementary/wingpanel/blob/main/wingpanel-interface/BackgroundManager.vala
export function panelState(luminances, width) {
    const count = luminances.length;
    if (!count || width < 3)
        return 'translucent';
    const mean = luminances.reduce((sum, value) => sum + value, 0) / count;
    const variance = luminances.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
    const deviation = Math.sqrt(variance);
    const height = count / width;
    let acutance = 0;
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            acutance += Math.abs(4 * luminances[i] - luminances[i - 1] -
                luminances[i + 1] - luminances[i - width] - luminances[i + width]);
        }
    }
    acutance /= Math.max(1, (width - 2) * (height - 2));
    const busy = deviation > 45 || (mean < 180 && mean + 1.645 * deviation > 180) || acutance > 8;
    return busy ? 'translucent' : mean > 180 ? 'transparent-dark' : 'transparent-light';
}

// Map a desktop point to the wallpaper image, including centered crop/letterbox.
// Coordinates outside a scaled image use GNOME's configured background color.
export function wallpaperPoint(x, y, imageWidth, imageHeight, area, placement) {
    let width = area.width;
    let height = area.height;
    if (placement !== 'stretched') {
        const scale = placement === 'scaled'
            ? Math.min(width / imageWidth, height / imageHeight)
            : Math.max(width / imageWidth, height / imageHeight);
        width = imageWidth * scale;
        height = imageHeight * scale;
    }
    const u = (x - area.x - (area.width - width) / 2) / width;
    const v = (y - area.y - (area.height - height) / 2) / height;
    return u >= 0 && u < 1 && v >= 0 && v < 1
        ? [Math.floor(u * imageWidth), Math.floor(v * imageHeight)] : null;
}
