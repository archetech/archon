import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { jest } from '@jest/globals';

let ipfs: MemoryClient;
let gatekeeper: Gatekeeper;
let keymaster: Keymaster;

beforeAll(async () => {
    ipfs = new MemoryClient();
    await ipfs.start();
});

afterAll(async () => {
    if (ipfs) {
        await ipfs.stop();
    }
});

beforeEach(async () => {
    const db = new DbJsonMemory('test');
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm'] });
    keymaster = new Keymaster({
        gatekeeper,
        wallet: new WalletJsonMemory(),
        cipher: new CipherNode(),
        passphrase: 'passphrase',
    });
    await keymaster.loadOrCreateWallet();
});

afterEach(() => {
    jest.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

// Answers each request by the path it asks for, so a test does not depend on
// the order in which the wallet tries endpoints.
function serve(routes: Record<string, () => Response>) {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const path = new URL(String(input)).pathname;
        const route = routes[path];
        return route ? route() : jsonResponse({ error: 'Not found' }, 404);
    });
}

// Neither is a DID with a CID in it: one stops at the method, the other has
// an empty method-specific id.
const notDids = ['did:cid', 'did:cid:'];

describe('remote names', () => {
    it('does not look up a name on a private host', async () => {
        const fetcher = jest.spyOn(globalThis, 'fetch');

        await expect(keymaster.resolveDID('alice@localhost')).rejects.toThrow('Unknown ID');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('does not look up a name that carries a path', async () => {
        const fetcher = jest.spyOn(globalThis, 'fetch');

        await expect(keymaster.lookupDID('alice/../admin@example.com')).rejects.toThrow('Unknown ID');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('does not look up a name whose domain is not a host name', async () => {
        const fetcher = jest.spyOn(globalThis, 'fetch');

        await expect(keymaster.lookupDID('alice@exa mple.com')).rejects.toThrow('Unknown ID');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('treats a domain it cannot reach as not knowing the name', async () => {
        jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

        await expect(keymaster.lookupDID('alice@example.com')).rejects.toThrow('Unknown ID');
    });

    it('resolves a name the domain answers with a DID', async () => {
        const alice = await keymaster.createId('Alice');
        await keymaster.removeId('Alice');
        serve({ '/.well-known/names/alice': () => jsonResponse({ did: alice }) });

        expect(await keymaster.lookupDID('alice@example.com')).toBe(alice);
    });

    it.each(notDids)('ignores a domain that answers with %j', async (did) => {
        serve({ '/.well-known/names/alice': () => jsonResponse({ did }) });

        await expect(keymaster.lookupDID('alice@example.com')).rejects.toThrow('Unknown ID');
    });
});

describe('verifyDIDList', () => {
    it.each(notDids)('refuses %j', async (did) => {
        await expect(keymaster.verifyDIDList([did])).rejects.toThrow(`Invalid DID: ${did}`);
    });
});

describe('importAddress', () => {
    it('stores the relay agent the domain advertises with each imported address', async () => {
        const relay = await keymaster.createId('Herald');
        const alice = await keymaster.createId('Alice');
        serve({
            '/.well-known/names': () => jsonResponse({ names: { Alice: alice, herald: relay } }),
            '/names/api/config': () => jsonResponse({ relayAgent: relay }),
        });

        const imported = await keymaster.importAddress('example.com');

        expect(Object.keys(imported)).toEqual(['alice@example.com']);
        expect(imported['alice@example.com'].relay).toBe(relay);
        expect((await keymaster.getAddress('example.com'))).toMatchObject({
            name: 'alice',
            address: 'alice@example.com',
            relay,
        });
    });

    it.each(notDids)('stores no relay when the domain advertises %j', async (did) => {
        const alice = await keymaster.createId('Alice');
        serve({
            '/.well-known/names': () => jsonResponse({ names: { alice } }),
            '/names/api/config': () => jsonResponse({ relayAgent: did }),
        });

        const imported = await keymaster.importAddress('example.com');

        expect(imported['alice@example.com']).not.toHaveProperty('relay');
    });

    it('imports nothing from a domain whose list has no names', async () => {
        await keymaster.createId('Alice');
        serve({ '/.well-known/names': () => jsonResponse({ unexpected: true }) });

        expect(await keymaster.importAddress('example.com')).toStrictEqual({});
        expect(await keymaster.listAddresses()).toStrictEqual({});
    });
});

describe('unpublishAddress', () => {
    it('removes an address published without a relay and adds no service', async () => {
        const alice = await keymaster.createId('Alice');
        serve({ '/.well-known/names': () => jsonResponse({ names: { alice } }) });
        await keymaster.importAddress('example.com');
        await keymaster.publishAddress('alice@example.com');
        expect((await keymaster.resolveDID(alice)).didDocumentData).toMatchObject({ address: 'alice@example.com' });

        expect(await keymaster.unpublishAddress()).toBe(true);

        const doc = await keymaster.resolveDID(alice);
        expect(doc.didDocumentData).not.toHaveProperty('address');
        expect(doc.didDocument).not.toHaveProperty('service');
    });
});

describe('getAddress', () => {
    it('refuses a domain given as an address with no host', async () => {
        await keymaster.createId('Alice');

        await expect(keymaster.getAddress('archon://')).rejects.toThrow('Invalid parameter: domain');
    });
});

describe('checkAddress', () => {
    it('reports a 404 without a JSON body as unsupported', async () => {
        jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

        expect(await keymaster.checkAddress('alice@example.com')).toStrictEqual({
            address: 'alice@example.com',
            status: 'unsupported',
            available: false,
            did: null,
        });
    });
});
