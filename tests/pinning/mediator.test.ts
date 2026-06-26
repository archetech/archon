import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import nock from 'nock';
import CipherNode from '@didcid/cipher/node';
import type { Operation } from '@didcid/gatekeeper/types';
import { JsonPinStore } from '../../services/mediators/pinning/src/state.ts';
import { fingerprintOperation, processPinningQueue, type PinningGatekeeper } from '../../services/mediators/pinning/src/sync.ts';
import { normalizeStatus, pinPayload, providerError } from '../../services/mediators/pinning/src/provider.ts';
import type { PinningServiceProvider, ProviderPinRequest } from '../../services/mediators/pinning/src/provider.ts';
import { PinningServiceProvider as PinningServiceProviderClass } from '../../services/mediators/pinning/src/provider.ts';

function op(id: string, registry = 'BTC:mainnet'): Operation {
    return {
        type: 'create',
        publicJwk: { kid: id },
        registration: {
            version: 1,
            type: 'agent',
            registry,
        },
    } as unknown as Operation;
}

function updateOp(did: string): Operation {
    return {
        type: 'update',
        did,
        doc: {
            didDocumentData: { mock: true },
        },
    } as Operation;
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
    requests: ProviderPinRequest[] = [];
    statuses = new Map<string, any>();

    async pin(request: ProviderPinRequest): Promise<any> {
        this.pins += 1;
        this.requests.push(request);
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

    it('uses registry-free provider names and metadata', async () => {
        await withStore(async store => {
            const operation = updateOp('did:test:one');
            const gatekeeper = new FakeGatekeeper([operation]);
            const provider = new FakeProvider();
            const cipher = new CipherNode();
            const fingerprint = fingerprintOperation(cipher, operation);

            const result = await processPinningQueue(
                'pin',
                gatekeeper,
                store,
                cipher,
                provider as unknown as PinningServiceProvider,
                []
            );

            expect(result).toMatchObject({ pinned: 1, failed: 0 });
            expect(provider.requests).toHaveLength(1);
            expect(provider.requests[0].name).toBe(`archon-${fingerprint.slice(0, 16)}`);
            expect(provider.requests[0].name).not.toContain('unknown');
            expect(provider.requests[0].meta).toStrictEqual({
                archonFingerprint: fingerprint,
                archonCid: provider.requests[0].cid,
            });
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

    it('submits a new pin when stored request belongs to a different provider', async () => {
        await withStore(async store => {
            const gatekeeper = new FakeGatekeeper([op('one')]);
            const provider = new FakeProvider();
            provider.pin = async () => {
                provider.pins += 1;
                return { requestid: 'request-old', status: 'pinning', response: { status: 'pinning' } };
            };

            await processPinningQueue(
                'pin',
                gatekeeper,
                store,
                new CipherNode(),
                provider as unknown as PinningServiceProvider,
                []
            );

            provider.name = 'other-provider';
            provider.pin = async () => {
                provider.pins += 1;
                return { requestid: 'request-new', status: 'pinned', response: { status: 'pinned' } };
            };

            const result = await processPinningQueue(
                'pin',
                gatekeeper,
                store,
                new CipherNode(),
                provider as unknown as PinningServiceProvider,
                []
            );

            expect(result.pinned).toBe(1);
            expect(provider.pins).toBe(2);
            expect(gatekeeper.cleared).toHaveLength(1);
        });
    });

    it('counts pin records by status and provider', async () => {
        await withStore(async store => {
            await store.load();
            await store.recordSubmitted('one', 'cid-one', 'BTC:mainnet', 'pinata', 'request-one', 'pinned', {});
            await store.recordSubmitted('two', 'cid-two', 'BTC:mainnet', 'filebase', 'request-two', 'pinned', {});

            expect(store.count('pinned')).toBe(2);
            expect(store.count('pinned', 'pinata')).toBe(1);
            expect(store.count('pinned', 'filebase')).toBe(1);
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

describe('pinning service provider helpers', () => {
    it('requires an API token', () => {
        expect(() => new PinningServiceProviderClass('pinata', 'https://pinning.example', undefined))
            .toThrow('ARCHON_PIN_API_TOKEN is required');
    });

    it('submits pins and checks status through the Pinning Service API', async () => {
        nock('https://pinning.example')
            .post('/pins', {
                cid: 'bagaaieraexample',
                name: 'archon-test',
                meta: { archonFingerprint: 'fingerprint' },
                origins: ['https://gateway.example/ipfs/bagaaieraexample'],
            })
            .matchHeader('authorization', 'Bearer secret-token')
            .reply(202, { requestid: 'request-1', status: 'queued' })
            .get('/pins/request-1')
            .matchHeader('authorization', 'Bearer secret-token')
            .reply(200, { requestid: 'request-1', status: 'pinned' });

        const provider = new PinningServiceProviderClass('pinata', 'https://pinning.example/', 'secret-token');

        expect(provider.name).toBe('pinata');
        expect(await provider.pin({
            cid: 'bagaaieraexample',
            name: 'archon-test',
            meta: { archonFingerprint: 'fingerprint' },
            origins: ['https://gateway.example/ipfs/bagaaieraexample'],
        })).toStrictEqual({
            requestid: 'request-1',
            status: 'queued',
            response: { requestid: 'request-1', status: 'queued' },
        });
        expect(await provider.getStatus('request-1')).toStrictEqual({
            requestid: 'request-1',
            status: 'pinned',
            response: { requestid: 'request-1', status: 'pinned' },
        });
    });

    it('normalizes unknown or malformed provider status responses', () => {
        expect(normalizeStatus({ requestid: 123, status: 'surprising' })).toStrictEqual({
            requestid: undefined,
            status: 'pinning',
            response: { requestid: 123, status: 'surprising' },
        });
        expect(normalizeStatus(null)).toStrictEqual({
            requestid: undefined,
            status: 'pinning',
            response: null,
        });
    });

    it('extracts useful provider error messages', () => {
        expect(providerError({ response: { data: { error: { details: 'bad cid' } } } })).toBe('bad cid');
        expect(providerError({ response: { data: { error: { reason: 'quota exceeded' } } } })).toBe('quota exceeded');
        expect(providerError({ response: { data: { error: 'plain error' } } })).toBe('plain error');
        expect(providerError({ response: { data: { message: 'message error' } } })).toBe('message error');
        expect(providerError(new Error('network down'))).toBe('network down');
        expect(providerError('string failure')).toBe('string failure');
    });
});
