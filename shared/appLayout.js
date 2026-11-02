// SPDX-License-Identifier: GPL-3.0-or-later

// Keep display ordering separate from desktop-file category precedence.
export function categoryItems(categories) {
    return [['favorites', 'Favorites'], ['all', 'All Applications'],
        ...categories.toSorted((a, b) => a[1].localeCompare(b[1]))];
}

export function layoutIds(pages) {
    const seen = new Set();
    return pages.flatMap(page => Object.keys(page)
        .sort((a, b) => (page[a].position ?? 0) - (page[b].position ?? 0)))
        .filter(id => !seen.has(id) && seen.add(id));
}

export function orderedItems(items, pages) {
    const positions = new Map(layoutIds(pages).map((id, index) => [id, index]));
    return items.toSorted((a, b) => {
        const aPosition = positions.get(a.id);
        const bPosition = positions.get(b.id);
        if (aPosition === undefined && bPosition === undefined)
            return a.name.localeCompare(b.name);
        return (aPosition ?? Infinity) - (bPosition ?? Infinity);
    });
}

export function folderEntries(folder, entries) {
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const categories = new Set(folder.categories);
    const excluded = new Set(folder.excluded);
    // GNOME appends automatic members in AppSystem's installed-app order,
    // not the catalog's alphabetical category/search display order.
    const automatic = entries.toSorted((a, b) => (a.catalogOrder ?? 0) - (b.catalogOrder ?? 0));
    const ids = new Set([...folder.apps, ...automatic.filter(entry =>
        (entry.info.get_categories() ?? '').split(';').some(category => categories.has(category)))
        .map(entry => entry.id)]);
    return [...ids].filter(id => byId.has(id) && !excluded.has(id)).map(id => byId.get(id));
}

export function moveBefore(ids, id, target, after = false) {
    const result = ids.filter(value => value !== id);
    const index = result.indexOf(target);
    result.splice(index < 0 ? result.length : index + Number(after), 0, id);
    return result;
}
