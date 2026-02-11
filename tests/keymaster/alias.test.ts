import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import { ExpectedExceptionError } from '@didcid/common/errors';
import HeliaClient from '@didcid/ipfs/helia';

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

describe('addAlias', () => {
    it('should create a new alias', async () => {
        const bob = await keymaster.createId('Bob');
        const ok = await keymaster.addAlias('Jack', bob);
        const wallet = await keymaster.loadWallet();

        expect(ok).toBe(true);
        expect(wallet.aliases!['Jack'] === bob).toBe(true);
    });

    it('should create a Unicode alias', async () => {
        const name = 'ҽ\u00d7 ʍɑϲհ\u00edղɑ';

        const bob = await keymaster.createId('Bob');
        const ok = await keymaster.addAlias(name, bob);
        const wallet = await keymaster.loadWallet();

        expect(ok).toBe(true);
        expect(wallet.aliases![name] === bob).toBe(true);
    });

    it('should not add duplicate alias', async () => {
        const alice = await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');

        try {
            await keymaster.addAlias('Jack', alice);
            await keymaster.addAlias('Jack', bob);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: alias already used');
        }
    });

    it('should not add an alias that is same as an ID', async () => {
        const alice = await keymaster.createId('Alice');

        try {
            await keymaster.addAlias('Alice', alice);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: alias already used');
        }
    });

    it('should not add an empty alias', async () => {
        const alice = await keymaster.createId('Alice');
        const expectedError = 'Invalid parameter: alias must be a non-empty string';

        try {
            await keymaster.addAlias('', alice);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe(expectedError);
        }

        try {
            await keymaster.addAlias('    ', alice);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe(expectedError);
        }

        try {
            // @ts-expect-error Testing invalid usage, invalid alias arg
            await keymaster.addAlias(undefined, alice);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe(expectedError);
        }

        try {
            // @ts-expect-error Testing invalid usage, invalid alias arg
            await keymaster.addAlias(0, alice);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe(expectedError);
        }

        try {
            // @ts-expect-error Testing invalid usage, invalid alias arg
            await keymaster.addAlias({}, alice);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe(expectedError);
        }
    });

    it('should not add an alias that is too long', async () => {
        const alice = await keymaster.createId('Alice');

        try {
            await keymaster.addAlias('1234567890123456789012345678901234567890', alice);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: alias too long');
        }
    });

    it('should not add an alias that contains unprintable characters', async () => {
        const alice = await keymaster.createId('Alice');

        try {
            await keymaster.addAlias('hello\nworld!', alice);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: alias contains unprintable characters');
        }
    });
});

describe('getAlias', () => {
    it('should return DID for a new alias', async () => {
        const bob = await keymaster.createId('Bob');
        const ok = await keymaster.addAlias('Jack', bob);
        const did = await keymaster.getAlias('Jack');

        expect(ok).toBe(true);
        expect(did).toBe(bob);
    });

    it('should return null for unknown alias', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.getAlias('Jack');

        expect(did).toBe(null);
    });

    it('should return null for non-string aliases', async () => {
        await keymaster.createId('Bob');

        // @ts-expect-error Testing invalid usage, missing arg
        let did = await keymaster.getAlias();
        expect(did).toBe(null);

        // @ts-expect-error Testing invalid usage, invalid alias arg
        did = await keymaster.getAlias(333);
        expect(did).toBe(null);

        // @ts-expect-error Testing invalid usage, invalid alias arg
        did = await keymaster.getAlias([1, 2, 3]);
        expect(did).toBe(null);

        // @ts-expect-error Testing invalid usage, invalid alias arg
        did = await keymaster.getAlias({ id: 'mock' });
        expect(did).toBe(null);
    });
});

describe('removeAlias', () => {
    it('should remove a valid alias', async () => {
        const bob = await keymaster.createId('Bob');

        await keymaster.addAlias('Jack', bob);
        await keymaster.removeAlias('Jack');

        const wallet = await keymaster.loadWallet();

        expect(wallet.aliases!['Jack'] === bob).toBe(false);
    });

    it('should return true if alias is missing', async () => {
        const ok = await keymaster.removeAlias('Jack');

        expect(ok).toBe(true);
    });
});

describe('listAliases', () => {
    it('should return current list of wallet aliases', async () => {
        const bob = await keymaster.createId('Bob');

        for (let i = 0; i < 10; i++) {
            await keymaster.addAlias(`name-${i}`, bob);
        }

        const names = await keymaster.listAliases();

        expect(Object.keys(names).length).toBe(10);

        for (const name of Object.keys(names)) {
            expect(names[name]).toBe(bob);
        }
    });

    it('should include IDs when requested', async () => {
        const bob = await keymaster.createId('Bob');
        const alice = await keymaster.createId('Alice');

        for (let i = 0; i < 10; i++) {
            await keymaster.addAlias(`name-${i}`, bob);
        }

        const names = await keymaster.listAliases({ includeIDs: true });

        expect(Object.keys(names).length).toBe(12);
        expect(names['Bob']).toBe(bob);
        expect(names['Alice']).toBe(alice);
    });

    it('should return empty list if no aliases added', async () => {
        const names = await keymaster.listAliases();

        expect(Object.keys(names).length).toBe(0);
    });

    it('should not mutate wallet.aliases when includeIDs is true', async () => {
        const bob = await keymaster.createId('Bob');
        const alice = await keymaster.createId('Alice');

        await keymaster.addAlias('asset-1', bob);
        await keymaster.addAlias('asset-2', bob);

        // Call listAliases with includeIDs: true
        const namesWithIds = await keymaster.listAliases({ includeIDs: true });

        // Should include both aliases and IDs
        expect(Object.keys(namesWithIds).length).toBe(4);
        expect(namesWithIds['Bob']).toBe(bob);
        expect(namesWithIds['Alice']).toBe(alice);

        // But wallet.aliases should NOT be mutated
        const walletData = await keymaster.loadWallet();
        expect(Object.keys(walletData.aliases!).length).toBe(2);
        expect(walletData.aliases!['Bob']).toBeUndefined();
        expect(walletData.aliases!['Alice']).toBeUndefined();
        expect(walletData.aliases!['asset-1']).toBe(bob);
        expect(walletData.aliases!['asset-2']).toBe(bob);
    });
});
