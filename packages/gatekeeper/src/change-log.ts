// Which DIDs' accepted histories have changed, in the order this node changed
// them. A reader that asks "what has changed since I last looked" can follow a
// node at the cost of what changed, without reading every event again.
//
// The numbers are this node's own, counted from one build of its histories.
// They are not event times, which follow a block or a signer and not arrival,
// and they mean nothing on another node or after a restart: the epoch names
// the run they belong to, and a reader that meets a new epoch reads everything
// again.

export interface Change {
    // The storage key: the DID without its prefix.
    key: string;
    sequence: number;
}

export interface ChangePage {
    epoch: string;
    // The sequence of the latest change.
    sequence: number;
    // In ascending sequence, each DID once, at its latest change.
    changes: Change[];
}

export default class ChangeLog {
    private epoch = newEpoch();
    private sequence = 0;
    // The latest change to each DID, and every change in order. An entry in the
    // log that is not its DID's latest is passed over, and removed when the log
    // is next compacted.
    private latest = new Map<string, number>();
    private log: Change[] = [];

    // Everything may have changed: the histories were built or cleared.
    reset(): void {
        this.epoch = newEpoch();
        this.sequence = 0;
        this.latest.clear();
        this.log = [];
    }

    record(key: string): void {
        this.sequence += 1;
        this.latest.set(key, this.sequence);
        this.log.push({ key, sequence: this.sequence });

        if (this.log.length > 2 * this.latest.size + 1024) {
            this.log = this.log.filter(entry => this.latest.get(entry.key) === entry.sequence);
        }
    }

    // The changes after a sequence, oldest first, up to a limit. With no
    // sequence, none: only where the log now stands.
    since(sequence: number | undefined, limit: number): ChangePage {
        const changes: Change[] = [];

        if (sequence !== undefined) {
            // The log is in ascending sequence: find the first entry after it.
            let low = 0;
            let high = this.log.length;

            while (low < high) {
                const middle = (low + high) >>> 1;

                if (this.log[middle].sequence > sequence) high = middle;
                else low = middle + 1;
            }

            for (let index = low; index < this.log.length && changes.length < limit; index++) {
                const entry = this.log[index];

                if (this.latest.get(entry.key) === entry.sequence) {
                    changes.push({ ...entry });
                }
            }
        }

        return { epoch: this.epoch, sequence: this.sequence, changes };
    }
}

function newEpoch(): string {
    return globalThis.crypto.randomUUID();
}
