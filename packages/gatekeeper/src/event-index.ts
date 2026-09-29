import type { GatekeeperEvent } from './types.js';

export interface EventSummary {
    // The storage key: the DID without its prefix.
    key: string;
    // Index of the event in the DID's accepted history.
    position: number;
    time: number;
    registry: string;
}

export interface EventQuery {
    after?: number;
    before?: number;
    registry?: string;
    limit: number;
    offset: number;
}

// Newest first. Ties fall back to the storage key and then to the later
// position in a history, so every node orders the same events the same way.
function compareSummaries(a: EventSummary, b: EventSummary): number {
    if (a.time !== b.time) return b.time - a.time;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return b.position - a.position;
}

// Accepted events across all DIDs, kept in step with the histories written to
// the database so a page of recent events costs no scan of the whole store.
// Only summaries are held; callers read the listed events from the database.
// Histories are keyed like the database keys them, by DID suffix.
export default class EventIndex {
    // Event times are compared as the millisecond instants the resolver uses.
    constructor(private readonly timestamp: (time: string) => number) {}

    private histories = new Map<string, EventSummary[]>();
    private sorted?: EventSummary[];
    private built = false;

    // Writes before the first build are ignored: the build reads everything.
    get isBuilt(): boolean {
        return this.built;
    }

    build(histories: Iterable<[string, GatekeeperEvent[]]>): void {
        this.histories.clear();
        for (const [did, events] of histories) this.set(did, events, true);
        this.built = true;
        this.sorted = undefined;
    }

    clear(): void {
        this.histories.clear();
        this.built = false;
        this.sorted = undefined;
    }

    set(did: string, events: GatekeeperEvent[], building = false): void {
        if (!this.built && !building) return;
        const key = storageKey(did);
        if (events.length) this.histories.set(key, events.map((event, position) => this.summarize(key, position, event)));
        else this.histories.delete(key);
        this.sorted = undefined;
    }

    add(did: string, event: GatekeeperEvent): void {
        if (!this.built) return;
        const key = storageKey(did);
        const history = this.histories.get(key) ?? [];
        history.push(this.summarize(key, history.length, event));
        this.histories.set(key, history);
        this.sorted = undefined;
    }

    delete(did: string): void {
        if (!this.built) return;
        this.histories.delete(storageKey(did));
        this.sorted = undefined;
    }

    query({ after, before, registry, limit, offset }: EventQuery): { total: number; page: EventSummary[] } {
        if (!this.sorted) {
            this.sorted = [...this.histories.values()].flat().filter(entry => !Number.isNaN(entry.time));
            this.sorted.sort(compareSummaries);
        }
        const matching = this.sorted.filter(entry =>
            (after === undefined || entry.time > after)
            && (before === undefined || entry.time < before)
            && (registry === undefined || entry.registry === registry));
        return { total: matching.length, page: matching.slice(offset, offset + limit) };
    }

    private summarize(key: string, position: number, event: GatekeeperEvent): EventSummary {
        return { key, position, time: this.timestamp(event.time), registry: event.registry };
    }
}

function storageKey(did: string): string {
    return did.split(':').pop()!;
}
