// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {folderEntries, layoutIds, moveBefore, orderedItems} from '../shared/appLayout.js';
import {Connections} from './signals.js';

// GNOME's settings are the only persisted model. All projections are disposable.
export class AppLayout {
    constructor(settings, onChanged, translateName = name => name, withFolderRemoval = (_id, edit) => edit()) {
        this.settings = settings;
        this._onChanged = onChanged;
        this._translateName = translateName;
        this._withFolderRemoval = withFolderRemoval;
        this._signals = new Connections();
        this._folderSignals = new Connections();
        this.folders = new Map();
        this.revision = 0;
        this.root = new Gio.Settings({schema_id: 'org.gnome.desktop.app-folders'});
        this._signals.connect(settings, 'changed::app-picker-layout', () => this._changed());
        this._signals.connect(settings, 'writable-changed', () => this._changed());
        this._signals.connect(this.root, 'changed::folder-children', () => this._loadFolders());
        this._signals.connect(this.root, 'writable-changed', () => this._changed());
        this._loadFolders();
    }

    _changed() {
        this.revision++;
        this._onChanged();
    }

    _loadFolders() {
        this._folderSignals.clear();
        this.folders.clear();
        for (const id of this.root.get_strv('folder-children')) {
            // A corrupt path must not prevent the launcher from opening.
            if (!id || id.includes('/') || this.folders.has(id))
                continue;
            const settings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.app-folders.folder',
                path: `${this.root.path}folders/${id}/`,
            });
            this.folders.set(id, settings);
            this._folderSignals.connect(settings, 'changed', () => this._changed());
            this._folderSignals.connect(settings, 'writable-changed', () => this._changed());
        }
        this._changed();
    }

    folder(id) {
        const settings = this.folders.get(id);
        return settings ? {
            id, kind: 'folder', name: settings.get_string('name'),
            translate: settings.get_boolean('translate'),
            apps: settings.get_strv('apps'), categories: settings.get_strv('categories'),
            excluded: settings.get_strv('excluded-apps'),
        } : null;
    }

    contents(id, entries) {
        const folder = this.folder(id);
        return folder ? folderEntries(folder, entries) : [];
    }

    items(entries) {
        const inside = new Set();
        const folders = [];
        for (const id of this.folders.keys()) {
            const folder = this.folder(id);
            if (folder.translate)
                folder.name = this._translateName(folder.name) ?? folder.name;
            folder.entries = folderEntries(folder, entries);
            if (!folder.entries.length)
                continue;
            for (const entry of folder.entries)
                inside.add(entry.id);
            folders.push(folder);
        }
        return orderedItems([...folders, ...entries.filter(entry => !inside.has(entry.id))],
            this.settings.get_value('app-picker-layout').recursiveUnpack());
    }

    canEdit(folderId = null) {
        if (!this.settings.is_writable('app-picker-layout'))
            return false;
        if (!folderId)
            return true;
        const folder = this.folders.get(folderId);
        return !!folder && ['apps', 'excluded-apps'].every(key => folder.is_writable(key));
    }

    canManage(folderId = null) {
        const folder = this.folders.get(folderId);
        return this.canEdit(folderId) && this.root.is_writable('folder-children') &&
            (!folderId || folder.settings_schema.list_keys().every(key => folder.is_writable(key)));
    }

    // Check every key before applying a multi-key edit. Restore values if a
    // backend rejects a write. Settings notifications are coalesced by Launcher.
    _write(changes) {
        const saved = changes.map(([settings, key, value]) => {
            if (!settings.is_writable(key))
                throw new Error('These application settings are locked.');
            return [settings, key, settings.get_value(key), value];
        });
        const applied = [];
        try {
            const groups = new Map();
            for (const change of saved) {
                const [settings] = change;
                if (!groups.has(settings))
                    groups.set(settings, []);
                groups.get(settings).push(change);
            }
            for (const [settings, group] of groups) {
                // Never put global.settings (shared with Shell) in delay mode.
                const writer = settings instanceof Gio.Settings ? new Gio.Settings({
                    settings_schema: settings.settings_schema, path: settings.path,
                }) : settings;
                if (writer !== settings)
                    writer.delay();
                for (const [, key, old, value] of group) {
                    if (!writer.set_value(key, value)) {
                        writer.revert?.();
                        throw new Error('GNOME could not save the application layout.');
                    }
                    applied.push([settings, key, old]);
                }
                if (writer !== settings)
                    writer.apply();
            }
        } catch (error) {
            for (const [settings, key, old] of applied.reverse())
                settings.set_value(key, old);
            throw error;
        }
    }

    _value(settings, key, value) {
        return [settings, key, new GLib.Variant(settings.get_value(key).get_type_string(), value)];
    }

    _order(entries) {
        return [...new Set([...layoutIds(this.settings.get_value('app-picker-layout').recursiveUnpack()),
            ...this.items(entries).map(item => item.id)])];
    }

    _layoutChange(ids) {
        const old = this.settings.get_value('app-picker-layout');
        const pages = old.deepUnpack();
        const properties = new Map(pages.flatMap(page => Object.entries(page)));
        let index = 0;
        const packed = [];
        // Preserve native page capacities, not Panthea's smaller page size.
        for (let page = 0; page < Math.max(1, pages.length); page++) {
            const count = page === pages.length - 1 || !pages.length
                ? ids.length - index : Math.min(Object.keys(pages[page]).length, ids.length - index);
            const data = {};
            for (let position = 0; position < count; position++) {
                const id = ids[index++];
                data[id] = new GLib.Variant('a{sv}', {
                    ...(properties.get(id)?.deepUnpack() ?? {}),
                    position: new GLib.Variant('i', position),
                });
            }
            packed.push(data);
        }
        return [this.settings, 'app-picker-layout', new GLib.Variant('aa{sv}', packed)];
    }

    reorder(id, target, after, folderId, entries) {
        if (folderId) {
            const settings = this.folders.get(folderId);
            const ids = [...new Set([...this.contents(folderId, entries).map(entry => entry.id),
                ...settings.get_strv('apps')])];
            this._write([this._value(settings, 'apps', moveBefore(ids, id, target, after))]);
        } else {
            this._write([this._layoutChange(moveBefore(this._order(entries), id, target, after))]);
        }
    }

    rename(id, name) {
        name = name.trim();
        if (!name)
            throw new Error('Enter a folder name.');
        const settings = this.folders.get(id);
        this._write([this._value(settings, 'name', name), this._value(settings, 'translate', false)]);
    }

    create(first, second, entries) {
        const id = GLib.uuid_string_random();
        const settings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.app-folders.folder',
            path: `${this.root.path}folders/${id}/`,
        });
        const ids = moveBefore(this._order(entries), id, first).filter(value => value !== first && value !== second);
        this._write([
            this._value(settings, 'name', 'Unnamed Folder'),
            this._value(settings, 'apps', [first, second]),
            this._value(this.root, 'folder-children', [...this.root.get_strv('folder-children'), id]),
            this._layoutChange(ids),
        ]);
        return id;
    }

    add(id, appId, entries) {
        const settings = this.folders.get(id);
        this._write([
            this._value(settings, 'apps', [...new Set([...settings.get_strv('apps'), appId])]),
            this._value(settings, 'excluded-apps', settings.get_strv('excluded-apps').filter(value => value !== appId)),
            this._layoutChange(this._order(entries).filter(value => value !== appId)),
        ]);
    }

    _deleteChanges(id) {
        const settings = this.folders.get(id);
        return [...settings.settings_schema.list_keys().map(key => [settings, key, settings.get_default_value(key)]),
            this._value(this.root, 'folder-children', this.root.get_strv('folder-children').filter(value => value !== id))];
    }

    remove(id, appId, entries) {
        const folder = this.folder(id);
        const settings = this.folders.get(id);
        const apps = folder.apps.filter(value => value !== appId);
        const excluded = [...new Set([...folder.excluded, appId])];
        // Do not delete a category folder that still has effective members.
        const empty = !folderEntries({...folder, apps, excluded}, entries).length && !apps.length;
        const changes = empty ? this._deleteChanges(id) : [
            this._value(settings, 'apps', apps),
            this._value(settings, 'excluded-apps', excluded),
        ];
        let ids = moveBefore(this._order(entries), appId, id, true);
        if (empty)
            ids = ids.filter(value => value !== id);
        const edit = () => this._write([...changes, this._layoutChange(ids)]);
        if (empty)
            this._withFolderRemoval(id, edit);
        else
            edit();
    }

    dissolve(id, entries) {
        let ids = this._order(entries);
        for (const entry of this.contents(id, entries))
            ids = moveBefore(ids, entry.id, id);
        this._withFolderRemoval(id, () =>
            this._write([...this._deleteChanges(id), this._layoutChange(ids.filter(value => value !== id))]));
    }

    destroy() {
        this._signals.clear();
        this._folderSignals.clear();
        this.folders.clear();
    }
}
