// SPDX-License-Identifier: GPL-3.0-or-later

import {CATEGORIES} from './options.js';

export function categoryFor(value) {
    const categories = new Set((value ?? '').split(';'));
    if (categories.has('Audio') || categories.has('Video'))
        categories.add('AudioVideo');
    return CATEGORIES.find(([id]) => categories.has(id))?.[0] ?? 'Other';
}

export function pageSlice(entries, page, size) {
    const pages = Math.max(1, Math.ceil(entries.length / size));
    page = Math.max(0, Math.min(page, pages - 1));
    return {page, pages, entries: entries.slice(page * size, (page + 1) * size)};
}
