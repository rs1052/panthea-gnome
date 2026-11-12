// SPDX-License-Identifier: GPL-3.0-or-later

// Saturation-weighted icon color, following Dash to Dock's Unity-inspired
// palette. Respect rowstride, RGB images and transparent pixels explicitly.
export function dominantColor(image) {
    const pixels = image.get_pixels();
    const channels = image.n_channels;
    const totals = [0, 0, 0];
    let weight = 0;
    let visible = false;
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const offset = y * image.rowstride + x * channels;
            const rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
            const alpha = image.has_alpha ? pixels[offset + 3] / 255 : 1;
            if (!alpha)
                continue;
            visible = true;
            const max = Math.max(...rgb);
            const delta = max - Math.min(...rgb);
            // Neutral pixels must not compete with the inactive workspace gray.
            if (!max || delta / max <= 0.15)
                continue;
            const saturation = delta / 255;
            const relevance = alpha * (0.1 + 0.9 * saturation);
            for (let channel = 0; channel < 3; channel++)
                totals[channel] += rgb[channel] * relevance;
            weight += relevance;
        }
    }
    if (!weight)
        return visible ? 'rgb(64,64,64)' : null;

    const rgb = totals.map(value => value / weight);
    const max = Math.max(...rgb);
    const min = Math.min(...rgb);
    const delta = max - min;
    if (delta / max <= 0.15)
        return 'rgb(64,64,64)';
    const saturation = 0.65;
    // Preserve hue while normalizing saturation and brightness.
    const result = rgb.map(value => Math.round(255 * 0.9 *
        (1 - saturation + saturation * (value - min) / delta)));
    return `rgb(${result.join(',')})`;
}
