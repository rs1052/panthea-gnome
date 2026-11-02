// SPDX-License-Identifier: GPL-3.0-or-later

export class Connections {
    constructor() {
        this._connections = [];
    }

    connect(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._connections.push([object, id]);
        return id;
    }

    clear() {
        for (const [object, id] of this._connections)
            object.disconnect(id);
        this._connections = [];
    }
}
