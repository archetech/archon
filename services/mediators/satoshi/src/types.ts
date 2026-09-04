import { ImportBatchResult, ProcessEventsResult } from '@didcid/gatekeeper/types';

export interface DiscoveredItem {
    height: number;
    index: number;
    time: string;
    txid: string;
    did: string;
    imported?: ImportBatchResult;
    processed?: ProcessEventsResult;
    error?: string;
}

export interface RegisteredItem {
    did: string;
    txid: string;
}

export interface MediatorDb {
    height: number;
    hash?: string;
    time: string;
    blockCount: number;
    blocksScanned: number;
    blocksPending: number;
    txnsScanned: number;
    registered: RegisteredItem[];
    discovered: DiscoveredItem[];
    lastExport?: string;
    // The batch asset created for the current export attempt. The OP_RETURN
    // carries the DID, so it must exist before the transaction that anchors it;
    // keeping it here lets a failed attempt reuse the same asset instead of
    // minting another one for the same operations.
    pendingBatch?: {
        did: string;
        opids: string[];
        // Set once the batch is anchored. Its operations are still queued, so
        // the clear is outstanding; the transaction must not be sent again.
        txid?: string;
    };
    pending?: {
        txids?: string[];
        blockCount: number;
    }
}

export interface MediatorDbInterface {
    loadDb(): Promise<MediatorDb | null>;
    saveDb(data: MediatorDb): Promise<boolean>;
    updateDb(mutator: (db: MediatorDb) => void | Promise<void>): Promise<void>;
}

export const BlockVerbosity = {
    HEX: 0,
    JSON: 1,
    JSON_TX_DATA: 2,
};

// eslint-disable-next-line @typescript-eslint/no-redeclare
export type BlockVerbosity = typeof BlockVerbosity[keyof typeof BlockVerbosity];
