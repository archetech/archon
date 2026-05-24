import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import CipherNode from '@didcid/cipher/node';
import { JsonPinStore } from './state.js';
import { processPinningQueue, type PinningGatekeeper } from './sync.js';
import type { Operation } from '@didcid/gatekeeper/types';
import type { PinningServiceProvider } from './provider.js';

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

test('pinned provider response clears queued operation', async () => {
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

        assert.equal(result.pinned, 1);
        assert.equal(result.failed, 0);
        assert.equal(gatekeeper.cleared.length, 1);
        assert.equal(provider.pins, 1);
    });
});

test('pinning provider response leaves operation queued for next cycle', async () => {
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

        assert.equal(result.pinned, 0);
        assert.equal(result.pending, 1);
        assert.equal(gatekeeper.cleared.length, 0);
    });
});

test('existing pending request is checked instead of submitted again', async () => {
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

        assert.equal(result.pinned, 1);
        assert.equal(provider.pins, 1);
        assert.equal(gatekeeper.cleared.length, 1);
    });
});

test('failed provider status leaves operation queued and retries as a new pin next cycle', async () => {
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

        assert.equal(first.failed, 1);
        assert.equal(gatekeeper.cleared.length, 0);

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

        assert.equal(second.pinned, 1);
        assert.equal(provider.pins, 2);
        assert.equal(gatekeeper.cleared.length, 1);
    });
});
