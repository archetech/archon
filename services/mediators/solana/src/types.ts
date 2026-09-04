import { ImportBatchResult, ProcessEventsResult } from '@didcid/gatekeeper/types';

export interface DiscoveredItem {
    height: number;
    slot?: number;
    index: number;
    time: string;
    txid: string;
    blockHash: string;
    batchHash: string;
    did: string;
    sender?: string;
    opCount?: number;
    imported?: ImportBatchResult;
    processed?: ProcessEventsResult;
    error?: string;
}

export interface RegisteredItem {
    did: string;
    txid: string;
    batchHash: string;
}

export interface MediatorDb {
    height: number;
    hash?: string;
    time: string;
    blockCount: number;
    blocksScanned: number;
    blocksPending: number;
    txnsScanned: number;
    currentBlockHeight?: number;
    checkpointSlot?: number;
    checkpointHeight?: number;
    registered: RegisteredItem[];
    discovered: DiscoveredItem[];
    lastExport?: string;
    // The batch asset created for the current export attempt. The anchor
    // carries the DID, so it must exist before the transaction; keeping it
    // here lets a failed attempt reuse the same asset instead of minting
    // another one for the same operations.
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
        batchDid?: string;
        batchHash?: string;
        opCount?: number;
    }
}

export interface MediatorDbInterface {
    loadDb(): Promise<MediatorDb | null>;
    saveDb(data: MediatorDb): Promise<boolean>;
    updateDb(mutator: (db: MediatorDb) => void | Promise<void>): Promise<void>;
}
