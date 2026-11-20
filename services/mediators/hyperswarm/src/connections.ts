/** As much of a Hyperswarm connection as keeping track of one needs. */
export interface PeerConnection {
    on(event: string, callback: (...args: any[]) => void): void;
    once(event: string, callback: (...args: any[]) => void): void;
    destroy?(): void;
}

export interface PeerEntry<Connection extends PeerConnection> {
    connection: Connection;
    lastSeen: number;
}

export interface ConnectionHandlers<Entry> {
    onData(data: any): void;
    /** The connection failed. Its close follows. */
    onError(error: unknown, entry: Entry): void;
    /** The connection closed and its entry has been removed. */
    onClose(entry: Entry): void;
}

/**
 * Records a connection under its peer's key and listens to it.
 *
 * The error listener is not optional. A stream with none throws when it fails,
 * from inside its own teardown, and never emits `close`. Hyperswarm then keeps
 * the dead connection as its connection to that peer, and when the peer connects
 * again under the same key it waits for the dead one to close before announcing
 * the new one, which is never. The peer is connected and unheard.
 *
 * A peer can be connected twice for a moment, the second replacing the first in
 * the table. The first one's close must not remove the second's entry.
 */
export function trackConnection<Connection extends PeerConnection, Entry extends PeerEntry<Connection>>(
    table: Record<string, Entry>,
    peerKey: string,
    entry: Entry,
    handlers: ConnectionHandlers<Entry>,
): void {
    const { connection } = entry;

    connection.on('error', error => handlers.onError(error, entry));
    connection.once('close', () => {
        if (table[peerKey]?.connection === connection) {
            delete table[peerKey];
        }
        handlers.onClose(entry);
    });
    connection.on('data', data => handlers.onData(data));

    table[peerKey] = entry;
}

/**
 * Removes the peers not heard from within the limit, and closes their
 * connections so that the swarm's own record of them goes too and it can connect
 * to them again. Returns the entries removed.
 */
export function dropStale<Connection extends PeerConnection, Entry extends PeerEntry<Connection>>(
    table: Record<string, Entry>,
    now: number,
    limit: number,
): Entry[] {
    const stale: Entry[] = [];

    for (const peerKey of Object.keys(table)) {
        const entry = table[peerKey];

        if (now - entry.lastSeen > limit) {
            delete table[peerKey];
            stale.push(entry);
            entry.connection.destroy?.();
        }
    }

    return stale;
}
