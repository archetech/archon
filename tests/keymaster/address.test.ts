import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import HeliaClient from '@didcid/ipfs/helia';
import { jest } from '@jest/globals';

let ipfs: HeliaClient;
let gatekeeper: Gatekeeper;
let wallet: WalletJsonMemory;
let cipher: CipherNode;
let keymaster: Keymaster;

beforeAll(async () => {
    ipfs = new HeliaClient();
    await ipfs.start();
});

afterAll(async () => {
    if (ipfs) {
        await ipfs.stop();
    }
});

beforeEach(() => {
    const db = new DbJsonMemory('test');
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm', 'BTC:signet'] });
    wallet = new WalletJsonMemory();
    cipher = new CipherNode();
    keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase: 'passphrase' });
});

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
});

function mockFetchResponse(
    ok: boolean,
    body: unknown,
    status = ok ? 200 : 500,
    contentType = 'application/json; charset=utf-8',
): Response {
    return {
        ok,
        status,
        headers: {
            get: (name: string) => name.toLowerCase() === 'content-type' ? contentType : null,
        },
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as Response;
}

describe('listAddresses', () => {
    it('should return an empty list by default', async () => {
        const addresses = await keymaster.listAddresses();

        expect(addresses).toStrictEqual({});
    });
});

describe('importAddress', () => {
    it('should import matching addresses for the current DID from a domain registry', async () => {
        const alice = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        await keymaster.setCurrentId('Alice');
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-04-04T12:00:00.000Z'));

        jest.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(true, {
                names: {
                    alice: alice,
                    bob: 'did:cid:bob',
                },
            }),
        );

        const imported = await keymaster.importAddress('archon.social');
        const addresses = await keymaster.listAddresses();
        const walletData = await keymaster.loadWallet();
        const info = { added: '2026-04-04T12:00:00.000Z' };

        expect(imported).toStrictEqual({ 'alice@archon.social': info });
        expect(addresses).toStrictEqual({ 'alice@archon.social': info });
        expect(walletData.ids.Alice.addresses).toStrictEqual({ 'alice@archon.social': info });
        expect(globalThis.fetch).toHaveBeenCalledWith('https://archon.social/.well-known/names');
    });
});

describe('checkAddress', () => {
    it('should report when an address is available', async () => {
        jest.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(false, { error: 'Name not found' }, 404),
        );

        const result = await keymaster.checkAddress('alice@archon.social');

        expect(result).toStrictEqual({
            address: 'alice@archon.social',
            status: 'available',
            available: true,
            did: null,
        });
    });

    it('should report when an address is already claimed', async () => {
        jest.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(true, { name: 'alice', did: 'did:cid:alice' }),
        );

        const result = await keymaster.checkAddress('alice@archon.social');

        expect(result).toStrictEqual({
            address: 'alice@archon.social',
            status: 'claimed',
            available: false,
            did: 'did:cid:alice',
        });
        expect(globalThis.fetch).toHaveBeenCalledWith('https://archon.social/.well-known/names/alice');
    });

    it('should report when a domain does not appear to support names', async () => {
        jest.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockFetchResponse(false, '<html>404</html>', 404, 'text/html; charset=utf-8'),
        );

        const result = await keymaster.checkAddress('alice@google.com');

        expect(result).toStrictEqual({
            address: 'alice@google.com',
            status: 'unsupported',
            available: false,
            did: null,
        });
    });

    it('should report when a domain is unreachable', async () => {
        jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

        const result = await keymaster.checkAddress('alice@lucifer.com');

        expect(result).toStrictEqual({
            address: 'alice@lucifer.com',
            status: 'unreachable',
            available: false,
            did: null,
        });
    });
});

describe('addAddress', () => {
    it('should claim an address through Herald and save it in the wallet', async () => {
        await keymaster.createId('Alice');
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-04-04T13:00:00.000Z'));

        jest.spyOn(keymaster, 'createResponse').mockResolvedValue('did:cid:response');
        jest.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(mockFetchResponse(true, { challenge: 'did:cid:challenge' }))
            .mockResolvedValueOnce(mockFetchResponse(true, { ok: true, name: 'alice' }));

        const ok = await keymaster.addAddress('alice@archon.social');
        const addresses = await keymaster.listAddresses();
        const walletData = await keymaster.loadWallet();
        const info = { added: '2026-04-04T13:00:00.000Z' };

        expect(ok).toBe(true);
        expect(addresses).toStrictEqual({ 'alice@archon.social': info });
        expect(walletData.ids.Alice.addresses).toStrictEqual({ 'alice@archon.social': info });
        expect(keymaster.createResponse).toHaveBeenCalledWith('did:cid:challenge');
        expect(globalThis.fetch).toHaveBeenNthCalledWith(1, 'https://archon.social/names/api/challenge');
        expect(globalThis.fetch).toHaveBeenNthCalledWith(
            2,
            'https://archon.social/names/api/name',
            expect.objectContaining({
                method: 'PUT',
                headers: expect.objectContaining({
                    Authorization: 'Bearer did:cid:response',
                    'Content-Type': 'application/json',
                }),
                body: JSON.stringify({ name: 'alice' }),
            }),
        );
    });
});

describe('removeAddress', () => {
    it('should delete an address through Herald and remove it from the wallet', async () => {
        await keymaster.createId('Alice');
        const walletData = await keymaster.loadWallet();
        walletData.ids.Alice.addresses = { 'alice@archon.social': { added: '2026-04-04T13:00:00.000Z' } };
        await keymaster.saveWallet(walletData, true);

        jest.spyOn(keymaster, 'createResponse').mockResolvedValue('did:cid:response');
        jest.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(mockFetchResponse(true, { challenge: 'did:cid:challenge' }))
            .mockResolvedValueOnce(mockFetchResponse(true, { ok: true }));

        const ok = await keymaster.removeAddress('alice@archon.social');
        const addresses = await keymaster.listAddresses();
        const updatedWallet = await keymaster.loadWallet();

        expect(ok).toBe(true);
        expect(addresses).toStrictEqual({});
        expect(updatedWallet.ids.Alice.addresses).toStrictEqual({});
        expect(globalThis.fetch).toHaveBeenNthCalledWith(1, 'https://archon.social/names/api/challenge');
        expect(globalThis.fetch).toHaveBeenNthCalledWith(
            2,
            'https://archon.social/names/api/name',
            expect.objectContaining({
                method: 'DELETE',
                headers: expect.objectContaining({
                    Authorization: 'Bearer did:cid:response',
                }),
            }),
        );
    });

});
