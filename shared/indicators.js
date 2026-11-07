// SPDX-License-Identifier: GPL-3.0-or-later

// Saturation-weighted icon color, following Dash to Dock's Unity-inspired
// palette. Respect rowstride, RGB images and transparent pixels explicitly.
export function dominantColor(image) {
    const pixels = image.get_pixels();
    const channels = image.n_channels;
    const totals = [0, 0, 0];
    let weight = 0;
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const offset = y * image.rowstride + x * channels;
            const rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
            const alpha = image.has_alpha ? pixels[offset + 3] / 255 : 1;
            const saturation = (Math.max(...rgb) - Math.min(...rgb)) / 255;
            const relevance = alpha * (0.1 + 0.9 * saturation);
            for (let channel = 0; channel < 3; channel++)
                totals[channel] += rgb[channel] * relevance;
            weight += relevance;
        }
    }
    if (!weight)
        return null;

    const rgb = totals.map(value => value / weight);
    const max = Math.max(...rgb);
    const min = Math.min(...rgb);
    const delta = max - min;
    if (!delta)
        return 'rgb(230,230,230)';
    const saturation = delta / max > 0.15 ? 0.65 : delta / max;
    // Preserve hue while normalizing saturation and brightness.
    const result = rgb.map(value => Math.round(255 * 0.9 *
        (1 - saturation + saturation * (value - min) / delta)));
    return `rgb(${result.join(',')})`;
}
