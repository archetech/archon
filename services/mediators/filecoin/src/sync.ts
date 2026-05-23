import { Operation } from '@didcid/gatekeeper/types';
import CipherNode from '@didcid/cipher/node';
import { JsonPinStore } from './state.js';

export interface FilecoinGatekeeper {
    getQueue(registry: string): Promise<Operation[]>;
    clearQueue(registry: string, operations: Operation[]): Promise<boolean>;
    addJSON(data: object): Promise<string>;
}

export interface ProcessQueueResult {
    queued: number;
    pinned: number;
    failed: number;
    lastError?: string;
    lastFailedFingerprint?: string;
}

export type WalletPin = (cid: string, fingerprint: string, registry?: string) => Promise<unknown>;

function registryOf(operation: Operation): string | undefined {
    return operation.registration?.registry;
}

export function fingerprintOperation(cipher: CipherNode, operation: Operation): string {
    return cipher.hashJSON(JSON.parse(cipher.canonicalizeJSON(operation)));
}

export async function operationCid(gatekeeper: FilecoinGatekeeper, cipher: CipherNode, operation: Operation): Promise<string> {
    const canonical = JSON.parse(cipher.canonicalizeJSON(operation));
    return gatekeeper.addJSON(canonical);
}

export async function processFilecoinQueue(
    registry: string,
    gatekeeper: FilecoinGatekeeper,
    store: JsonPinStore,
    cipher: CipherNode,
    walletPin: WalletPin
): Promise<ProcessQueueResult> {
    await store.load();
    const operations = await gatekeeper.getQueue(registry);
    const pinned: Operation[] = [];
    let failed = 0;
    let lastError: string | undefined;
    let lastFailedFingerprint: string | undefined;

    for (const operation of operations) {
        const fingerprint = fingerprintOperation(cipher, operation);
        const existing = store.get(fingerprint);

        if (existing?.status === 'pinned') {
            pinned.push(operation);
            continue;
        }

        let cid = existing?.cid;
        const opRegistry = registryOf(operation);

        try {
            cid ||= await operationCid(gatekeeper, cipher, operation);
            const wallet = await walletPin(cid, fingerprint, opRegistry);
            await store.recordSuccess(fingerprint, cid, opRegistry, wallet);
            pinned.push(operation);
        } catch (error: any) {
            const message = error?.response?.data?.error || error?.message || String(error);
            if (cid) {
                await store.recordFailure(fingerprint, cid, opRegistry, message);
            }
            failed += 1;
            lastError = message;
            lastFailedFingerprint = fingerprint;
            break;
        }
    }

    if (pinned.length > 0) {
        await gatekeeper.clearQueue(registry, pinned);
    }

    return {
        queued: operations.length,
        pinned: pinned.length,
        failed,
        lastError,
        lastFailedFingerprint,
    };
}
