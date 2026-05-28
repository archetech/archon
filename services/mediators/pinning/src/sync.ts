import { Operation } from '@didcid/gatekeeper/types';
import CipherNode from '@didcid/cipher/node';
import { JsonPinStore } from './state.js';
import type { PinningServiceProvider } from './provider.js';
import { providerError } from './provider.js';

export interface PinningGatekeeper {
    getQueue(registry: string): Promise<Operation[]>;
    clearQueue(registry: string, operations: Operation[]): Promise<boolean>;
    addJSON(data: object): Promise<string>;
}

export interface ProcessQueueResult {
    queued: number;
    pinned: number;
    pending: number;
    failed: number;
    lastError?: string;
    lastFailedFingerprint?: string;
}

function registryOf(operation: Operation): string | undefined {
    return operation.registration?.registry;
}

export function fingerprintOperation(cipher: CipherNode, operation: Operation): string {
    return cipher.hashJSON(JSON.parse(cipher.canonicalizeJSON(operation)));
}

export async function operationCid(gatekeeper: PinningGatekeeper, cipher: CipherNode, operation: Operation): Promise<string> {
    const canonical = JSON.parse(cipher.canonicalizeJSON(operation));
    return gatekeeper.addJSON(canonical);
}

function pinName(fingerprint: string): string {
    return `archon-${fingerprint.slice(0, 16)}`;
}

export async function processPinningQueue(
    registry: string,
    gatekeeper: PinningGatekeeper,
    store: JsonPinStore,
    cipher: CipherNode,
    provider: PinningServiceProvider,
    origins: string[]
): Promise<ProcessQueueResult> {
    await store.load();
    const operations = await gatekeeper.getQueue(registry);
    const pinned: Operation[] = [];
    let pending = 0;
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

            const requestid = existing?.provider === provider.name ? existing.requestid : undefined;
            const status = requestid
                ? await provider.getStatus(requestid)
                : await provider.pin({
                    cid,
                    name: pinName(fingerprint),
                    origins,
                    meta: {
                        archonFingerprint: fingerprint,
                        archonCid: cid,
                    },
                });

            if (requestid) {
                await store.recordStatus(fingerprint, status.status, status.response);
            } else {
                await store.recordSubmitted(
                    fingerprint,
                    cid,
                    opRegistry,
                    provider.name,
                    status.requestid,
                    status.status,
                    status.response
                );
            }

            if (status.status === 'pinned') {
                pinned.push(operation);
                continue;
            }

            if (status.status === 'failed') {
                failed += 1;
                lastError = 'Pinning provider reported failed status';
                lastFailedFingerprint = fingerprint;
                await store.recordFailure(fingerprint, cid, opRegistry, provider.name, lastError, true);
                break;
            }

            pending += 1;
        } catch (error: any) {
            const message = providerError(error);
            if (cid) {
                await store.recordFailure(fingerprint, cid, opRegistry, provider.name, message);
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
        pending,
        failed,
        lastError,
        lastFailedFingerprint,
    };
}
