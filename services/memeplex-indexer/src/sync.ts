import type { AcceptedEvent, MemeplexIndex } from '@didcid/memeplex';

// Keeping an index in step with a Gatekeeper: docs/plans/memeplex-1436.md, "A
// graph anyone can reconstruct".
//
// The Gatekeeper's feed says which DIDs have events; the history of each is then
// exported whole and handed to the index, which derives everything from it. The
// feed is never the evidence itself, so reading an event twice, or out of order,
// changes nothing.

/** As much of a Gatekeeper as the indexer reads. */
export interface FeedGatekeeper {
    listEvents(options: { after?: string; limit?: number; offset?: number }): Promise<{ total: number; events: AcceptedEvent[] }>;
    exportDIDs(dids: string[]): Promise<AcceptedEvent[][]>;
}

export interface SyncOptions {
    gatekeeper: FeedGatekeeper;
    index: MemeplexIndex;
    /** Events read from the feed in one request. The Gatekeeper allows 1 to 1000. */
    pageSize?: number;
    /** Histories exported in one request. */
    exportSize?: number;
    /**
     * How far back from the previous poll a poll reads, in milliseconds. The
     * feed is ordered by event time, not by arrival: an anchored event carries
     * its block's time, which is behind the clock when it arrives. What arrives
     * further behind than this is left to reconciliation.
     */
    overlap?: number;
    /** The clock, in milliseconds. */
    now?(): number;
}

export interface SyncResult {
    /** Events read from the feed that the previous pass had not read. */
    events: number;
    /** Histories exported and handed to the index. */
    histories: number;
}

// What makes an event the one already read: its DID and operation, and the
// receipt it currently has, which changes when the operation is anchored.
const keyOf = (event: AcceptedEvent) =>
    JSON.stringify([event.did, event.opid, event.registry, event.time, event.registration?.height]);

// Whether an event creates a Memeplex object or a grant. Later events of a DID
// say nothing of what it is; those are recognized by the index holding the DID.
function createsMemeplex(event: AcceptedEvent): boolean {
    const data = event.operation?.type === 'create' ? event.operation.data : undefined;

    return Boolean(data) && typeof data === 'object' && (data.memeplex !== undefined || data.memeplexGrant !== undefined);
}

export class Sync {
    private readonly pageSize: number;
    private readonly exportSize: number;
    private readonly overlap: number;
    private readonly now: () => number;
    /** When the previous pass began. Undefined until a pass has read the whole feed. */
    private polled: number | undefined;
    /**
     * The events read by the previous pass, so that the next poll, which reads
     * some of the same stretch of the feed again, exports only for what is new.
     */
    private read = new Set<string>();

    constructor(private readonly options: SyncOptions) {
        this.pageSize = options.pageSize ?? 1000;
        this.exportSize = options.exportSize ?? 100;
        this.overlap = options.overlap ?? 10 * 60 * 1000;
        this.now = options.now ?? Date.now;
    }

    /**
     * Reads the feed from a time on, newest first, and returns the DIDs that
     * matter: those an event shows to be an object or a grant, and those the
     * index already holds. A poll takes them only from events the previous pass
     * had not read; a reconciliation takes them from every event.
     */
    private async discover(after: string | undefined, everything: boolean): Promise<{ events: number; dids: Set<string>; read: Set<string> }> {
        const { gatekeeper, index } = this.options;
        const dids = new Set<string>();
        const read = new Set<string>();
        let events = 0;

        for (let offset = 0; ; offset += this.pageSize) {
            const page = (await gatekeeper.listEvents({ ...(after ? { after } : {}), limit: this.pageSize, offset })).events;

            for (const event of page) {
                const key = keyOf(event);
                const unread = !this.read.has(key);

                read.add(key);
                if (unread) {
                    events++;
                }
                if ((unread || everything) && event.did && (createsMemeplex(event) || index.holds(event.did))) {
                    dids.add(event.did);
                }
            }

            if (page.length < this.pageSize) {
                return { events, dids, read };
            }
        }
    }

    /** Whether a pass has read the whole feed and exported what it found. */
    get complete(): boolean {
        return this.polled !== undefined;
    }

    /** Exports the current history of each DID and hands it to the index. */
    private async refresh(dids: string[]): Promise<number> {
        const { gatekeeper, index } = this.options;

        for (let start = 0; start < dids.length; start += this.exportSize) {
            const batch = dids.slice(start, start + this.exportSize);
            const histories = await gatekeeper.exportDIDs(batch);

            // A DID the Gatekeeper no longer has comes back empty, which removes it.
            batch.forEach((did, position) => index.put(did, histories[position] ?? []));
        }

        return dids.length;
    }

    /**
     * Reads what the feed has gained since the previous poll: the events whose
     * times are after that poll began, less the overlap. The first poll reads
     * the whole feed.
     *
     * The window follows the clock and not the newest event read, because an
     * event's time is partly its signer's to choose, and one dated ahead would
     * otherwise hide everything after it.
     */
    async poll(): Promise<SyncResult> {
        const began = this.now();
        const after = this.polled === undefined ? undefined : new Date(this.polled - this.overlap).toISOString();
        const { events, dids, read } = await this.discover(after, false);
        const histories = await this.refresh([...dids]);

        // Only now is the pass over. Had an export failed, the next poll has to
        // read the same events as unread and try again.
        this.read = read;
        this.polled = began;
        return { events, histories };
    }

    /**
     * Reads the feed over its whole range and exports every history the index
     * holds, whether or not the feed mentions it. Polling alone misses evidence
     * that arrives late with an old time, and histories the Gatekeeper has
     * rewritten or removed.
     */
    async reconcile(): Promise<SyncResult> {
        const began = this.now();
        const { events, dids, read } = await this.discover(undefined, true);

        for (const did of this.options.index.dids()) {
            dids.add(did);
        }

        const histories = await this.refresh([...dids]);

        this.read = read;
        this.polled = began;
        return { events, histories };
    }
}
