import { EventEmitter } from 'node:events';
import { dropStale, trackConnection } from '../../services/mediators/hyperswarm/src/connections.ts';
import type { PeerEntry } from '../../services/mediators/hyperswarm/src/connections.ts';

// A mainnet node stopped hearing its peers after its connections timed out
// together. The mediator had no error listener on a connection, so each failed
// stream threw from inside its teardown and never closed; the peers, running the
// same code, kept their dead connections to the node and never announced the
// ones it made afterwards under the same key.

class Connection extends EventEmitter {
    destroyed = false;

    // As a stream does: a failure is an error, then a close.
    fail(error: Error) {
        this.emit('error', error);
        this.emit('close');
    }

    destroy() {
        if (!this.destroyed) {
            this.destroyed = true;
            this.emit('close');
        }
    }
}

interface Entry extends PeerEntry<Connection> {
    name: string;
}

function setup() {
    const table: Record<string, Entry> = {};
    const log: string[] = [];
    const track = (peerKey: string, name: string, lastSeen = 0) => {
        const connection = new Connection();

        trackConnection(table, peerKey, { connection, lastSeen, name }, {
            onData: data => log.push(`data ${name} ${data}`),
            onError: (error, entry) => log.push(`error ${entry.name} ${(error as Error).message}`),
            onClose: entry => log.push(`close ${entry.name}`),
        });
        return connection;
    };

    return { table, log, track };
}

describe('trackConnection', () => {
    it('records the connection and passes on what it receives', () => {
        const { table, log, track } = setup();
        const connection = track('peer', 'first');

        connection.emit('data', 'hello');

        expect(table.peer.connection).toBe(connection);
        expect(log).toEqual(['data first hello']);
    });

    it('listens for an error, so that a failed connection closes and is removed', () => {
        const { table, log, track } = setup();
        const connection = track('peer', 'first');

        // An emitter with no error listener throws here, and close never follows.
        expect(() => connection.fail(new Error('connection timed out'))).not.toThrow();

        expect(log).toEqual(['error first connection timed out', 'close first']);
        expect(table).toEqual({});
    });

    it('leaves a newer connection from the same peer when the older one closes', () => {
        const { table, log, track } = setup();
        const older = track('peer', 'older');
        const newer = track('peer', 'newer');

        older.destroy();

        expect(table.peer.connection).toBe(newer);
        expect(log).toEqual(['close older']);

        newer.destroy();
        expect(table).toEqual({});
    });

    it('closes without an entry to remove', () => {
        const { table, log, track } = setup();
        const connection = track('peer', 'first');

        delete table.peer;

        expect(() => connection.destroy()).not.toThrow();
        expect(log).toEqual(['close first']);
    });
});

describe('dropStale', () => {
    it('removes the peers not heard from within the limit and closes their connections', () => {
        const { table, log, track } = setup();
        const quiet = track('quiet', 'quiet', 1_000);
        const heard = track('heard', 'heard', 9_000);

        const dropped = dropStale(table, 10_000, 5_000);

        expect(dropped.map(entry => entry.name)).toEqual(['quiet']);
        expect(Object.keys(table)).toEqual(['heard']);
        expect(quiet.destroyed).toBe(true);
        expect(heard.destroyed).toBe(false);
        expect(log).toEqual(['close quiet']);
    });

    it('keeps a peer heard from exactly at the limit, and does nothing to an empty table', () => {
        const { table, track } = setup();

        track('edge', 'edge', 5_000);

        expect(dropStale(table, 10_000, 5_000)).toEqual([]);
        expect(dropStale({}, 10_000, 5_000)).toEqual([]);
        expect(Object.keys(table)).toEqual(['edge']);
    });
});
