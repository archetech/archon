import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import * as memeplex from '@didcid/memeplex';
import type { ResolvedVersion } from '@didcid/memeplex';
import * as grants from '../../packages/keymaster/src/grant.ts';

// Grants from a Keymaster: what an identity lets a client application do in its
// name. Keymaster knows no app. A client asks with a grant request, an asset it
// creates whose data holds `<app>GrantRequest`, and the grant is an asset of the
// granting identity holding `<app>Grant`. What a grant means is the app's.
//
// Most of this file uses a made-up app. Memeplex appears as one consumer: its
// verifier reads the grants made here, which is what shows the commands serve it.
// python/keymaster/tests/test_grant.py is this file for the Python port, and both
// run tests/fixtures/grant-request-vectors.json.

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

type RequestCase = { name: string; data: unknown; expect: { app: string; fault?: string } | null };

const requestCases: RequestCase[] = JSON.parse(readFileSync(path.join(FIXTURES, 'grant-request-vectors.json'), 'utf-8')).cases;

describe('the shape every grant request has', () => {
    it.each(requestCases.map(each => [each.name, each] as const))('reads data with %s as its vector states', (_name, each) => {
        const held = grants.grantRequestIn(each.data);
        const read = held ? { app: held.app, ...(grants.grantRequestFault(held.request) ? { fault: grants.grantRequestFault(held.request) } : {}) } : null;

        expect(read).toStrictEqual(each.expect);
    });

    it('has vectors for every fault, for a sound request and for data that holds none', () => {
        expect([...new Set(requestCases.map(each => each.expect === null ? 'none' : each.expect.fault ?? 'sound'))].sort())
            .toStrictEqual(['actions', 'expiresAt', 'name', 'none', 'registries', 'request', 'sound', 'v']);
    });

    it('names a request by its DID, an alias, or a link to it', () => {
        expect(grants.grantRequestId('did:cid:abc')).toBe('did:cid:abc');
        expect(grants.grantRequestId('  did:cid:abc\n')).toBe('did:cid:abc');
        expect(grants.grantRequestId('archon://grant?request=did:cid:abc')).toBe('did:cid:abc');
        expect(grants.grantRequestId('\tarchon://grant?request=did:cid:abc \n')).toBe('did:cid:abc');
        expect(grants.grantRequestId('my-request')).toBe('my-request');
        expect(grants.grantRequestId('archon://grant?request=')).toBe('');
        expect(grants.grantRequestId('archon://auth?challenge=did:cid:abc')).toBe('archon://auth?challenge=did:cid:abc');
    });

    it('finds the one grant in an asset\'s data', () => {
        const grant = { client: 'did:cid:client' };

        expect(grants.grantIn({ exampleGrant: grant, note: null })).toStrictEqual({ app: 'example', member: 'exampleGrant', grant });
        expect(grants.grantIn({ exampleGrant: grant, exampleGrantRequest: { registries: ['local'] } })?.app).toBe('example');
        expect(grants.grantIn({ exampleGrant: grant, otherGrant: grant })).toBeUndefined();
        expect(grants.grantIn({ exampleGrant: { client: 7 } })).toBeUndefined();
        expect(grants.grantIn({ exampleGrant: [grant] })).toBeUndefined();
        expect(grants.grantIn({ ExampleGrant: grant })).toBeUndefined();
        expect(grants.grantIn({ Grant: grant })).toBeUndefined();
        expect(grants.grantIn([grant])).toBeUndefined();
        expect(grants.grantIn(undefined)).toBeUndefined();
        expect(grants.grantMember('example')).toBe('exampleGrant');
    });
});

const BTC = 'BTC:mainnet';
const ETH = 'ETH:mainnet';
const blockTime = (block: number) => new Date(Date.UTC(2026, 10, 2, 0, block)).toISOString();

let ipfs: MemoryClient;
let gatekeeper: Gatekeeper;
let keymaster: Keymaster;
let alice: string;
let client: string;

beforeAll(async () => {
    ipfs = new MemoryClient();
    await ipfs.start();
});

afterAll(async () => {
    await ipfs.stop();
});

beforeEach(async () => {
    gatekeeper = new Gatekeeper({
        db: new DbJsonMemory('grants'), ipfs, registries: ['local', 'hyperswarm', BTC, ETH],
        console: { log: () => undefined, error: () => undefined, time: () => undefined, timeEnd: () => undefined } as never,
    });
    keymaster = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher: new CipherNode(), passphrase: 'passphrase' });
    await keymaster.loadOrCreateWallet();
    client = await keymaster.createId('Client', { registry: 'hyperswarm' });
    alice = await keymaster.createId('Alice', { registry: 'hyperswarm' });
});

// What a mediator does: take the operations queued for the chain, and return
// them to the Gatekeeper as anchored in a block.
async function anchor(block: number, registry = BTC) {
    const operations = await gatekeeper.getQueue(registry);

    await gatekeeper.addBlock(registry, { height: block, hash: `block-${block}`, time: Date.parse(blockTime(block)) / 1000 });

    expect(operations.length).toBeGreaterThan(0);
    await gatekeeper.importBatch(operations.map((operation, index) => ({
        registry,
        time: blockTime(block),
        ordinal: [block, 0, index],
        registration: { height: block, index: 0, txid: `tx-${block}`, batch: `did:cid:batch-${block}`, opidx: index },
        operation,
    })) as never);
    await gatekeeper.processEvents();
    await gatekeeper.clearQueue(registry, operations);
}

// A grant request as a client makes one: an asset of the client's, holding what
// it asks for under its app's name. It lists both chains unless told otherwise.
const requestOf = (request: Record<string, unknown> = {}, app = 'example') =>
    keymaster.createAsset({ [`${app}GrantRequest`]: { registries: [BTC, ETH], ...request } }, { registry: 'hyperswarm', controller: 'Client' });
const dataOf = async (did: string) => (await keymaster.resolveDID(did)).didDocumentData as Record<string, any>;
const grantOf = async (did: string, app = 'example') => (await dataOf(did))[`${app}Grant`];
const registryOf = async (did: string) => (await keymaster.resolveDID(did)).didDocumentRegistration?.registry;
const sequenceOf = async (did: string) => (await keymaster.resolveDID(did)).didDocumentMetadata?.versionSequence;
const verified = async (did: string) => memeplex.readGrant((await gatekeeper.resolveVersions([did]))[0] as ResolvedVersion[]);

describe('createGrant', () => {
    it('creates the grant a request asks for, to the identity that made the request', async () => {
        const request = await requestOf({ v: 1, name: 'Example', actions: ['example:read', 'example:write'], expiresAt: '2028-02-29T23:59:59.5Z' });
        const did = await keymaster.createGrant(request);
        const doc = await keymaster.resolveDID(did);

        expect(doc.didDocumentData).toStrictEqual({
            exampleGrant: { v: 1, client, request, actions: ['example:read', 'example:write'], expiresAt: '2028-02-29T23:59:59.5Z' },
        });
        expect(Object.keys((doc.didDocumentData as Record<string, any>).exampleGrant)).toStrictEqual(['v', 'client', 'request', 'actions', 'expiresAt']);
        expect(doc.didDocumentRegistration).toMatchObject({ type: 'asset', registry: BTC });
        expect(doc.didDocument?.controller).toBe(alice);
        expect(await keymaster.listAssets()).toStrictEqual([did]);
    });

    it('holds only the client and the request when the request asks for no more', async () => {
        const request = await requestOf({ name: 'Example' });

        expect(await grantOf(await keymaster.createGrant(request))).toStrictEqual({ client, request });
    });

    it('names the grant for the app the request names', async () => {
        const request = await requestOf({ v: 2 }, 'myApp2');
        const did = await keymaster.createGrant(request);

        expect(await dataOf(did)).toStrictEqual({ myApp2Grant: { v: 2, client, request } });
    });

    it('takes a link to the request, an alias for it, and white space around either', async () => {
        const request = await requestOf();
        await keymaster.addAlias('example-request', request);

        for (const named of [`archon://grant?request=${request}`, `  archon://grant?request=${request}\n`, 'example-request', ` ${request} `, 'archon://grant?request=example-request']) {
            expect(await grantOf(await keymaster.createGrant(named))).toStrictEqual({ client, request });
        }
    });

    it('takes who asks from who made the request, and nothing from its data', async () => {
        const request = await requestOf({ client: alice, nonce: 'Qm9vdHN0cmFwIG5vbmNlMTIz', request: 'did:cid:another' });

        expect(await grantOf(await keymaster.createGrant(request))).toStrictEqual({ client, request });
    });

    it.each([
        ['nothing', ''],
        ['white space', '  \n'],
        ['a link to nothing', 'archon://grant?request='],
        ['what is not a string', 7],
        ['no request at all', undefined],
    ])('refuses %s', async (_name, named) => {
        await expect(keymaster.createGrant(named as never))
            .rejects.toThrow('Invalid parameter: request: a DID, an alias or an archon://grant link is needed');
    });

    it('refuses a request the node does not have', async () => {
        const unknown = (await requestOf()).replace(/.{6}$/, 'aaaaaa');

        await expect(keymaster.createGrant(unknown)).rejects.toThrow('Invalid parameter: request: not found');
        await expect(keymaster.createGrant(`archon://grant?request=${unknown}`)).rejects.toThrow('Invalid parameter: request: not found');
        await expect(keymaster.createGrant('no-such-alias')).rejects.toThrow('Invalid parameter: request: not found');
        await expect(keymaster.createGrant('archon://auth?challenge=did:cid:abc')).rejects.toThrow('Invalid parameter: request: not found');
        expect(await keymaster.listAssets()).toStrictEqual([]);
    });

    it('refuses a request its client has deleted', async () => {
        const request = await requestOf();
        await keymaster.setCurrentId('Client');
        expect(await keymaster.revokeDID(request)).toBe(true);
        await keymaster.setCurrentId('Alice');

        await expect(keymaster.createGrant(request)).rejects.toThrow('Invalid parameter: request: deleted');
    });

    it('refuses what is not an asset', async () => {
        await expect(keymaster.createGrant(client)).rejects.toThrow('Invalid parameter: request: not an asset');
        await expect(keymaster.createGrant('Client')).rejects.toThrow('Invalid parameter: request: not an asset');
    });

    it('refuses a request transferred to another identity, which signed nothing', async () => {
        const request = await requestOf();
        const bob = await keymaster.createId('Bob', { registry: 'hyperswarm' });
        await keymaster.setCurrentId('Client');
        expect(await keymaster.transferAsset(request, bob)).toBe(true);
        await keymaster.setCurrentId('Alice');

        expect((await keymaster.resolveDID(request)).didDocument?.controller).toBe(bob);
        await expect(keymaster.createGrant(request))
            .rejects.toThrow('Invalid parameter: request: changed since it was created, so who asks is not established');
        expect(await keymaster.listAssets()).toStrictEqual([]);
    });

    it('refuses a request whose contents were replaced, even by its client', async () => {
        const request = await requestOf({ actions: ['example:read'] });
        await keymaster.setCurrentId('Client');
        expect(await keymaster.mergeData(request, { exampleGrantRequest: { registries: [BTC], actions: ['example:write'] } })).toBe(true);
        await keymaster.setCurrentId('Alice');

        await expect(keymaster.createGrant(request))
            .rejects.toThrow('Invalid parameter: request: changed since it was created, so who asks is not established');
    });

    it('refuses an asset that holds no one request', async () => {
        const plain = await keymaster.createAsset({ name: 'not a request' }, { registry: 'hyperswarm', controller: 'Client' });
        const two = await keymaster.createAsset(
            { exampleGrantRequest: { registries: [BTC] }, otherGrantRequest: { registries: [BTC] } }, { registry: 'hyperswarm', controller: 'Client' });
        const grant = await keymaster.createGrant(await requestOf());

        for (const did of [plain, two, grant]) {
            await expect(keymaster.createGrant(did)).rejects.toThrow('Invalid parameter: request: not a grant request');
        }
    });

    it.each(requestCases.filter(each => each.expect?.fault).map(each => [each.name, each] as const))(
        'refuses a request with %s', async (_name, each) => {
            const request = await keymaster.createAsset(each.data, { registry: 'hyperswarm', controller: 'Client' });

            await expect(keymaster.createGrant(request)).rejects.toThrow(`Invalid parameter: request: invalid (${each.expect!.fault})`);
            expect(await keymaster.listAssets()).toStrictEqual([]);
        });

    it('grants some of the actions the request lists, in the order it lists them', async () => {
        const request = await requestOf({ actions: ['c', 'a', 'b'] });

        expect((await grantOf(await keymaster.createGrant(request, { actions: ['b', 'c'] }))).actions).toStrictEqual(['c', 'b']);
        expect((await grantOf(await keymaster.createGrant(request, { actions: ['a'] }))).actions).toStrictEqual(['a']);
        expect((await grantOf(await keymaster.createGrant(request, { actions: ['b', 'a', 'c'] }))).actions).toStrictEqual(['c', 'a', 'b']);
    });

    it.each([
        ['an action the request does not list', { actions: ['a'] }, ['b'], 'every action must be one of a'],
        ['any action when the request lists none', {}, ['a'], 'the request lists no actions to choose from'],
        ['no actions', { actions: ['a'] }, [], 'a list of at least one action, each once, is needed'],
        ['an action twice', { actions: ['a'] }, ['a', 'a'], 'a list of at least one action, each once, is needed'],
        ['actions that are not a list', { actions: ['a'] }, 'a', 'a list of at least one action, each once, is needed'],
        ['an action that is not a string', { actions: ['a'] }, [1], 'a list of at least one action, each once, is needed'],
    ])('refuses %s', async (_name, asked, actions, message) => {
        const request = await requestOf(asked);

        await expect(keymaster.createGrant(request, { actions: actions as never })).rejects.toThrow(`Invalid parameter: options.actions: ${message}`);
        expect(await keymaster.listAssets()).toStrictEqual([]);
    });

    it('changes or removes the expiry the request asks for', async () => {
        const request = await requestOf({ expiresAt: '2027-01-01T00:00:00Z' });

        expect(await grantOf(await keymaster.createGrant(request))).toStrictEqual({ client, request, expiresAt: '2027-01-01T00:00:00Z' });
        expect(await grantOf(await keymaster.createGrant(request, { expiresAt: '2027-06-30T12:00:00+05:30' })))
            .toStrictEqual({ client, request, expiresAt: '2027-06-30T12:00:00+05:30' });
        expect(await grantOf(await keymaster.createGrant(request, { expiresAt: null }))).toStrictEqual({ client, request });
        expect(await grantOf(await keymaster.createGrant(await requestOf(), { expiresAt: '2027-06-30T12:00:00Z' })))
            .toMatchObject({ expiresAt: '2027-06-30T12:00:00Z' });
    });

    it.each(['2027-02-30T00:00:00Z', '2027-06-30', '2027-06-30T12:00:00', '2027-06-30T12:00:00Z\n', '', 1798675200])(
        'refuses the expiry %j', async expiresAt => {
            await expect(keymaster.createGrant(await requestOf(), { expiresAt: expiresAt as never }))
                .rejects.toThrow('Invalid parameter: options.expiresAt: not a date-time such as 2027-01-31T00:00:00Z');
            expect(await keymaster.listAssets()).toStrictEqual([]);
        });

    it('takes the first registry the request lists that the node supports', async () => {
        expect(await registryOf(await keymaster.createGrant(await requestOf({ registries: [ETH, BTC] })))).toBe(ETH);
        expect(await registryOf(await keymaster.createGrant(await requestOf({ registries: ['ZEC:mainnet', ETH, BTC] })))).toBe(ETH);
        expect(await registryOf(await keymaster.createGrant(await requestOf({ registries: ['hyperswarm'] })))).toBe('hyperswarm');
    });

    it('creates the grant on the registry named, when the request lists it', async () => {
        const request = await requestOf({ registries: [BTC, ETH, 'hyperswarm'] });

        expect(await registryOf(await keymaster.createGrant(request, { registry: ETH }))).toBe(ETH);
        expect(await registryOf(await keymaster.createGrant(request, { registry: 'hyperswarm' }))).toBe('hyperswarm');
    });

    it('refuses a registry the request does not list, or the node does not support', async () => {
        await expect(keymaster.createGrant(await requestOf({ registries: [ETH, 'SOL:mainnet-beta'] }), { registry: BTC }))
            .rejects.toThrow('Invalid parameter: options.registry: the request lists ETH:mainnet, SOL:mainnet-beta, not BTC:mainnet');
        await expect(keymaster.createGrant(await requestOf({ registries: ['ZEC:mainnet', BTC] }), { registry: 'ZEC:mainnet' }))
            .rejects.toThrow('Invalid parameter: options.registry: this node does not support ZEC:mainnet');
        await expect(keymaster.createGrant(await requestOf({ registries: ['ZEC:mainnet', 'my chain'] })))
            .rejects.toThrow('Invalid parameter: options.registry: the request lists ZEC:mainnet, my chain and this node supports none of them');
        expect(await keymaster.listAssets()).toStrictEqual([]);
    });

    it('creates a local identity\'s grant on local, and only when the request lists local', async () => {
        await keymaster.createId('Larry', { registry: 'local' });

        await expect(keymaster.createGrant(await requestOf()))
            .rejects.toThrow('Invalid parameter: options.controller: a local identity\'s grant is created on local, and the request lists BTC:mainnet, ETH:mainnet');
        await expect(keymaster.createGrant(await requestOf({ registries: [BTC, 'local'] }), { registry: BTC }))
            .rejects.toThrow('Invalid parameter: options.controller: a local identity\'s grant is created on local, and the request lists BTC:mainnet, local');
        expect(await keymaster.listAssets()).toStrictEqual([]);

        expect(await registryOf(await keymaster.createGrant(await requestOf({ registries: [BTC, 'local'] })))).toBe('local');
        expect(await registryOf(await keymaster.createGrant(await requestOf({ registries: [BTC, 'local'] }), { registry: 'local' }))).toBe('local');
    });

    it('refuses a request the granting identity made itself', async () => {
        const request = await requestOf();

        await expect(keymaster.createGrant(request, { controller: 'Client' }))
            .rejects.toThrow('Invalid parameter: request: the granting identity made the request, and cannot grant itself');
        await keymaster.setCurrentId('Client');
        await expect(keymaster.createGrant(request)).rejects.toThrow('cannot grant itself');
        expect(await keymaster.listAssets()).toStrictEqual([request]);
    });

    it('grants from the identity named as controller, under an alias', async () => {
        const bob = await keymaster.createId('Bob', { registry: 'hyperswarm' });
        await keymaster.setCurrentId('Alice');

        const did = await keymaster.createGrant(await requestOf(), { controller: 'Bob', alias: 'example-grant' });

        expect((await keymaster.resolveDID('example-grant')).didDocument).toMatchObject({ id: did, controller: bob });
        expect(await keymaster.listAssets()).toStrictEqual([]);
        expect(await keymaster.listAssets('Bob')).toStrictEqual([did]);
    });

    it('creates and signs the grant as the identity it checked, whatever the current ID becomes', async () => {
        const request = await requestOf();
        const resolve = gatekeeper.resolveDID.bind(gatekeeper);
        let switched = false;

        // The current ID changes to the client while the grantor is being checked.
        jest.spyOn(gatekeeper, 'resolveDID').mockImplementation(async (did, options) => {
            if (did === alice && options?.confirm && !switched) {
                switched = true;
                await keymaster.setCurrentId('Client');
            }
            return resolve(did, options);
        });

        const did = await keymaster.createGrant(request);

        expect(switched).toBe(true);
        expect(await keymaster.getCurrentId()).toBe('Client');
        expect((await keymaster.resolveDID(did)).didDocument?.controller).toBe(alice);
        expect(await keymaster.listAssets('Alice')).toStrictEqual([did]);
        expect(await keymaster.listAssets('Client')).toStrictEqual([request]);
    });
});

describe('listGrants', () => {
    it('lists only assets that hold one grant', async () => {
        const grant = { client };

        await keymaster.createAsset({ name: 'not a grant' }, { registry: BTC });
        await keymaster.createAsset({ exampleGrant: { client: 7 } }, { registry: BTC });
        await keymaster.createAsset({ exampleGrant: grant, otherGrant: grant }, { registry: BTC });
        await keymaster.createAsset({ exampleGrantRequest: { registries: [BTC] } }, { registry: BTC });
        await keymaster.createAsset(['exampleGrant'], { registry: BTC });

        expect(await keymaster.listGrants()).toStrictEqual([]);
    });

    it('lists a grant with its app and its request, as pending until it is anchored on its registry', async () => {
        const request = await requestOf({ actions: ['example:read'], expiresAt: '2028-01-01T00:00:00Z' });
        const did = await keymaster.createGrant(request);
        const listed = { did, app: 'example', grant: { client, request, actions: ['example:read'], expiresAt: '2028-01-01T00:00:00Z' }, request, registry: BTC, created: true };

        expect(await keymaster.listGrants()).toStrictEqual([{ ...listed, status: 'pending' }]);
        expect(Object.keys((await keymaster.listGrants())[0])).toStrictEqual(['did', 'status', 'app', 'grant', 'request', 'registry', 'created']);

        await anchor(100);
        expect(await keymaster.listGrants()).toStrictEqual([{ ...listed, status: 'anchored' }]);
    });

    it('lists the grants of every app, and one made without a request', async () => {
        const first = await keymaster.createGrant(await requestOf());
        const second = await keymaster.createGrant(await requestOf({}, 'memeplex'));
        const third = await keymaster.createAsset({ handGrant: { client, label: 'made by hand' } }, { registry: 'hyperswarm' });

        expect((await keymaster.listGrants()).map(({ did, app }) => ({ did, app }))).toStrictEqual([
            { did: first, app: 'example' }, { did: second, app: 'memeplex' }, { did: third, app: 'hand' },
        ]);
        expect((await keymaster.listGrants())[2])
            .toStrictEqual({ did: third, status: 'pending', app: 'hand', grant: { client, label: 'made by hand' }, registry: 'hyperswarm', created: true });
    });

    it('lists a change as pending until it is anchored, and as not the creation', async () => {
        const did = await keymaster.createGrant(await requestOf());
        await anchor(100);

        expect(await keymaster.updateGrant(did, { actions: ['example:read'] })).toBe(true);
        expect(await keymaster.listGrants()).toMatchObject([{ did, status: 'pending', created: false, grant: { actions: ['example:read'] } }]);
        await anchor(200);
        expect(await keymaster.listGrants()).toMatchObject([{ did, status: 'anchored', created: false }]);
    });

    it('does not take an anchor on another chain, or confirmation, for an anchor', async () => {
        const did = await keymaster.createGrant(await requestOf());
        const resolved = await gatekeeper.resolveDID(did);
        const resolve = gatekeeper.resolveDID.bind(gatekeeper);
        let timestamp: unknown;

        jest.spyOn(gatekeeper, 'resolveDID').mockImplementation(async (id, options) => id === did
            ? { ...resolved, didDocumentMetadata: { ...resolved.didDocumentMetadata, confirmed: true, timestamp } } as never
            : resolve(id, options));
        const statusWith = async (given: unknown) => {
            timestamp = given;
            return (await keymaster.listGrants())[0].status;
        };
        const block = { height: 100, timeISO: blockTime(100) };

        expect(await statusWith(undefined)).toBe('pending');
        expect(await statusWith({ chain: ETH, upperBound: block })).toBe('pending');
        expect(await statusWith({ chain: BTC, lowerBound: block })).toBe('pending');
        expect(await statusWith({ chain: BTC, upperBound: { height: 100 } })).toBe('pending');
        expect(await statusWith({ chain: BTC, upperBound: { height: '100', timeISO: block.timeISO } })).toBe('pending');
        expect(await statusWith({ chain: BTC, upperBound: block })).toBe('anchored');
    });

    it('lists the grants of the identity asked for', async () => {
        const did = await keymaster.createGrant(await requestOf());
        await keymaster.createId('Bob', { registry: 'hyperswarm' });

        expect(await keymaster.listGrants()).toStrictEqual([]);
        expect((await keymaster.listGrants('Alice')).map(each => each.did)).toStrictEqual([did]);
        expect((await keymaster.listGrants(alice)).map(each => each.did)).toStrictEqual([did]);
        expect(await keymaster.listGrants('Client')).toStrictEqual([]);
        await expect(keymaster.listGrants('Nobody')).rejects.toThrow('Unknown ID');
    });

    it('lists an asset the node cannot resolve as unresolved', async () => {
        const first = await keymaster.createGrant(await requestOf());
        const asset = await keymaster.createAsset({ name: 'not a grant' }, { registry: BTC });
        const second = await keymaster.createGrant(await requestOf());
        const resolve = gatekeeper.resolveDID.bind(gatekeeper);

        jest.spyOn(gatekeeper, 'resolveDID').mockImplementation(async (did, options) => {
            if (did === first || did === asset) {
                throw new Error('unreachable');
            }
            return resolve(did, options);
        });

        expect((await keymaster.listGrants()).map(({ did, status }) => ({ did, status }))).toStrictEqual([
            { did: first, status: 'unresolved' },
            { did: asset, status: 'unresolved' },
            { did: second, status: 'pending' },
        ]);
        expect((await keymaster.listGrants())[0]).toStrictEqual({ did: first, status: 'unresolved' });
    });

    it('does not list a revoked grant, which listRevocations has', async () => {
        const kept = await keymaster.createGrant(await requestOf());
        const revoked = await keymaster.createGrant(await requestOf());

        expect(await keymaster.revokeGrant(revoked)).toBe(true);
        expect((await keymaster.listGrants()).map(each => each.did)).toStrictEqual([kept]);
        expect(await keymaster.listRevocations()).toStrictEqual([{ did: revoked, registry: BTC, status: 'pending' }]);
    });

    it('lists a grant again after a revocation that did not take effect', async () => {
        const request = await requestOf({ actions: ['example:read'] });
        const did = await keymaster.createGrant(request);
        const live = await gatekeeper.resolveDID(did);
        const resolve = gatekeeper.resolveDID.bind(gatekeeper);

        expect(await keymaster.revokeGrant(did)).toBe(true);
        expect(await keymaster.listGrants()).toStrictEqual([]);
        expect((await keymaster.fetchIdInfo('Alice')).revoking).toStrictEqual([did]);

        // Another change took the deletion's place: the node resolves the grant as live.
        jest.spyOn(gatekeeper, 'resolveDID').mockImplementation(async (id, options) => id === did ? live : resolve(id, options));
        await keymaster.createId('Bob', { registry: 'hyperswarm' });

        expect(await keymaster.listGrants()).toStrictEqual([]);
        expect(await keymaster.listGrants('Alice')).toStrictEqual([{
            did, status: 'pending', app: 'example', grant: { client, request, actions: ['example:read'] }, request, registry: BTC, created: true,
        }]);
        expect(await keymaster.listAssets('Alice')).toStrictEqual([did]);
        expect((await keymaster.fetchIdInfo('Alice')).revoking).toBeUndefined();
    });
});

describe('updateGrant', () => {
    it('changes the actions to any the caller names, and keeps every other member', async () => {
        const scope = { v: 1, client, nonce: 'Qm9vdHN0cmFwIG5vbmNlMTIz', label: 'phone', expiresAt: '2028-01-01T00:00:00Z' };
        const did = await keymaster.createAsset({ exampleGrant: scope, note: 'kept' }, { registry: BTC });

        expect(await keymaster.updateGrant(did, { actions: ['example:write', 'anything at all'] })).toBe(true);
        expect(await dataOf(did)).toStrictEqual({ exampleGrant: { ...scope, actions: ['example:write', 'anything at all'] }, note: 'kept' });
    });

    it('keeps a member of the data whose value is null', async () => {
        const did = await keymaster.createAsset({ exampleGrant: { client }, note: null, kept: { deep: null } }, { registry: BTC });

        expect(await keymaster.updateGrant(did, { actions: ['example:read'] })).toBe(true);
        expect(await dataOf(did)).toStrictEqual({ exampleGrant: { client, actions: ['example:read'] }, note: null, kept: { deep: null } });
    });

    it('removes the actions or the expiry with null, and sets either', async () => {
        const request = await requestOf({ actions: ['example:read'] });
        const did = await keymaster.createGrant(request);

        expect(await keymaster.updateGrant(did, { expiresAt: '2028-01-01T00:00:00Z' })).toBe(true);
        expect(await grantOf(did)).toStrictEqual({ client, request, actions: ['example:read'], expiresAt: '2028-01-01T00:00:00Z' });
        expect(await keymaster.updateGrant(did, { actions: null, expiresAt: '2029-01-01T00:00:00-08:00' })).toBe(true);
        expect(await grantOf(did)).toStrictEqual({ client, request, expiresAt: '2029-01-01T00:00:00-08:00' });
        expect(await keymaster.updateGrant(did, { expiresAt: null })).toBe(true);
        expect(await grantOf(did)).toStrictEqual({ client, request });
    });

    it('writes nothing when the change leaves the grant as it is', async () => {
        const did = await keymaster.createGrant(await requestOf({ actions: ['example:read'], expiresAt: '2028-01-01T00:00:00Z' }));
        const before = await sequenceOf(did);

        expect(await keymaster.updateGrant(did, { actions: ['example:read'], expiresAt: '2028-01-01T00:00:00Z' })).toBe(true);
        expect(await keymaster.updateGrant(did, { actions: ['example:read'] })).toBe(true);
        expect(await sequenceOf(did)).toBe(before);

        expect(await keymaster.updateGrant(did, { actions: ['example:write'] })).toBe(true);
        expect(await sequenceOf(did)).not.toBe(before);
    });

    it('is refused when the grant has changed since it was read, and leaves that change standing', async () => {
        const request = await requestOf();
        const did = await keymaster.createGrant(request);
        const resolve = gatekeeper.resolveDID.bind(gatekeeper);
        let intervened = false;

        // Another update lands after this one has read the grant.
        jest.spyOn(gatekeeper, 'resolveDID').mockImplementation(async (id, options) => {
            const read = await resolve(id, options);

            if (id === did && !intervened) {
                intervened = true;
                expect(await keymaster.updateGrant(did, { actions: ['example:read'] })).toBe(true);
            }
            return read;
        });

        await expect(keymaster.updateGrant(did, { expiresAt: '2028-01-01T00:00:00Z' }))
            .rejects.toThrow('Invalid operation: previd');

        expect(intervened).toBe(true);
        expect(await grantOf(did)).toStrictEqual({ client, request, actions: ['example:read'] });
        expect(await sequenceOf(did)).toBe('2');
    });

    it.each([
        ['no change', {}, 'changes: actions or expiresAt is needed'],
        ['changes that are not an object', 'actions', 'changes: actions or expiresAt is needed'],
        ['no changes at all', undefined, 'changes: actions or expiresAt is needed'],
        ['no actions', { actions: [] }, 'changes.actions: a list of at least one action, each once, is needed'],
        ['an action twice', { actions: ['a', 'a'] }, 'changes.actions: a list of at least one action, each once, is needed'],
        ['an empty action', { actions: [''] }, 'changes.actions: a list of at least one action, each once, is needed'],
        ['an expiry that is not a date-time', { expiresAt: '2027-02-30T00:00:00Z' }, 'changes.expiresAt: not a date-time such as 2027-01-31T00:00:00Z'],
        ['a sound action with an unsound expiry', { actions: ['a'], expiresAt: 'tomorrow' }, 'changes.expiresAt: not a date-time'],
    ])('refuses %s', async (_name, changes, message) => {
        const did = await keymaster.createGrant(await requestOf({ actions: ['example:read'] }));
        const before = await sequenceOf(did);

        await expect(keymaster.updateGrant(did, changes as never)).rejects.toThrow(`Invalid parameter: ${message}`);
        expect(await sequenceOf(did)).toBe(before);
    });

    it('finds a grant by its alias', async () => {
        await keymaster.createGrant(await requestOf(), { alias: 'example-grant' });

        expect(await keymaster.updateGrant('example-grant', { actions: ['example:read'] })).toBe(true);
        expect((await grantOf('example-grant')).actions).toStrictEqual(['example:read']);
    });

    it('refuses what is not a live grant of the current ID', async () => {
        const asset = await keymaster.createAsset({ name: 'not a grant' }, { registry: BTC });
        const request = await requestOf();
        const revoked = await keymaster.createGrant(request);
        const grant = await keymaster.createGrant(await requestOf({ actions: ['example:read'] }));
        const changes = { actions: ['example:write'] };

        expect(await keymaster.revokeGrant(revoked)).toBe(true);

        for (const did of [asset, revoked, alice]) {
            await expect(keymaster.updateGrant(did, changes)).rejects.toThrow('Invalid parameter: id: not a grant');
            await expect(keymaster.revokeGrant(did)).rejects.toThrow('Invalid parameter: id: not a grant');
        }

        // The request is the client's, and is no grant.
        await expect(keymaster.updateGrant(request, changes)).rejects.toThrow('Invalid parameter: id: not a grant');

        await keymaster.createId('Bob', { registry: 'hyperswarm' });
        await expect(keymaster.updateGrant(grant, changes)).rejects.toThrow('Invalid parameter: id: not a grant of the current ID');
        await expect(keymaster.revokeGrant(grant)).rejects.toThrow('Invalid parameter: id: not a grant of the current ID');

        await keymaster.setCurrentId('Alice');
        expect((await grantOf(grant)).actions).toStrictEqual(['example:read']);
        expect((await keymaster.resolveDID(asset)).didDocumentMetadata?.deactivated).toBeFalsy();
        expect((await keymaster.resolveDID(alice)).didDocumentMetadata?.deactivated).toBeFalsy();
    });
});

describe('revokeGrant', () => {
    it('deletes the grant, which listRevocations has until the deletion is anchored', async () => {
        const did = await keymaster.createGrant(await requestOf());
        await anchor(100);

        expect(await keymaster.revokeGrant(did)).toBe(true);
        expect((await keymaster.resolveDID(did)).didDocumentMetadata?.deactivated).toBe(true);
        expect(await keymaster.listGrants()).toStrictEqual([]);
        expect(await keymaster.listRevocations()).toStrictEqual([{ did, registry: BTC, status: 'pending' }]);

        await anchor(200);
        expect(await keymaster.listRevocations()).toStrictEqual([]);
    });

    it('revokes a grant by its alias', async () => {
        const did = await keymaster.createGrant(await requestOf(), { alias: 'example-grant' });

        expect(await keymaster.revokeGrant('example-grant')).toBe(true);
        expect((await keymaster.resolveDID(did)).didDocumentMetadata?.deactivated).toBe(true);
    });
});

describe('an app of its own', () => {
    it('is granted, listed, changed and revoked by its name alone', async () => {
        const request = await keymaster.createAsset(
            { birdwatchGrantRequest: { v: 3, name: 'Birdwatch', registries: ['hyperswarm'], actions: ['sightings:add', 'sightings:edit'], colour: 'teal' } },
            { registry: 'hyperswarm', controller: 'Client' });

        const did = await keymaster.createGrant(`archon://grant?request=${request}`, { actions: ['sightings:add'] });
        const grant = { v: 3, client, request, actions: ['sightings:add'] };

        expect(await dataOf(did)).toStrictEqual({ birdwatchGrant: grant });
        expect(await keymaster.listGrants())
            .toStrictEqual([{ did, status: 'pending', app: 'birdwatch', grant, request, registry: 'hyperswarm', created: true }]);

        expect(await keymaster.updateGrant(did, { actions: ['sightings:edit', 'sightings:delete'], expiresAt: '2030-01-01T00:00:00Z' })).toBe(true);
        expect(await dataOf(did))
            .toStrictEqual({ birdwatchGrant: { ...grant, actions: ['sightings:edit', 'sightings:delete'], expiresAt: '2030-01-01T00:00:00Z' } });
        expect(await keymaster.listGrants()).toMatchObject([{ did, app: 'birdwatch', created: false }]);

        expect(await keymaster.revokeGrant(did)).toBe(true);
        expect(await keymaster.listGrants()).toStrictEqual([]);
        expect((await keymaster.resolveDID(did)).didDocumentMetadata?.deactivated).toBe(true);
    });
});

// Memeplex as one app that uses these grants. Its verifier knows nothing of
// Keymaster: it reads the versions a Gatekeeper resolves.
describe('a Memeplex grant', () => {
    const memeplexRequest = (request: Record<string, unknown> = {}) =>
        requestOf({ v: 1, name: 'Memepool', registries: [BTC, ETH], ...request }, 'memeplex');

    it('is read by the Memeplex verifier as valid, once it is anchored', async () => {
        const request = await memeplexRequest({ actions: ['memeplex:post', 'memeplex:reply'] });
        const did = await keymaster.createGrant(request);

        expect(await dataOf(did)).toStrictEqual({ memeplexGrant: { v: 1, client, request, actions: ['memeplex:post', 'memeplex:reply'] } });
        expect(await verified(did)).toStrictEqual({ status: 'pending', user: alice, client, registry: BTC });

        await anchor(100);
        expect(await verified(did)).toMatchObject({ status: 'valid', user: alice, client, registry: BTC, pending: 0 });
    });

    it('has its changes read as scope updates that do not end it', async () => {
        const did = await keymaster.createGrant(await memeplexRequest({ actions: ['memeplex:post', 'memeplex:tag'] }));
        await anchor(100);
        expect(await keymaster.updateGrant(did, { actions: ['memeplex:tag'], expiresAt: '2028-01-01T00:00:00Z' })).toBe(true);
        await anchor(200);
        expect(await keymaster.updateGrant(did, { actions: null, expiresAt: null })).toBe(true);
        await anchor(300);

        const read = await verified(did);

        expect(read).toMatchObject({ status: 'valid', user: alice, client, pending: 0 });
        expect(read.status === 'valid' && read.ended).toBeUndefined();
        expect(read.status === 'valid' && read.versions.map(({ actions, expiresAt }) => ({ actions, expiresAt }))).toStrictEqual([
            { actions: ['memeplex:post', 'memeplex:tag'], expiresAt: undefined },
            { actions: ['memeplex:tag'], expiresAt: '2028-01-01T00:00:00Z' },
            { actions: undefined, expiresAt: undefined },
        ]);
    });

    it('keeps null data through a change, so the verifier still reads a scope update', async () => {
        const did = await keymaster.createAsset({ memeplexGrant: { v: 1, client }, note: null }, { registry: BTC });
        await anchor(100);

        expect(await keymaster.updateGrant(did, { actions: ['memeplex:tag'] })).toBe(true);
        expect(await dataOf(did)).toStrictEqual({ memeplexGrant: { v: 1, client, actions: ['memeplex:tag'] }, note: null });
        await anchor(200);

        const read = await verified(did);

        expect(read.status === 'valid' && read.ended).toBeUndefined();
        expect(read.status === 'valid' && read.versions.map(version => version.actions)).toStrictEqual([undefined, ['memeplex:tag']]);
    });

    it('has its revocation read as its end, once that is anchored', async () => {
        const did = await keymaster.createGrant(await memeplexRequest());
        await anchor(100);

        expect(await keymaster.revokeGrant(did)).toBe(true);
        expect(await verified(did)).toMatchObject({ status: 'valid', pending: 1 });

        await anchor(200);
        expect(await verified(did)).toMatchObject({ status: 'valid', ended: { block: 200 }, pending: 0 });
    });

    // Keymaster applies no app's rules. A request that has the shape every
    // request has is granted, and the app's verifier says what the grant is worth.
    it('is created when Memeplex would not accept it, and the verifier says so', async () => {
        const nonsense = await keymaster.createGrant(await memeplexRequest({ actions: ['memeplex:nonsense'] }));
        const offChain = await keymaster.createGrant(await memeplexRequest({ registries: ['hyperswarm'] }));
        const offset = await keymaster.createGrant(await memeplexRequest({ expiresAt: '2028-01-01T00:00:00+01:00' }));
        const version = await keymaster.createGrant(await memeplexRequest({ v: 2 }));

        expect((await grantOf(nonsense, 'memeplex')).actions).toStrictEqual(['memeplex:nonsense']);
        expect(await registryOf(offChain)).toBe('hyperswarm');
        expect((await keymaster.listGrants()).map(each => each.app)).toStrictEqual(['memeplex', 'memeplex', 'memeplex', 'memeplex']);

        expect(await verified(nonsense)).toStrictEqual({ status: 'void', reason: 'invalid' });
        expect(await verified(offChain)).toStrictEqual({ status: 'void', reason: 'registry' });
        expect(await verified(offset)).toStrictEqual({ status: 'void', reason: 'invalid' });
        expect(await verified(version)).toStrictEqual({ status: 'unsupported' });
    });
});
