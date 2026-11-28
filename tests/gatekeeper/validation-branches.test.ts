import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import { ExpectedExceptionError } from '@didcid/common/errors';
import type { EcdsaJwkPair, EcdsaJwkPublic } from '@didcid/cipher/types';
import type { GatekeeperEvent, Operation } from '@didcid/gatekeeper/types';
import { base64url } from 'multiformats/bases/base64';
import TestHelper from './helper.ts';

const mockConsole = {
    log: (): void => { },
    error: (): void => { },
    time: (): void => { },
    timeEnd: (): void => { },
} as unknown as typeof console;

const cipher = new CipherNode();
const db = new DbJsonMemory('test');
const ipfs = new MemoryClient();
const gatekeeper = new Gatekeeper({ db, ipfs, console: mockConsole, registries: ['local', 'hyperswarm', 'BTC:signet'] });
const helper = new TestHelper(gatekeeper, cipher);

const CREATED = '2026-11-01T00:00:00.000Z';

beforeAll(async () => {
    await ipfs.start();
});

afterAll(async () => {
    await ipfs.stop();
});

beforeEach(async () => {
    await gatekeeper.resetDb();
});

async function refusal(action: Promise<unknown>): Promise<Error> {
    try {
        await action;
    } catch (error: any) {
        return error;
    }
    throw new ExpectedExceptionError();
}

// Signs with the legacy proof type, whose signature covers the operation but
// not the proof, so a test can change one proof member without invalidating it.
function sign(operation: Operation, keypair: EcdsaJwkPair, verificationMethod: string): Operation {
    const signatureHex = cipher.signHash(cipher.hashJSON(operation), keypair.privateJwk);
    return {
        ...operation,
        proof: {
            type: 'EcdsaSecp256k1Signature2019',
            created: CREATED,
            verificationMethod,
            proofPurpose: 'authentication',
            proofValue: base64url.baseEncode(Buffer.from(signatureHex, 'hex')),
        },
    };
}

function agentOp(keypair: EcdsaJwkPair, publicJwk: unknown, registry = 'BTC:signet'): Operation {
    return sign({
        type: 'create',
        created: CREATED,
        registration: { version: 1, type: 'agent', registry },
        publicJwk: publicJwk as EcdsaJwkPublic,
    }, keypair, '#key-1');
}

function coordinate(length: number): string {
    return base64url.baseEncode(new Uint8Array(length).fill(7));
}

async function createAgent(): Promise<{ did: string, keypair: EcdsaJwkPair }> {
    const keypair = cipher.generateRandomJwk();
    const did = await gatekeeper.createDID(await helper.createAgentOp(keypair));
    return { did, keypair };
}

describe('agent public keys', () => {
    it.each([
        ['x is a number', { x: 12345 }],
        ['y is missing', { y: undefined }],
        ['x decodes to 31 bytes', { x: coordinate(31) }],
        ['y decodes to 33 bytes', { y: coordinate(33) }],
        ['x is 32 bytes but no point on the curve', { x: base64url.baseEncode(new Uint8Array(32)) }],
    ])('refuses an agent whose key is malformed (%s)', async (_, change) => {
        const keypair = cipher.generateRandomJwk();
        const operation = agentOp(keypair, { ...keypair.publicJwk, ...change });

        const error = await refusal(gatekeeper.createDID(operation));

        expect(error.message).toBe('Invalid operation: publicJwk');
        expect(await gatekeeper.getDIDs()).toStrictEqual([]);
        expect(await gatekeeper.getQueue('BTC:signet')).toStrictEqual([]);
    });

    it('accepts the same agent operation with a well-formed key', async () => {
        const keypair = cipher.generateRandomJwk();

        const did = await gatekeeper.createDID(agentOp(keypair, keypair.publicJwk));

        expect(await gatekeeper.getDIDs()).toStrictEqual([did]);
    });
});

describe('agent signatures', () => {
    function withProofValue(operation: Operation, bytes: Uint8Array): Operation {
        return { ...operation, proof: { ...operation.proof!, proofValue: base64url.baseEncode(bytes) } };
    }

    const event = (operation: Operation): GatekeeperEvent => ({ registry: 'hyperswarm', time: CREATED, operation });

    it('refuses as an invalid proof a 64-byte proofValue whose scalars are zero', async () => {
        const keypair = cipher.generateRandomJwk();
        const operation = withProofValue(agentOp(keypair, keypair.publicJwk, 'hyperswarm'), new Uint8Array(64));

        const error = await refusal(gatekeeper.createDID(operation));

        expect(error.message).toBe('Invalid operation: proof');
        expect(await gatekeeper.importEvent(event(operation))).toBe('deferred');
        expect(await gatekeeper.getDIDs()).toStrictEqual([]);
    });

    it('defers an imported agent whose key is no point on the curve', async () => {
        const keypair = cipher.generateRandomJwk();
        const operation = agentOp(keypair, { ...keypair.publicJwk, x: base64url.baseEncode(new Uint8Array(32)) }, 'hyperswarm');

        expect(await gatekeeper.importEvent(event(operation))).toBe('deferred');
        expect(await gatekeeper.getDIDs()).toStrictEqual([]);
    });

    it('rejects an imported agent signed by another well-formed key', async () => {
        const keypair = cipher.generateRandomJwk();
        const other = cipher.generateRandomJwk();
        const operation = agentOp(other, keypair.publicJwk, 'hyperswarm');

        const error = await refusal(gatekeeper.createDID(operation));

        expect(error.message).toBe('Invalid operation: proof');
        expect(await gatekeeper.importEvent(event(operation))).toBe('rejected');
        expect(await gatekeeper.getDIDs()).toStrictEqual([]);
    });
});

describe('configuration', () => {
    it('refuses a pinned registry whose name is not a registry name', () => {
        expect(() => new Gatekeeper({
            db: new DbJsonMemory('test'),
            ipfs,
            console: mockConsole,
            registries: ['local', 'hyperswarm', 'pin'],
            registriesPin: ['BTC:signet', 'not a registry'],
        })).toThrow('Invalid parameter: registryPin=not a registry');
    });
});

describe('proof format', () => {
    it('refuses an update whose proof names its key under something that is not a DID', async () => {
        const { did, keypair } = await createAgent();
        const doc = await gatekeeper.resolveDID(did);
        doc.didDocumentData = { changed: true };
        const signed = await helper.createUpdateOp(keypair, did, doc);
        const update = { ...signed, proof: { ...signed.proof!, verificationMethod: `cid:${did.split(':').pop()}#key-1` } };

        const error = await refusal(gatekeeper.updateDID(update));

        expect(error.message).toBe('Invalid operation: proof');
        expect((await gatekeeper.resolveDID(did)).didDocumentMetadata?.versionSequence).toBe('1');

        // The unchanged proof is accepted, so the key reference is what was refused.
        expect(await gatekeeper.updateDID(signed)).toBe(true);
    });

    it('refuses an imported event whose proof names its key under something that is not a DID', async () => {
        const { did, keypair } = await createAgent();
        const doc = await gatekeeper.resolveDID(did);
        doc.didDocumentData = { changed: true };
        const signed = await helper.createUpdateOp(keypair, did, doc);
        const operation = { ...signed, proof: { ...signed.proof!, verificationMethod: 'urn:example#key-1' } };
        const event: GatekeeperEvent = { registry: 'hyperswarm', time: operation.proof.created, ordinal: [0], operation };

        expect(await gatekeeper.importBatch([event])).toStrictEqual({ queued: 0, processed: 0, rejected: 1, total: 0 });
    });

    it('refuses to verify an update against a document when the proof has the wrong purpose', async () => {
        const { did, keypair } = await createAgent();
        const doc = await gatekeeper.resolveDID(did);
        doc.didDocumentData = { changed: true };
        const signed = await helper.createUpdateOp(keypair, did, doc);
        const update = { ...signed, proof: { ...signed.proof!, proofPurpose: 'keyAgreement' } } as unknown as Operation;
        const current = await gatekeeper.resolveDID(did);

        const error = await refusal(gatekeeper.verifyUpdateOperation(update, current));

        expect(error.message).toBe('Invalid operation: proof');
        expect(await gatekeeper.verifyUpdateOperation(signed, current)).toBe(true);
    });
});

describe('signing keys', () => {
    it('refuses an asset whose proof names a key its controller does not list', async () => {
        const { did: agent, keypair } = await createAgent();
        const signed = await helper.createAssetOp(agent, keypair);
        const asset = { ...signed, proof: { ...signed.proof!, verificationMethod: `${agent}#key-2` } };

        const error = await refusal(gatekeeper.createDID(asset));

        expect(error.message).toBe('Invalid operation: proof');
        expect(await gatekeeper.getDIDs()).toStrictEqual([agent]);
    });

    it('finds the named key when the document also lists a method with no id', async () => {
        const { did, keypair } = await createAgent();
        const current = await gatekeeper.resolveDID(did);
        const other = cipher.generateRandomJwk();
        const methods = current.didDocument!.verificationMethod!;
        const listed = {
            didDocument: {
                ...current.didDocument!,
                verificationMethod: [
                    { type: methods[0].type, controller: did, publicKeyJwk: other.publicJwk },
                    ...methods,
                ],
            },
        };
        expect(await gatekeeper.updateDID(await helper.createUpdateOp(keypair, did, listed as any))).toBe(true);

        const update = await helper.createUpdateOp(keypair, did, { didDocumentData: { signed: 'key-1' } });

        expect(await gatekeeper.updateDID(update)).toBe(true);
        expect((await gatekeeper.resolveDID(did)).didDocumentData).toStrictEqual({ signed: 'key-1' });
    });
});

describe('pin queue', () => {
    it('stops pinning when the pin queue is full', async () => {
        const gk = new Gatekeeper({
            db: new DbJsonMemory('test'),
            ipfs,
            console: mockConsole,
            maxQueueSize: 2,
            registries: ['local', 'hyperswarm', 'pin'],
            registriesPin: ['hyperswarm'],
        });
        await gk.resetDb();
        const gkHelper = new TestHelper(gk, cipher);
        const ops = [];
        for (let i = 0; i < 3; i++) {
            ops.push(await gkHelper.createAgentOp(cipher.generateRandomJwk(), { registry: 'hyperswarm' }));
        }

        await gk.createDID(ops[0]);
        expect(await gk.listRegistries()).toContain('pin');
        await gk.createDID(ops[1]);

        expect(await gk.listRegistries()).toStrictEqual(['local', 'hyperswarm']);

        await gk.createDID(ops[2]);

        expect(await gk.getQueue('pin')).toStrictEqual([ops[0], ops[1]]);
        expect(await gk.getQueue('hyperswarm')).toStrictEqual(ops);
    });
});

describe('imported updates', () => {
    it('refuses an update whose document names another DID', async () => {
        const { did, keypair } = await createAgent();
        const { did: otherDid } = await createAgent();
        const current = await gatekeeper.resolveDID(did);
        const operation = await helper.createUpdateOp(keypair, did, {
            didDocument: { ...current.didDocument!, id: otherDid },
        });
        const event: GatekeeperEvent = { registry: 'hyperswarm', time: operation.proof!.created, ordinal: [0], operation };

        expect(await gatekeeper.importBatch([event])).toStrictEqual({ queued: 0, processed: 0, rejected: 1, total: 0 });
        await gatekeeper.processEvents();
        expect((await gatekeeper.resolveDID(did)).didDocumentMetadata?.versionSequence).toBe('1');
        expect((await gatekeeper.resolveDID(otherDid)).didDocumentMetadata?.versionSequence).toBe('1');
    });
});

describe('relayed batches', () => {
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['an object', { operation: {} }],
        ['a string', 'events'],
    ])('refuses a batch that is %s', async (_, batch) => {
        const error = await refusal(gatekeeper.importRelayedBatch(batch as unknown as GatekeeperEvent[]));

        expect(error.message).toBe('Invalid parameter: batch');
    });
});

describe('rewindRegistry', () => {
    it.each([
        ['a malformed registry', 'not a registry', 0],
        ['local', 'local', 0],
        ['hyperswarm', 'hyperswarm', 0],
        ['pin', 'pin', 0],
        ['a negative height', 'BTC:signet', -1],
        ['a fractional height', 'BTC:signet', 1.5],
        ['a height of NaN', 'BTC:signet', NaN],
        ['a height past the safe integers', 'BTC:signet', 2 ** 53],
    ])('refuses %s', async (_, registry, fromHeight) => {
        await gatekeeper.addBlock('BTC:signet', { height: 5, hash: 'tip', time: 1000 });

        const error = await refusal(gatekeeper.rewindRegistry(registry, fromHeight));

        expect(error.message).toBe('Invalid parameter: registry/fromHeight');
        expect(await gatekeeper.getBlock('BTC:signet')).toMatchObject({ height: 5, hash: 'tip' });
    });
});
