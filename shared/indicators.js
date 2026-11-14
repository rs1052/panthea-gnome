// SPDX-License-Identifier: GPL-3.0-or-later

// Select a prominent icon accent, not an average of unrelated hues.
// Respect rowstride, RGB images and transparent pixels explicitly.
export function dominantColor(image) {
    const pixels = image.get_pixels();
    const channels = image.n_channels;
    const palette = Array.from({length: 12}, () => ({rgb: [0, 0, 0], weight: 0, coverage: 0}));
    let visible = 0;
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const offset = y * image.rowstride + x * channels;
            const rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
            const alpha = image.has_alpha ? pixels[offset + 3] / 255 : 1;
            if (!alpha)
                continue;
            visible += alpha;
            const max = Math.max(...rgb);
            const delta = max - Math.min(...rgb);
            // Relative saturation alone exaggerates tiny tints in dark grays.
            if (delta < 40 || delta / max < 0.25)
                continue;
            let hue;
            if (max === rgb[0])
                hue = (rgb[1] - rgb[2]) / delta;
            else if (max === rgb[1])
                hue = (rgb[2] - rgb[0]) / delta + 2;
            else
                hue = (rgb[0] - rgb[1]) / delta + 4;
            // Round into 30-degree groups, keeping reds across the hue wrap together.
            const group = palette[(Math.round(hue * 2) + 12) % 12];
            const relevance = alpha * delta / 255;
            for (let channel = 0; channel < 3; channel++)
                group.rgb[channel] += rgb[channel] * relevance;
            group.weight += relevance;
            group.coverage += alpha;
        }
    }
    if (!visible)
        return null;
    // A thin accent can qualify, but isolated tinted edge pixels should not.
    const group = palette.filter(candidate => candidate.coverage >= visible * 0.005)
        .reduce((best, candidate) => candidate.weight > best.weight ? candidate : best,
            {weight: 0});
    // Neutral icons use the native dot's theme-aware foreground color.
    if (!group.weight)
        return null;

    const rgb = group.rgb.map(value => value / group.weight);
    const max = Math.max(...rgb);
    const min = Math.min(...rgb);
    const delta = max - min;
    const saturation = 0.65;
    // Preserve hue while normalizing saturation and brightness.
    const result = rgb.map(value => Math.round(255 * 0.9 *
        (1 - saturation + saturation * (value - min) / delta)));
    return `rgb(${result.join(',')})`;
}
