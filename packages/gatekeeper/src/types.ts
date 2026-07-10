import type { IPFSClient } from '@didcid/ipfs/types';
import type {
    BlockId,
    BlockInfo,
    GatekeeperEvent,
    Operation,
} from '@didcid/clients/gatekeeper-types';

export type * from '@didcid/clients/gatekeeper-types';

export interface JsonDbFile {
    dids: Record<string, GatekeeperEvent[]>;
    queue?: Record<string, Operation[]>;
    blocks?: Record<string, any>;
    hashes?: Record<string, any>;
    ops?: Record<string, Operation>;
}

export interface GatekeeperDb {
    start(): Promise<void>;
    stop(): Promise<void>;
    resetDb(): Promise<void | number | JsonDbFile>;
    addEvent(did: string, event: GatekeeperEvent): Promise<void | number>;
    getEvents(did: string): Promise<GatekeeperEvent[]>;
    setEvents(did: string, events: GatekeeperEvent[]): Promise<number | void>;
    deleteEvents(did: string): Promise<void | number>;
    getAllKeys(): Promise<string[]>;
    queueOperation(registry: string, op: Operation): Promise<number>;
    getQueue(registry: string): Promise<Operation[]>;
    clearQueue(registry: string, batch: Operation[]): Promise<boolean>;
    addBlock(registry: string, blockInfo: BlockInfo): Promise<boolean>;
    getBlock(registry: string, blockId?: BlockId): Promise<BlockInfo | null>;
    addOperation(opid: string, op: Operation): Promise<void>;
    getOperation(opid: string): Promise<Operation | null>;
}

export interface GatekeeperOptions {
    db: GatekeeperDb;
    ipfs: IPFSClient;
    console?: typeof console;
    didPrefix?: string;
    maxOpBytes?: number;
    maxQueueSize?: number;
    registries?: string[];
    registriesPin?: string[];
}
