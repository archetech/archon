import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import { ExpectedExceptionError } from '@didcid/common/errors';
import MemoryClient from '@didcid/ipfs/memory';

let ipfs: MemoryClient;
let gatekeeper: Gatekeeper;
let wallet: WalletJsonMemory;
let cipher: CipherNode;
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
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm', 'BTC:signet'] });
    wallet = new WalletJsonMemory();
    cipher = new CipherNode();
    keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase: 'passphrase' });
    await keymaster.loadOrCreateWallet();
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

// A name is given in the path of a request, where it is one segment (#1758).
// The Python Keymaster runs the same names.
describe('what a new name may be', () => {
    const names = JSON.parse(readFileSync(new URL('../fixtures/keymaster-names.json', import.meta.url), 'utf8')) as {
        accepted: string[]; refused: { name: string; error: string }[];
        items: { accepted: string[]; refused: { name: string; error: string }[] };
    };

    it.each(names.accepted)('accepts %j as an alias, an identity\'s name and a vault item\'s', async name => {
        const alice = await keymaster.createId('First');

        expect(await keymaster.addAlias(name, alice)).toBe(true);
        expect(await keymaster.removeAlias(name)).toBe(true);
        expect(await keymaster.renameId('First', name)).toBe(true);
        expect(await keymaster.addVaultItem(await keymaster.createVault(), name, Buffer.from('x'))).toBe(true);
    });

    it.each(names.refused)('refuses $name wherever a name is made', async ({ name, error }) => {
        const alice = await keymaster.createId('First');

        await expect(keymaster.addAlias(name, alice)).rejects.toThrow(`Invalid parameter: alias ${error}`);
        await expect(keymaster.createId(name)).rejects.toThrow(`Invalid parameter: name ${error}`);
        await expect(keymaster.renameId('First', name)).rejects.toThrow(`Invalid parameter: name ${error}`);
        await expect(keymaster.createAsset({ a: 1 }, { alias: name })).rejects.toThrow(`Invalid parameter: alias ${error}`);
    });

    // A vault's item is the last thing in the path of a request for it, and a
    // wallet names a login for the address of its service.
    it.each(names.items.accepted)('accepts %j as a vault item\'s name, and gives the item back by it', async name => {
        await keymaster.createId('First');
        const vault = await keymaster.createVault();

        expect(await keymaster.addVaultItem(vault, name, Buffer.from('x'))).toBe(true);
        expect((await keymaster.getVaultItem(vault, name))!.toString()).toBe('x');
        expect(await keymaster.removeVaultItem(vault, name)).toBe(true);
    });

    it.each(names.items.refused)('refuses $name as a vault item\'s name', async ({ name, error }) => {
        await keymaster.createId('First');

        await expect(keymaster.addVaultItem(await keymaster.createVault(), name, Buffer.from('x'))).rejects.toThrow(`Invalid parameter: name ${error}`);
    });

    it('still finds, renames and removes a name a wallet already has with a slash in it', async () => {
        const alice = await keymaster.createId('Alice');
        const wallet = await keymaster.loadWallet();

        wallet.aliases = { ...wallet.aliases, 'team/alice': alice };
        wallet.ids['old/name'] = { ...wallet.ids.Alice };
        await keymaster.saveWallet(wallet, true);

        expect(await keymaster.getAlias('team/alice')).toBe(alice);
        expect((await keymaster.resolveDID('team/alice')).didDocument!.id).toBe(alice);
        expect(await keymaster.removeAlias('team/alice')).toBe(true);
        expect(await keymaster.renameId('old/name', 'new-name')).toBe(true);
        expect(Object.keys((await keymaster.loadWallet()).ids)).toContain('new-name');
    });

    it('leaves a tag as it was, which is in no path', async () => {
        await keymaster.createId('Alice');
        const dmail = await keymaster.createDmail({ to: [await keymaster.createId('Bob')], cc: [], subject: 's', body: 'b' });

        expect(await keymaster.fileDmail(dmail, ['work/urgent'])).toBe(true);
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

// Aliases are a plain object keyed by name, so names that are also
// Object.prototype properties must not collide with them (#1579).
describe('aliases that are Object.prototype properties', () => {
    const NAMES = ['constructor', 'toString', 'hasOwnProperty', '__proto__'];

    it.each(NAMES)('adds, reads, lists and removes the alias %s', async name => {
        const bob = await keymaster.createId('Bob');

        expect(await keymaster.getAlias(name)).toBeNull();

        await keymaster.addAlias(name, bob);
        expect(await keymaster.getAlias(name)).toBe(bob);
        expect(await keymaster.lookupDID(name)).toBe(bob);
        expect(await keymaster.listAliases()).toEqual({ [name]: bob });
        expect(Object.keys(await keymaster.listAliases({ includeIDs: true })).sort()).toEqual(['Bob', name].sort());

        await keymaster.removeAlias(name);
        expect(await keymaster.getAlias(name)).toBeNull();
        expect(await keymaster.listAliases()).toEqual({});
    });
});
