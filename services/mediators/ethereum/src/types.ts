import { ImportBatchResult, ProcessEventsResult } from '@didcid/gatekeeper/types';

export interface DiscoveredItem {
    height: number;
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
    registered: RegisteredItem[];
    discovered: DiscoveredItem[];
    lastExport?: string;
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
