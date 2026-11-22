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

// Grants from a Keymaster: docs/plans/memeplex-reference-1436.md, "Grant request
// flow" and "Wallet". Keymaster states the link and grant rules itself, since it
// cannot depend on @didcid/memeplex; the first half of this file holds it to the
// verifier's answers and to the fixtures the Python port also runs. The second
// half is createGrant, listGrants, updateGrant and revokeGrant against a
// Gatekeeper, with the verifier reading what they wrote.
// python/keymaster/tests/test_grant.py is this file for the Python port.

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const read = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf-8'));

type LinkCase = { name: string; link: string; expect: Record<string, unknown>; verifier?: 'pending' };
type ValidityCase = { name: string; member: string; expect: string; request?: unknown; operation?: { data: Record<string, unknown> } };

const linkCases: LinkCase[] = read('memeplex-grant-link-vectors.json').cases;
const validityCases: ValidityCase[] = read('memeplex-v1-vectors.json').cases
    .filter((each: ValidityCase) => each.member !== 'memeplex');

describe('the rules Keymaster states', () => {
    it('are the verifier\'s constants', () => {
        expect(grants.PERMITTED_GRANT_REGISTRIES).toStrictEqual([...memeplex.PERMITTED_REGISTRIES]);
        expect(grants.GRANT_LINK_PREFIX).toBe(memeplex.GRANT_LINK_PREFIX);
        expect(grants.MAX_GRANT_LINK_LENGTH).toBe(memeplex.MAX_GRANT_LINK_LENGTH);
        expect(grants.CORE_GRANT_ACTIONS.map(action => grants.isGrantAction(action))).toStrictEqual([true, true, true, true]);
        expect([...new Set(memeplex.KINDS.map(kind => memeplex.actionFor(kind)))].sort()).toStrictEqual([...grants.CORE_GRANT_ACTIONS].sort());
    });

    it('have vectors for grants and for grant requests', () => {
        expect(validityCases.filter(each => each.member === 'memeplexGrant').length).toBeGreaterThan(20);
        expect(validityCases.filter(each => each.member === 'memeplexGrantRequest').length).toBeGreaterThan(5);
        expect([...new Set(validityCases.map(each => each.expect))].sort())
            .toStrictEqual(['expiry-instant', 'schema', 'unsupported', 'valid', 'version']);
    });

    it.each(validityCases.map(each => [each.name, each] as const))('judge %s as its vector states', (_name, each) => {
        const value = each.request ?? each.operation!.data[each.member];
        const [ours, theirs] = each.member === 'memeplexGrant'
            ? [grants.validateGrant(value), memeplex.validateGrant(value)]
            : [grants.validateGrantRequest(value), memeplex.validateGrantRequest(value)];

        expect(ours).toBe(each.expect);
        expect(theirs).toBe(each.expect);
    });

    it.each(linkCases.map(each => [each.name, each] as const))('decode a link with %s as its vector states', (_name, each) => {
        expect(grants.decodeGrantLink(each.link)).toStrictEqual(each.expect);
        if (each.verifier !== 'pending') {
            expect(memeplex.decodeGrantLink(each.link)).toStrictEqual(each.expect);
        }
    });

    it('judge the request each link vector carries as the verifier does, as a grant too', () => {
        const carried = linkCases
            .filter(each => each.verifier !== 'pending')
            .map(each => {
                try {
                    return JSON.parse(Buffer.from(each.link.slice(grants.GRANT_LINK_PREFIX.length), 'base64url').toString('utf8'));
                }
                catch {
                    return undefined;
                }
            })
            .map(value => value?.memeplexGrantRequest);

        expect(carried.filter(value => value !== undefined).length).toBeGreaterThan(40);
        for (const value of carried) {
            expect(grants.validateGrant(value)).toBe(memeplex.validateGrant(value));
            expect(grants.validateGrantRequest(value)).toBe(memeplex.validateGrantRequest(value));
        }
    });

    it('leave to the verifier only the registries a request lists', () => {
        expect(linkCases.filter(each => each.verifier === 'pending').map(each => each.name)).toStrictEqual([
            'no registries listed', 'a registry twice', 'a registry a grant may not be created on',
            'a testnet registry', 'registries that are not a list', 'a registry that is not a string',
        ]);
    });

    it('allow a grant a registries member, which is no field of a grant', () => {
        const grant = { v: 1, client: 'did:cid:bagaaieraclient', registries: 'anything' };

        expect(grants.validateGrant(grant)).toBe('valid');
        expect(memeplex.validateGrant(grant)).toBe('valid');
    });

    it('show every refusal of a link', () => {
        expect([...new Set(linkCases.map(each => each.expect.error ?? 'accepted'))].sort())
            .toStrictEqual(['accepted', 'invalid-request', 'not-a-grant-link', 'too-long', 'undecodable']);
    });

    it('refuse a link that is not a string', () => {
        expect(grants.decodeGrantLink(5 as never)).toStrictEqual({ error: 'not-a-grant-link' });
        expect(grants.decodeGrantLink(undefined as never)).toStrictEqual({ error: 'not-a-grant-link' });
    });

    it('decode the links the verifier encodes', () => {
        const request = { v: 1, client: 'did:cid:bagaaieraclient', name: 'Mémépool 🌊', actions: ['memeplex:tag'], nonce: 'Qm9vdHN0cmFwIG5vbmNlMTIz' };

        expect(grants.decodeGrantLink(memeplex.encodeGrantLink(request))).toStrictEqual({ request });
    });
});

const BTC = 'BTC:mainnet';
const ETH = 'ETH:mainnet';
const NONCE = 'Qm9vdHN0cmFwIG5vbmNlMTIz';
const EXTENSION = `did:cid:bagaaieraschemaschemaschemaschemaschemaschemaschemaschemasch?versionId=b${'a'.repeat(58)}`;
const OTHER_EXTENSION = `did:cid:bagaaieraotherotherotherotherotherotherotherotherotherotherot?versionId=b${'c'.repeat(58)}`;
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

function nodeWith(registries: string[]) {
    gatekeeper = new Gatekeeper({
        db: new DbJsonMemory('grants'), ipfs, registries,
        console: { log: () => undefined, error: () => undefined, time: () => undefined, timeEnd: () => undefined } as never,
    });
    keymaster = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher: new CipherNode(), passphrase: 'passphrase' });
}

beforeEach(async () => {
    nodeWith(['local', 'hyperswarm', BTC, ETH]);
    await keymaster.loadOrCreateWallet();
    client = await keymaster.createId('Memepool', { registry: 'hyperswarm' });
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

const linkFor = (request: Record<string, unknown> = {}) =>
    memeplex.encodeGrantLink({ v: 1, client, name: 'Memepool', nonce: NONCE, ...request });
const grantOf = async (did: string) => ((await keymaster.resolveDID(did)).didDocumentData as Record<string, any>).memeplexGrant;
const verified = async (did: string) => memeplex.readGrant((await gatekeeper.resolveVersions([did]))[0] as ResolvedVersion[]);
const sequenceOf = async (did: string) => (await keymaster.resolveDID(did)).didDocumentMetadata?.versionSequence;

describe('createGrant', () => {
    it('creates the grant a link asks for, on the first permitted registry the node supports', async () => {
        const did = await keymaster.createGrant(linkFor());
        const doc = await keymaster.resolveDID(did);

        expect(doc.didDocumentData).toStrictEqual({ memeplexGrant: { v: 1, client, nonce: NONCE } });
        expect(doc.didDocumentRegistration).toMatchObject({ type: 'asset', registry: BTC });
        expect(doc.didDocument?.controller).toBe(alice);
        expect(await keymaster.listAssets()).toStrictEqual([did]);
        expect(await verified(did)).toStrictEqual({ status: 'pending', user: alice, client, registry: BTC });

        await anchor(100);
        expect(await verified(did)).toMatchObject({ status: 'valid', user: alice, client, registry: BTC, pending: 0 });
    });

    it('grants the actions and the expiry the link asks for', async () => {
        const asked = { actions: ['memeplex:tag', 'memeplex:post', EXTENSION], expiresAt: '2028-02-29T23:59:59.5Z' };
        const did = await keymaster.createGrant(linkFor(asked));

        expect(await grantOf(did)).toStrictEqual({ v: 1, client, actions: asked.actions, nonce: NONCE, expiresAt: asked.expiresAt });
    });

    it('accepts a link with white space around it', async () => {
        const did = await keymaster.createGrant(`  ${linkFor()}\n`);

        expect(await grantOf(did)).toStrictEqual({ v: 1, client, nonce: NONCE });
    });

    it('narrows the actions, in the order they were asked for', async () => {
        const link = linkFor({ actions: ['memeplex:tag', 'memeplex:post', EXTENSION] });

        expect(await grantOf(await keymaster.createGrant(link, { actions: [EXTENSION, 'memeplex:tag'] })))
            .toMatchObject({ actions: ['memeplex:tag', EXTENSION] });
        expect(await grantOf(await keymaster.createGrant(link, { actions: ['memeplex:post', 'memeplex:post'] })))
            .toMatchObject({ actions: ['memeplex:post'] });
        expect(await grantOf(await keymaster.createGrant(linkFor(), { actions: ['memeplex:rate', 'memeplex:reply'] })))
            .toMatchObject({ actions: ['memeplex:reply', 'memeplex:rate'] });
    });

    it('leaves actions out for exactly the core actions', async () => {
        const core = ['memeplex:tag', 'memeplex:rate', 'memeplex:reply', 'memeplex:post'];

        expect(await grantOf(await keymaster.createGrant(linkFor({ actions: core }))))
            .toStrictEqual({ v: 1, client, nonce: NONCE });
        expect(await grantOf(await keymaster.createGrant(linkFor(), { actions: core })))
            .toStrictEqual({ v: 1, client, nonce: NONCE });
        expect(await grantOf(await keymaster.createGrant(linkFor({ actions: [...core, EXTENSION] }))))
            .toMatchObject({ actions: [...core, EXTENSION] });
    });

    it.each([
        ['an action the link does not ask for', { actions: ['memeplex:tag'] }, ['memeplex:post'], 'every action must be one of memeplex:tag'],
        ['an extension kind when the link lists no actions', {}, [EXTENSION], 'every action must be one of memeplex:post, memeplex:reply, memeplex:rate, memeplex:tag'],
        ['no actions', {}, [], 'at least one action is needed'],
        ['actions that are not a list', {}, 'memeplex:post', 'at least one action is needed'],
        ['an action that is not a string', {}, [1], 'every action must be one of'],
    ])('refuses %s', async (_name, asked, actions, message) => {
        await expect(keymaster.createGrant(linkFor(asked), { actions: actions as never }))
            .rejects.toThrow(`Invalid parameter: options.actions: ${message}`);
        expect(await keymaster.listAssets()).toStrictEqual([]);
    });

    it('changes or removes the expiry', async () => {
        const link = linkFor({ expiresAt: '2027-01-01T00:00:00Z' });

        expect(await grantOf(await keymaster.createGrant(link, { expiresAt: '2027-06-30T12:00:00.000Z' })))
            .toStrictEqual({ v: 1, client, nonce: NONCE, expiresAt: '2027-06-30T12:00:00.000Z' });
        expect(await grantOf(await keymaster.createGrant(link, { expiresAt: null })))
            .toStrictEqual({ v: 1, client, nonce: NONCE });
        expect(await grantOf(await keymaster.createGrant(linkFor(), { expiresAt: '2027-06-30T12:00:00Z' })))
            .toMatchObject({ expiresAt: '2027-06-30T12:00:00Z' });
    });

    it.each([
        '2027-02-30T00:00:00Z', '2027-06-30', '2027-06-30T12:00:00+00:00', '2027-06-30T12:00:00Z\n', '', 1798675200,
    ])('refuses the expiry %j', async expiresAt => {
        await expect(keymaster.createGrant(linkFor(), { expiresAt: expiresAt as never }))
            .rejects.toThrow('Invalid parameter: options.expiresAt: not an instant such as 2027-01-31T00:00:00Z');
        expect(await keymaster.listAssets()).toStrictEqual([]);
    });

    it('creates the grant on the registry asked for', async () => {
        const did = await keymaster.createGrant(linkFor(), { registry: ETH });

        expect((await keymaster.resolveDID(did)).didDocumentRegistration?.registry).toBe(ETH);
    });

    it.each(['hyperswarm', 'local', 'BTC:signet', 'pin'])('refuses %s, where a grant would be void', async registry => {
        await expect(keymaster.createGrant(linkFor(), { registry })).rejects.toThrow(
            'Invalid parameter: options.registry: a grant may be created on BTC:mainnet, ZEC:mainnet, ETH:mainnet, SOL:mainnet-beta');
        expect(await keymaster.listAssets()).toStrictEqual([]);
    });

    it('refuses a permitted registry the node does not support', async () => {
        await expect(keymaster.createGrant(linkFor(), { registry: 'ZEC:mainnet' }))
            .rejects.toThrow('Invalid parameter: options.registry: this node does not support ZEC:mainnet');
    });

    it('refuses when the node supports no permitted registry', async () => {
        jest.spyOn(gatekeeper, 'listRegistries').mockResolvedValue(['local', 'hyperswarm', 'BTC:signet']);

        await expect(keymaster.createGrant(linkFor())).rejects.toThrow(
            'Invalid parameter: options.registry: this node supports none of BTC:mainnet, ZEC:mainnet, ETH:mainnet, SOL:mainnet-beta');
    });

    it('takes the next permitted registry when the node lacks the first', async () => {
        jest.spyOn(gatekeeper, 'listRegistries').mockResolvedValue(['hyperswarm', ETH]);

        const did = await keymaster.createGrant(linkFor());

        expect((await keymaster.resolveDID(did)).didDocumentRegistration?.registry).toBe(ETH);
    });

    it('creates the grant on a registry the request lists, and leaves the list out of the grant', async () => {
        const did = await keymaster.createGrant(linkFor({ registries: [ETH] }));

        expect((await keymaster.resolveDID(did)).didDocumentRegistration?.registry).toBe(ETH);
        expect(await grantOf(did)).toStrictEqual({ v: 1, client, nonce: NONCE });

        const first = await keymaster.createGrant(linkFor({ registries: [ETH, BTC] }));
        expect((await keymaster.resolveDID(first)).didDocumentRegistration?.registry).toBe(BTC);

        const named = await keymaster.createGrant(linkFor({ registries: [ETH, BTC] }), { registry: ETH });
        expect((await keymaster.resolveDID(named)).didDocumentRegistration?.registry).toBe(ETH);
    });

    it('refuses a registry the request does not list', async () => {
        await expect(keymaster.createGrant(linkFor({ registries: [ETH, 'SOL:mainnet-beta'] }), { registry: BTC }))
            .rejects.toThrow('Invalid parameter: options.registry: the request lists ETH:mainnet, SOL:mainnet-beta, not BTC:mainnet');
        await expect(keymaster.createGrant(linkFor({ registries: ['ZEC:mainnet'] }), { registry: 'ZEC:mainnet' }))
            .rejects.toThrow('Invalid parameter: options.registry: this node does not support ZEC:mainnet');
        await expect(keymaster.createGrant(linkFor({ registries: [ETH] }), { registry: 'hyperswarm' }))
            .rejects.toThrow('Invalid parameter: options.registry: a grant may be created on');
        expect(await keymaster.listAssets()).toStrictEqual([]);
    });

    it('refuses when the node supports none of the registries the request lists', async () => {
        await expect(keymaster.createGrant(linkFor({ registries: ['ZEC:mainnet', 'SOL:mainnet-beta'] }))).rejects.toThrow(
            'Invalid parameter: options.registry: the request lists ZEC:mainnet, SOL:mainnet-beta and this node supports local, hyperswarm, BTC:mainnet, ETH:mainnet');
        expect(await keymaster.listAssets()).toStrictEqual([]);
    });

    it('creates and signs the grant as the identity it checked, whatever the current ID becomes', async () => {
        const resolve = gatekeeper.resolveDID.bind(gatekeeper);
        let switched = false;

        // The current ID changes to the client while the grantor is being checked.
        jest.spyOn(gatekeeper, 'resolveDID').mockImplementation(async (did, options) => {
            if (did === alice && options?.confirm && !switched) {
                switched = true;
                await keymaster.setCurrentId('Memepool');
            }
            return resolve(did, options);
        });

        const did = await keymaster.createGrant(linkFor());

        expect(switched).toBe(true);
        expect(await keymaster.getCurrentId()).toBe('Memepool');
        expect((await keymaster.resolveDID(did)).didDocument?.controller).toBe(alice);
        expect(await keymaster.listAssets('Alice')).toStrictEqual([did]);
        expect(await keymaster.listAssets('Memepool')).toStrictEqual([]);
        expect(await verified(did)).toStrictEqual({ status: 'pending', user: alice, client, registry: BTC });
    });

    it('refuses a local identity, whose assets are created on local', async () => {
        await keymaster.createId('Larry', { registry: 'local' });

        await expect(keymaster.createGrant(linkFor()))
            .rejects.toThrow('Invalid parameter: options.controller: a local identity cannot make a grant');
        expect(await keymaster.listAssets()).toStrictEqual([]);
    });

    it('refuses a request that names the granting identity as the client', async () => {
        await expect(keymaster.createGrant(linkFor({ client: alice })))
            .rejects.toThrow('Invalid parameter: link: the request names the granting identity as the client');
        expect(await keymaster.listAssets()).toStrictEqual([]);
    });

    it('grants from the identity named as controller, under an alias', async () => {
        const bob = await keymaster.createId('Bob', { registry: 'hyperswarm' });
        await keymaster.setCurrentId('Alice');

        const did = await keymaster.createGrant(linkFor(), { controller: 'Bob', alias: 'memepool-grant' });

        expect((await keymaster.resolveDID('memepool-grant')).didDocument).toMatchObject({ id: did, controller: bob });
        expect(await keymaster.listAssets()).toStrictEqual([]);
        expect(await keymaster.listAssets('Bob')).toStrictEqual([did]);
        await expect(keymaster.createGrant(linkFor(), { controller: 'Memepool' }))
            .rejects.toThrow('the request names the granting identity as the client');
    });

    it('says why it refuses a link', async () => {
        await expect(keymaster.createGrant('archon://auth?challenge=did:cid:abc'))
            .rejects.toThrow('Invalid parameter: link: not-a-grant-link');
        await expect(keymaster.createGrant(`${grants.GRANT_LINK_PREFIX}not base64!`))
            .rejects.toThrow('Invalid parameter: link: undecodable');
        await expect(keymaster.createGrant(linkFor() + 'A'.repeat(2048)))
            .rejects.toThrow('Invalid parameter: link: too-long');
        await expect(keymaster.createGrant(`${grants.GRANT_LINK_PREFIX}${Buffer.from('{"memeplexGrantRequest":{"v":2}}').toString('base64url')}`))
            .rejects.toThrow('Invalid parameter: link: invalid-request (unsupported)');
        await expect(keymaster.createGrant(undefined as never))
            .rejects.toThrow('Invalid parameter: link: not-a-grant-link');
        expect(await keymaster.listAssets()).toStrictEqual([]);
    });

    // A link is read without the white space around it, so a vector refused
    // only for that white space is accepted.
    it.each(linkCases.map(each => [each.name, each] as const))('reads a link with %s as its vector states', async (_name, each) => {
        const decoded = grants.decodeGrantLink(each.link.trim()) as { error?: string; validity?: string };

        if (each.link.trim() === each.link) {
            expect(decoded).toStrictEqual(each.expect);
        }

        if (decoded.error) {
            const validity = decoded.validity ? ` (${decoded.validity})` : '';

            await expect(keymaster.createGrant(each.link))
                .rejects.toThrow(`Invalid parameter: link: ${decoded.error}${validity}`);
            expect(await keymaster.listAssets()).toStrictEqual([]);
        }
        else {
            const did = await keymaster.createGrant(each.link);

            expect(memeplex.validateGrant(await grantOf(did))).toBe('valid');
        }
    });
});

describe('listGrants', () => {
    it('is empty for an identity with no grants', async () => {
        await keymaster.createAsset({ name: 'not a grant' }, { registry: BTC });
        await keymaster.createAsset({ memeplexGrant: { v: 1, client: 'memepool' } }, { registry: BTC });
        await keymaster.createAsset({ memeplexGrant: { v: 2, client } }, { registry: BTC });
        await keymaster.createAsset(['memeplexGrant'], { registry: BTC });

        expect(await keymaster.listGrants()).toStrictEqual([]);
    });

    it('lists a grant as pending until it is anchored on its registry', async () => {
        const did = await keymaster.createGrant(linkFor({ actions: ['memeplex:tag'], expiresAt: '2028-01-01T00:00:00Z' }));
        const grant = { v: 1, client, actions: ['memeplex:tag'], nonce: NONCE, expiresAt: '2028-01-01T00:00:00Z' };

        expect(await keymaster.listGrants()).toStrictEqual([{ did, status: 'pending', grant, registry: BTC, created: true }]);

        await anchor(100);
        expect(await keymaster.listGrants()).toStrictEqual([{ did, status: 'anchored', grant, registry: BTC, created: true }]);
    });

    it('lists a change as pending until it is anchored, and as not the creation', async () => {
        const did = await keymaster.createGrant(linkFor());
        await anchor(100);

        expect(await keymaster.updateGrant(did, { actions: ['memeplex:tag'] })).toBe(true);
        const grant = { v: 1, client, nonce: NONCE, actions: ['memeplex:tag'] };

        expect(await keymaster.listGrants()).toStrictEqual([{ did, status: 'pending', grant, registry: BTC, created: false }]);
        await anchor(200);
        expect(await keymaster.listGrants()).toStrictEqual([{ did, status: 'anchored', grant, registry: BTC, created: false }]);
    });

    it('does not take an anchor on another chain, or confirmation, for an anchor', async () => {
        const did = await keymaster.createGrant(linkFor());
        const resolved = await gatekeeper.resolveDID(did);
        const resolve = jest.spyOn(gatekeeper, 'resolveDID');
        const withTimestamp = (timestamp: unknown) => resolve.mockResolvedValue({
            ...resolved,
            didDocumentMetadata: { ...resolved.didDocumentMetadata, confirmed: true, timestamp },
        } as never);
        const statusWith = async (timestamp: unknown) => {
            withTimestamp(timestamp);
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

    it('lists a grant on a registry where it is void, which is never anchored', async () => {
        const grant = { v: 1, client, nonce: NONCE };
        const did = await keymaster.createAsset({ memeplexGrant: grant }, { registry: 'hyperswarm' });

        expect(await keymaster.listGrants()).toStrictEqual([{ did, status: 'pending', grant, registry: 'hyperswarm', created: true }]);
    });

    it('lists the grants of the identity asked for', async () => {
        const did = await keymaster.createGrant(linkFor());
        await keymaster.createId('Bob', { registry: 'hyperswarm' });

        expect(await keymaster.listGrants()).toStrictEqual([]);
        expect((await keymaster.listGrants('Alice')).map(each => each.did)).toStrictEqual([did]);
        expect((await keymaster.listGrants(alice)).map(each => each.did)).toStrictEqual([did]);
        await expect(keymaster.listGrants('Nobody')).rejects.toThrow('Unknown ID');
    });

    it('lists an asset the node cannot resolve as unresolved', async () => {
        const first = await keymaster.createGrant(linkFor());
        const asset = await keymaster.createAsset({ name: 'not a grant' }, { registry: BTC });
        const second = await keymaster.createGrant(linkFor({ actions: ['memeplex:tag'] }));
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
    });

    it('does not list a revoked grant, which listRevocations has', async () => {
        const kept = await keymaster.createGrant(linkFor());
        const revoked = await keymaster.createGrant(linkFor({ actions: ['memeplex:tag'] }));

        expect(await keymaster.revokeGrant(revoked)).toBe(true);
        expect((await keymaster.listGrants()).map(each => each.did)).toStrictEqual([kept]);
        expect(await keymaster.listRevocations()).toStrictEqual([{ did: revoked, registry: BTC, status: 'pending' }]);
    });
});

describe('updateGrant', () => {
    it('changes the actions and keeps every other field', async () => {
        const scope = { v: 1, client, nonce: NONCE, label: 'phone', expiresAt: '2028-01-01T00:00:00Z' };
        const did = await keymaster.createAsset({ memeplexGrant: scope, note: 'kept' }, { registry: BTC });

        expect(await keymaster.updateGrant(did, { actions: ['memeplex:tag', 'memeplex:post'] })).toBe(true);
        expect((await keymaster.resolveDID(did)).didDocumentData)
            .toStrictEqual({ memeplexGrant: { ...scope, actions: ['memeplex:post', 'memeplex:tag'] }, note: 'kept' });
    });

    it('keeps a member of the data whose value is null, so the verifier reads a scope update', async () => {
        const scope = { v: 1, client, nonce: NONCE };
        const did = await keymaster.createAsset({ memeplexGrant: scope, note: null, kept: { deep: null } }, { registry: BTC });
        await anchor(100);

        expect(await keymaster.updateGrant(did, { actions: ['memeplex:tag'] })).toBe(true);
        expect((await keymaster.resolveDID(did)).didDocumentData)
            .toStrictEqual({ memeplexGrant: { ...scope, actions: ['memeplex:tag'] }, note: null, kept: { deep: null } });
        await anchor(200);

        const read = await verified(did);

        expect(read).toMatchObject({ status: 'valid', pending: 0 });
        expect(read.status === 'valid' && read.ended).toBeUndefined();
        expect(read.status === 'valid' && read.versions.map(version => version.actions)).toStrictEqual([undefined, ['memeplex:tag']]);
    });

    it('is read by the verifier as a scope update that does not end the grant', async () => {
        const did = await keymaster.createGrant(linkFor({ actions: ['memeplex:post', 'memeplex:tag'] }));
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

    it('widens to every core kind, by null or by naming the core actions', async () => {
        const did = await keymaster.createGrant(linkFor({ actions: ['memeplex:tag'] }));

        expect(await keymaster.updateGrant(did, { actions: null })).toBe(true);
        expect(await grantOf(did)).toStrictEqual({ v: 1, client, nonce: NONCE });

        expect(await keymaster.updateGrant(did, { actions: ['memeplex:rate'] })).toBe(true);
        expect(await keymaster.updateGrant(did, { actions: ['memeplex:tag', 'memeplex:rate', 'memeplex:reply', 'memeplex:post'] })).toBe(true);
        expect(await grantOf(did)).toStrictEqual({ v: 1, client, nonce: NONCE });
    });

    it('offers the extension kinds the grant lists, and no others', async () => {
        const did = await keymaster.createGrant(linkFor({ actions: ['memeplex:tag', EXTENSION] }));

        expect(await keymaster.updateGrant(did, { actions: [EXTENSION, 'memeplex:reply', 'memeplex:post', 'memeplex:rate', 'memeplex:tag'] })).toBe(true);
        expect((await grantOf(did)).actions)
            .toStrictEqual(['memeplex:post', 'memeplex:reply', 'memeplex:rate', 'memeplex:tag', EXTENSION]);
        await expect(keymaster.updateGrant(did, { actions: [OTHER_EXTENSION] })).rejects.toThrow(
            `Invalid parameter: changes.actions: every action must be one of memeplex:post, memeplex:reply, memeplex:rate, memeplex:tag, ${EXTENSION}`);

        expect(await keymaster.updateGrant(did, { actions: ['memeplex:post'] })).toBe(true);
        await expect(keymaster.updateGrant(did, { actions: [EXTENSION] })).rejects.toThrow('every action must be one of');
        expect((await grantOf(did)).actions).toStrictEqual(['memeplex:post']);
    });

    it('sets, changes and removes the expiry, leaving the actions', async () => {
        const did = await keymaster.createGrant(linkFor({ actions: ['memeplex:tag'] }));

        expect(await keymaster.updateGrant(did, { expiresAt: '2028-01-01T00:00:00Z' })).toBe(true);
        expect(await grantOf(did)).toStrictEqual({ v: 1, client, actions: ['memeplex:tag'], nonce: NONCE, expiresAt: '2028-01-01T00:00:00Z' });
        expect(await keymaster.updateGrant(did, { expiresAt: '2029-01-01T00:00:00.000Z' })).toBe(true);
        expect((await grantOf(did)).expiresAt).toBe('2029-01-01T00:00:00.000Z');
        expect(await keymaster.updateGrant(did, { expiresAt: null })).toBe(true);
        expect(await grantOf(did)).toStrictEqual({ v: 1, client, actions: ['memeplex:tag'], nonce: NONCE });
    });

    it('writes nothing when the change leaves the grant as it is', async () => {
        const did = await keymaster.createGrant(linkFor({ actions: ['memeplex:tag'], expiresAt: '2028-01-01T00:00:00Z' }));
        const before = await sequenceOf(did);

        expect(await keymaster.updateGrant(did, { actions: ['memeplex:tag'], expiresAt: '2028-01-01T00:00:00Z' })).toBe(true);
        expect(await keymaster.updateGrant(did, { actions: ['memeplex:tag'] })).toBe(true);
        expect(await sequenceOf(did)).toBe(before);

        expect(await keymaster.updateGrant(did, { actions: ['memeplex:post'] })).toBe(true);
        expect(await sequenceOf(did)).not.toBe(before);
    });

    it.each([
        ['no change', {}, 'changes: actions or expiresAt is needed'],
        ['changes that are not an object', 'actions', 'changes: actions or expiresAt is needed'],
        ['no changes at all', undefined, 'changes: actions or expiresAt is needed'],
        ['no actions', { actions: [] }, 'changes.actions: at least one action is needed'],
        ['an unknown action', { actions: ['memeplex:delete'] }, 'changes.actions: every action must be one of'],
        ['an expiry that is not an instant', { expiresAt: '2027-02-30T00:00:00Z' }, 'changes.expiresAt: not an instant such as 2027-01-31T00:00:00Z'],
        ['a valid action with an invalid expiry', { actions: ['memeplex:post'], expiresAt: 'tomorrow' }, 'changes.expiresAt: not an instant'],
    ])('refuses %s', async (_name, changes, message) => {
        const did = await keymaster.createGrant(linkFor({ actions: ['memeplex:tag'] }));
        const before = await sequenceOf(did);

        await expect(keymaster.updateGrant(did, changes as never)).rejects.toThrow(`Invalid parameter: ${message}`);
        expect(await sequenceOf(did)).toBe(before);
    });

    it('finds a grant by its alias', async () => {
        await keymaster.createGrant(linkFor(), { alias: 'memepool-grant' });

        expect(await keymaster.updateGrant('memepool-grant', { actions: ['memeplex:tag'] })).toBe(true);
        expect((await grantOf('memepool-grant')).actions).toStrictEqual(['memeplex:tag']);
    });

    it('refuses what is not a live, valid grant of the current ID', async () => {
        const asset = await keymaster.createAsset({ name: 'not a grant' }, { registry: BTC });
        const invalid = await keymaster.createAsset({ memeplexGrant: { v: 1, client, nonce: 'short' } }, { registry: BTC });
        const revoked = await keymaster.createGrant(linkFor());
        const grant = await keymaster.createGrant(linkFor({ actions: ['memeplex:tag'] }));
        const changes = { actions: ['memeplex:post'] };

        expect(await keymaster.revokeGrant(revoked)).toBe(true);

        for (const did of [asset, invalid, revoked, alice]) {
            await expect(keymaster.updateGrant(did, changes)).rejects.toThrow('Invalid parameter: id: not a grant');
            await expect(keymaster.revokeGrant(did)).rejects.toThrow('Invalid parameter: id: not a grant');
        }

        await keymaster.createId('Bob', { registry: 'hyperswarm' });
        await expect(keymaster.updateGrant(grant, changes)).rejects.toThrow('Invalid parameter: id: not a grant of the current ID');
        await expect(keymaster.revokeGrant(grant)).rejects.toThrow('Invalid parameter: id: not a grant of the current ID');

        await keymaster.setCurrentId('Alice');
        expect((await grantOf(grant)).actions).toStrictEqual(['memeplex:tag']);
        expect((await keymaster.resolveDID(asset)).didDocumentMetadata?.deactivated).toBeFalsy();
        expect((await keymaster.resolveDID(alice)).didDocumentMetadata?.deactivated).toBeFalsy();
    });
});

describe('revokeGrant', () => {
    it('deletes the grant, which the verifier reads as its end once anchored', async () => {
        const did = await keymaster.createGrant(linkFor());
        await anchor(100);

        expect(await keymaster.revokeGrant(did)).toBe(true);
        expect((await keymaster.resolveDID(did)).didDocumentMetadata?.deactivated).toBe(true);
        expect(await keymaster.listGrants()).toStrictEqual([]);
        expect(await keymaster.listRevocations()).toStrictEqual([{ did, registry: BTC, status: 'pending' }]);
        expect(await verified(did)).toMatchObject({ status: 'valid', pending: 1 });

        await anchor(200);
        expect(await verified(did)).toMatchObject({ status: 'valid', ended: { block: 200 }, pending: 0 });
        expect(await keymaster.listRevocations()).toStrictEqual([]);
    });

    it('revokes a grant by its alias', async () => {
        const did = await keymaster.createGrant(linkFor(), { alias: 'memepool-grant' });

        expect(await keymaster.revokeGrant('memepool-grant')).toBe(true);
        expect((await keymaster.resolveDID(did)).didDocumentMetadata?.deactivated).toBe(true);
    });
});
