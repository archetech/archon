import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import CipherNode from '@didcid/cipher/node';
import type { Operation } from '@didcid/gatekeeper/types';
import { JsonPinStore } from '../../services/mediators/pinning/src/state.ts';
import { processPinningQueue, type PinningGatekeeper } from '../../services/mediators/pinning/src/sync.ts';
import { pinPayload } from '../../services/mediators/pinning/src/provider.ts';
import type { PinningServiceProvider } from '../../services/mediators/pinning/src/provider.ts';

function op(id: string, registry = 'BTC:mainnet'): Operation {
    return {
        type: 'create',
        mdip: {
            version: 1,
            type: 'agent',
            registry,
        },
        publicJwk: { kid: id },
        registration: {
            version: 1,
            type: 'agent',
            registry,
        },
    } as unknown as Operation;
}

class FakeGatekeeper implements PinningGatekeeper {
    cleared: Operation[] = [];

    constructor(public queue: Operation[]) {}

    async getQueue(_registry: string): Promise<Operation[]> {
        return this.queue;
    }

    async clearQueue(_registry: string, operations: Operation[]): Promise<boolean> {
        this.cleared.push(...operations);
        return true;
    }

    async addJSON(data: object): Promise<string> {
        return `cid-${JSON.stringify(data).length}`;
    }
}

class FakeProvider {
    name = 'test';
    pins = 0;
    statuses = new Map<string, any>();

    async pin(): Promise<any> {
        this.pins += 1;
        return { requestid: `request-${this.pins}`, status: 'pinned', response: { status: 'pinned' } };
    }

    async getStatus(requestid: string): Promise<any> {
        return this.statuses.get(requestid) || { requestid, status: 'pinning', response: { status: 'pinning' } };
    }
}

async function withStore(fn: (store: JsonPinStore) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'archon-pinning-test-'));
    try {
        await fn(new JsonPinStore(join(dir, 'state.json')));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe('pinning mediator queue processing', () => {

    it('clears queued operation after pinned provider response', async () => {
        await withStore(async store => {
            const gatekeeper = new FakeGatekeeper([op('one')]);
            const provider = new FakeProvider();

            const result = await processPinningQueue(
                'pin',
                gatekeeper,
                store,
                new CipherNode(),
                provider as unknown as PinningServiceProvider,
                []
            );

            expect(result).toMatchObject({ pinned: 1, failed: 0 });
            expect(gatekeeper.cleared).toHaveLength(1);
            expect(provider.pins).toBe(1);
        });
    });

    it('leaves operation queued while provider reports pinning', async () => {
        await withStore(async store => {
            const gatekeeper = new FakeGatekeeper([op('one')]);
            const provider = new FakeProvider();
            provider.pin = async () => {
                provider.pins += 1;
                return { requestid: 'request-1', status: 'pinning', response: { status: 'pinning' } };
            };

            const result = await processPinningQueue(
                'pin',
                gatekeeper,
                store,
                new CipherNode(),
                provider as unknown as PinningServiceProvider,
                []
            );

            expect(result).toMatchObject({ pinned: 0, pending: 1 });
            expect(gatekeeper.cleared).toHaveLength(0);
        });
    });

    it('checks an existing pending request instead of submitting again', async () => {
        await withStore(async store => {
            const gatekeeper = new FakeGatekeeper([op('one')]);
            const provider = new FakeProvider();
            provider.pin = async () => {
                provider.pins += 1;
                return { requestid: 'request-1', status: 'pinning', response: { status: 'pinning' } };
            };

            await processPinningQueue(
                'pin',
                gatekeeper,
                store,
                new CipherNode(),
                provider as unknown as PinningServiceProvider,
                []
            );

            provider.statuses.set('request-1', { requestid: 'request-1', status: 'pinned', response: { status: 'pinned' } });

            const result = await processPinningQueue(
                'pin',
                gatekeeper,
                store,
                new CipherNode(),
                provider as unknown as PinningServiceProvider,
                []
            );

            expect(result.pinned).toBe(1);
            expect(provider.pins).toBe(1);
            expect(gatekeeper.cleared).toHaveLength(1);
        });
    });

    it('leaves failed provider status queued and retries as a new pin next cycle', async () => {
        await withStore(async store => {
            const gatekeeper = new FakeGatekeeper([op('one')]);
            const provider = new FakeProvider();
            provider.pin = async () => {
                provider.pins += 1;
                return { requestid: 'request-1', status: 'failed', response: { status: 'failed' } };
            };

            const first = await processPinningQueue(
                'pin',
                gatekeeper,
                store,
                new CipherNode(),
                provider as unknown as PinningServiceProvider,
                []
            );

            expect(first.failed).toBe(1);
            expect(gatekeeper.cleared).toHaveLength(0);

            provider.pin = async () => {
                provider.pins += 1;
                return { requestid: 'request-2', status: 'pinned', response: { status: 'pinned' } };
            };

            const second = await processPinningQueue(
                'pin',
                gatekeeper,
                store,
                new CipherNode(),
                provider as unknown as PinningServiceProvider,
                []
            );

            expect(second.pinned).toBe(1);
            expect(provider.pins).toBe(2);
            expect(gatekeeper.cleared).toHaveLength(1);
        });
    });

    it('omits empty origins from provider pin requests', () => {
        expect(pinPayload({
            cid: 'bagaaieraexample',
            name: 'archon-test',
            meta: {},
            origins: [''],
        })).toStrictEqual({
            cid: 'bagaaieraexample',
            name: 'archon-test',
            meta: {},
        });
    });
});
