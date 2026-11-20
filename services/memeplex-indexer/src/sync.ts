import type { MemeplexIndex, ResolvedVersion } from '@didcid/memeplex';

// Keeping an index in step with a Gatekeeper: docs/plans/memeplex-1436.md, "A
// graph anyone can reconstruct".
//
// The Gatekeeper says which DIDs have changed, and what every version of each
// is. Those versions are handed to the index, which applies the Memeplex rules to
// them. Being told of a DID twice, or of one that turns out not to be a Memeplex
// object, changes nothing.

/** As much of a Gatekeeper as the indexer reads. */
export interface FeedGatekeeper {
    /** Every DID the node has. */
    getDIDs(): Promise<string[]>;
    /** Every version of each DID, as the Gatekeeper resolves it; none for a DID it does not have. */
    resolveVersions(dids: string[]): Promise<ResolvedVersion[][]>;
    /**
     * The DIDs whose histories changed after a sequence, oldest first, with the
     * epoch the sequences belong to. With no sequence, only where the node stands.
     */
    listChanges(options?: { since?: number; limit?: number }): Promise<{
        epoch: string;
        sequence: number;
        changes: { did: string; sequence: number }[];
    }>;
}

export interface SyncOptions {
    gatekeeper: FeedGatekeeper;
    index: MemeplexIndex;
    /** Changes read in one request. The Gatekeeper allows 1 to 1000. */
    pageSize?: number;
    /** DIDs whose versions are asked for in one request. */
    exportSize?: number;
}

export interface SyncResult {
    /** Whether every DID the node has was read, as at the start and after the Gatekeeper restarts. */
    rebuilt: boolean;
    /** DIDs whose versions were read and handed to the index. */
    histories: number;
}

export class Sync {
    private readonly pageSize: number;
    private readonly exportSize: number;
    /**
     * Where the index stands in the Gatekeeper's changes: the run of the
     * Gatekeeper the sequence belongs to, and the last change taken in.
     * Undefined until every DID has been read once.
     */
    private position: { epoch: string; sequence: number } | undefined;

    constructor(private readonly options: SyncOptions) {
        this.pageSize = options.pageSize ?? 1000;
        this.exportSize = options.exportSize ?? 100;
    }

    /** Whether the index has been filled from everything the node has. */
    get complete(): boolean {
        return this.position !== undefined;
    }

    /** Reads the versions of each DID and hands them to the index. */
    private async refresh(dids: string[]): Promise<number> {
        const { gatekeeper, index } = this.options;

        for (let start = 0; start < dids.length; start += this.exportSize) {
            const batch = dids.slice(start, start + this.exportSize);
            const histories = await gatekeeper.resolveVersions(batch);

            // A DID the Gatekeeper no longer has comes back empty, which removes
            // it. One that is neither an object nor a grant is not kept.
            batch.forEach((did, position) => index.put(did, histories[position] ?? []));
        }

        return dids.length;
    }

    /**
     * Reads every DID the node has, and every DID the index holds in case the
     * node no longer has it.
     *
     * Where the Gatekeeper's changes stand is noted first, so that whatever
     * changes while this runs is taken in by the polls that follow.
     */
    async rebuild(): Promise<SyncResult> {
        const { gatekeeper, index } = this.options;
        const { epoch, sequence } = await gatekeeper.listChanges();
        const dids = new Set([...await gatekeeper.getDIDs(), ...index.dids()]);
        const histories = await this.refresh([...dids]);

        this.position = { epoch, sequence };
        return { rebuilt: true, histories };
    }

    /**
     * Takes in what has changed since the last poll. The first poll, and one
     * that finds the Gatekeeper in a new run, whose sequences are not the ones
     * held, reads everything.
     */
    async poll(): Promise<SyncResult> {
        if (!this.position) {
            return this.rebuild();
        }

        const { gatekeeper } = this.options;
        let histories = 0;

        for (;;) {
            const page = await gatekeeper.listChanges({ since: this.position.sequence, limit: this.pageSize });

            if (page.epoch !== this.position.epoch) {
                return this.rebuild();
            }

            histories += await this.refresh(page.changes.map(change => change.did));

            // Only once its DIDs are in the index is a page behind us. Had the
            // read of them failed, the next poll asks for the same changes again.
            const last = page.changes.at(-1);

            if (last) {
                this.position = { epoch: page.epoch, sequence: last.sequence };
            }
            if (page.changes.length < this.pageSize) {
                return { rebuilt: false, histories };
            }
        }
    }
}
