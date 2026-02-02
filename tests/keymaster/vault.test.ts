import sharp from 'sharp';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import {
    Vault,
    VaultLogin,
} from '@didcid/keymaster/types';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import { ExpectedExceptionError, UnknownIDError, InvalidParameterError } from '@didcid/common/errors';
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

describe('createVault', () => {
    it('should return a new vault DID', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        const doc = await keymaster.resolveDID(did);
        const data = doc.didDocumentData as { vault?: Vault };

        expect(data.vault).toBeDefined();
        expect(data.vault!.version).toBe(1);
        expect(data.vault!.publicJwk).toBeDefined();
        expect(data.vault!.salt).toBeDefined();
        expect(data.vault!.keys).toBeDefined();
        expect(data.vault!.items).toBeDefined();
        expect(data.vault!.sha256).toStrictEqual(cipher.hashJSON({}));
    });
});

describe('getVault', () => {
    it('should return a vault', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        const vault = await keymaster.getVault(did);

        expect(vault).toBeDefined();
        expect(vault!.version).toBe(1);
        expect(vault!.publicJwk).toBeDefined();
        expect(vault!.salt).toBeDefined();
        expect(vault!.keys).toBeDefined();
        expect(vault!.items).toBeDefined();
        expect(vault!.sha256).toStrictEqual(cipher.hashJSON({}));
    });

    it('should throw an exception on get invalid vault', async () => {
        const bob = await keymaster.createId('Bob');

        try {
            await keymaster.getVault('bogus');
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.type).toBe(UnknownIDError.type);
        }

        try {
            await keymaster.getVault(bob);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.type).toBe(InvalidParameterError.type);
        }
    });
});

describe('testVault', () => {
    it('should return true for a vault', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        const isVault = await keymaster.testVault(did);

        expect(isVault).toBe(true);
    });

    it('should return false for an agent', async () => {
        const bob = await keymaster.createId('Bob');
        const isVault = await keymaster.testVault(bob);

        expect(isVault).toBe(false);
    });

    it('should return false for another kind of asset', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createAsset({ name: 'mockAnchor' });
        const isVault = await keymaster.testVault(did);

        expect(isVault).toBe(false);
    });
});

describe('addVaultMember', () => {
    it('should add a new member to the vault', async () => {
        const alice = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        const ok = await keymaster.addVaultMember(did, alice);
        expect(ok).toBe(true);

        const vault = await keymaster.getVault(did);
        expect(Object.keys(vault.keys).length).toBe(2);
    });

    it('should not be able add owner as a member', async () => {
        const bob = await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        const ok = await keymaster.addVaultMember(did, bob);
        expect(ok).toBe(false);
    });

    it('should be able to add a new member after key rotation', async () => {
        const alice = await keymaster.createId('Alice');
        const charlie = await keymaster.createId('Charlie');

        await keymaster.createId('Bob', { registry: 'local' });
        const did = await keymaster.createVault({ registry: 'local' });

        await keymaster.addVaultMember(did, alice);
        await keymaster.rotateKeys();

        const ok = await keymaster.addVaultMember(did, charlie);
        expect(ok).toBe(true);

        const vault = await keymaster.getVault(did);
        expect(Object.keys(vault.keys).length).toBe(3);
    });

    // eslint-disable-next-line
    it('should throw an exception if not owner', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        await keymaster.createId('Alice');

        try {
            await keymaster.addVaultMember(did, 'Bob');
            throw new ExpectedExceptionError();
        } catch (error: any) {
            // eslint-disable-next-line
            expect(error.message).toBe('Keymaster: Only vault owner can modify the vault');
        }
    });

    it('should throw an exception on invalid member', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        try {
            await keymaster.addVaultMember(did, 'bogus');
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.type).toBe(UnknownIDError.type);
        }

        try {
            const asset = await keymaster.createAsset({ name: 'mockAnchor' });
            await keymaster.addVaultMember(did, asset);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            // eslint-disable-next-line
            expect(error.detail).toBe('Document is not an agent');
        }
    });
});

describe('removeVaultMember', () => {
    it('should remove a member from the vault', async () => {
        const alice = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        await keymaster.addVaultMember(did, alice);
        const ok = await keymaster.removeVaultMember(did, alice);
        expect(ok).toBe(true);

        const vault = await keymaster.getVault(did);
        expect(Object.keys(vault.keys).length).toBe(1);
    });

    it('should remove a member from the vault with secret members', async () => {
        const alice = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault({ secretMembers: true });

        await keymaster.addVaultMember(did, alice);
        const ok = await keymaster.removeVaultMember(did, alice);
        expect(ok).toBe(true);

        const vault = await keymaster.getVault(did);
        expect(Object.keys(vault.keys).length).toBe(1);
    });

    it('should not be able to remove owner from the vault', async () => {
        const alice = await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        await keymaster.addVaultMember(did, alice);
        const ok = await keymaster.removeVaultMember(did, bob);
        expect(ok).toBe(false);
    });

    it('should be OK to remove a non-existent member from the vault', async () => {
        const alice = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        const ok = await keymaster.removeVaultMember(did, alice);
        expect(ok).toBe(true);
    });

    it('should throw an exception if not owner', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        await keymaster.createId('Alice');

        try {
            await keymaster.removeVaultMember(did, 'Bob');
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Keymaster: Only vault owner can modify the vault');
        }
    });

    it('should throw an exception on invalid member', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        try {
            await keymaster.removeVaultMember(did, 'bogus');
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.type).toBe(UnknownIDError.type);
        }

        try {
            const asset = await keymaster.createAsset({ name: 'mockAnchor' });
            await keymaster.removeVaultMember(did, asset);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.detail).toBe('Document is not an agent');
        }
    });
});

describe('listVaultMembers', () => {
    it('should return an empty list of members on creation', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        const members = await keymaster.listVaultMembers(did);

        expect(members).toStrictEqual({});
    });

    it('should return member list to owner', async () => {
        const alice = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        await keymaster.addVaultMember(did, 'Alice');

        const members = await keymaster.listVaultMembers(did);

        expect(alice in members).toBe(true);
    });

    it('should return empty list when all members removed', async () => {
        const alice = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        await keymaster.addVaultMember(did, alice);
        await keymaster.removeVaultMember(did, alice);

        const members = await keymaster.listVaultMembers(did);

        expect(members).toStrictEqual({});
    });

    it('should return member list to members when not secret', async () => {
        const alice = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        await keymaster.addVaultMember(did, 'Alice');
        await keymaster.setCurrentId('Alice');

        const members = await keymaster.listVaultMembers(did);

        expect(alice in members).toBe(true);
    });

    it('should not return member list to members when secret', async () => {
        await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault({ secretMembers: true });
        await keymaster.addVaultMember(did, 'Alice');
        await keymaster.setCurrentId('Alice');

        const members = await keymaster.listVaultMembers(did);

        expect(members).toStrictEqual({});
    });

    it('should trigger a version upgrade', async () => {
        const alice = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault({ version: 0 });

        const ok = await keymaster.addVaultMember(did, alice);
        expect(ok).toBe(true);

        const members = await keymaster.listVaultMembers(did);
        expect(alice in members).toBe(true);

        const vault = await keymaster.getVault(did);
        expect(vault.version).toBe(1);
    });

    it('should throw an exception if triggered version upgrade encounters unsupported version', async () => {
        const alice = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        const ok = await keymaster.addVaultMember(did, alice);
        expect(ok).toBe(true);

        try {
            const vault = await keymaster.getVault(did);
            vault.version = 999; // Simulate unsupported version
            await keymaster.updateAsset(did, { vault });
            await keymaster.listVaultMembers(did);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Keymaster: Unsupported vault version');
        }
    });
});

describe('addVaultItem', () => {
    const mockDocument = Buffer.from('This is a mock binary document 1.', 'utf-8');

    it('should add a document to the vault', async () => {
        const mockName = 'mockDocument1.txt';
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        const ok = await keymaster.addVaultItem(did, mockName, mockDocument);
        expect(ok).toBe(true);
    });

    it('should add a document to the vault with a unicode name', async () => {
        const mockName = 'm̾o̾c̾k̾N̾a̾m̾e̾.txt';
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        const ok = await keymaster.addVaultItem(did, mockName, mockDocument);
        expect(ok).toBe(true);
    });

    it('should add an image to the vault', async () => {
        const mockImage = await sharp({
            create: {
                width: 100,
                height: 100,
                channels: 3,
                background: { r: 255, g: 0, b: 0 }
            }
        }).png().toBuffer();
        const mockName = 'vaultImage.png';
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        const ok = await keymaster.addVaultItem(did, mockName, mockImage);
        expect(ok).toBe(true);

        const items = await keymaster.listVaultItems(did);
        expect(items![mockName]).toBeDefined();
        expect(items![mockName].type).toBe('image/png');
    });

    it('should add JSON to the vault', async () => {
        const login: VaultLogin = {
            service: 'https://example.com',
            username: 'bob',
            password: 'secret',
        };
        const buffer = Buffer.from(JSON.stringify({ login }), 'utf-8');
        const mockName = `login: ${login.service}`;
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        const ok = await keymaster.addVaultItem(did, mockName, buffer);
        expect(ok).toBe(true);

        const items = await keymaster.listVaultItems(did);
        expect(items![mockName]).toBeDefined();
        expect(items![mockName].type).toBe('application/json');
    });

    it('should be able to add a new item after key rotation', async () => {
        await keymaster.createId('Bob', { registry: 'local' });
        const did = await keymaster.createVault({ registry: 'local' });

        await keymaster.addVaultItem(did, 'item1', mockDocument);
        await keymaster.rotateKeys();
        await keymaster.addVaultItem(did, 'item2', mockDocument);

        const items = await keymaster.listVaultItems(did);

        expect(items!['item1'].bytes).toBe(mockDocument.length);
        expect(items!['item1'].sha256).toBe(items!['item2'].sha256);
    });

    it('should throw an exception if not owner', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        await keymaster.createId('Alice');

        try {
            await keymaster.addVaultItem(did, 'item1', mockDocument);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Keymaster: Only vault owner can modify the vault');
        }
    });

    it('should not add an item with an empty name', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        const expectedError = 'Invalid parameter: name must be a non-empty string';

        try {
            await keymaster.addVaultItem(did, '', mockDocument);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe(expectedError);
        }

        try {
            await keymaster.addVaultItem(did, '    ', mockDocument);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe(expectedError);
        }

        try {
            await keymaster.addVaultItem(did, "\t\r\n", mockDocument);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe(expectedError);
        }
    });
});

describe('removeVaultItem', () => {
    it('should remove a document from the vault', async () => {
        const mockName = 'mockDocument9.txt';
        const mockDocument = Buffer.from('This is a mock binary document 9.', 'utf-8');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        await keymaster.addVaultItem(did, mockName, mockDocument);

        const ok = await keymaster.removeVaultItem(did, mockName);
        const items = await keymaster.listVaultItems(did);
        expect(ok).toBe(true);
        expect(items).toStrictEqual({});
    });

    it('should be OK to remove a non-existent item from the vault', async () => {
        const mockName = 'mockDocument9.txt';
        const mockDocument = Buffer.from('This is a mock binary document 9.', 'utf-8');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        await keymaster.addVaultItem(did, mockName, mockDocument);

        const ok = await keymaster.removeVaultItem(did, 'bogus');
        expect(ok).toBe(true);
    });

    it('should throw an exception if not owner', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();

        await keymaster.createId('Alice');

        try {
            await keymaster.removeVaultItem(did, 'item1');
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Keymaster: Only vault owner can modify the vault');
        }
    });
});

describe('listVaultItems', () => {
    it('should return an index of the items in the vault', async () => {
        const mockName = 'mockDocument2.txt';
        const mockDocument = Buffer.from('This is a mock binary document 2.', 'utf-8');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        const ok = await keymaster.addVaultItem(did, mockName, mockDocument);
        const items = await keymaster.listVaultItems(did);

        expect(ok).toBe(true);
        expect(items).toBeDefined();
        expect(items![mockName]).toBeDefined();
        expect(items![mockName].cid).toBeDefined();
        expect(items![mockName].bytes).toBe(mockDocument.length);
        expect(items![mockName].sha256).toBe(cipher.hashMessage(mockDocument));
    });
});

describe('getVaultItem', () => {
    const mockDocumentName = 'mockVaultItem.txt';
    const mockDocument = Buffer.from('This is a mock vault document.', 'utf-8');

    it('should return a document from the vault', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        await keymaster.addVaultItem(did, mockDocumentName, mockDocument);

        const item = await keymaster.getVaultItem(did, mockDocumentName);

        expect(item).toStrictEqual(mockDocument);
    });

    it('should return a large BLOB', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        const largeDocument = Buffer.alloc(1024 * 1024, 'A'); // 1 MB of 'A's
        await keymaster.addVaultItem(did, mockDocumentName, largeDocument);

        const item = await keymaster.getVaultItem(did, mockDocumentName);

        expect(item).toStrictEqual(largeDocument);
    });

    it('should return null for unknown item', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        await keymaster.addVaultItem(did, mockDocumentName, mockDocument);

        const item = await keymaster.getVaultItem(did, 'bogus');

        expect(item).toBe(null);
    });

    it('should return an image from the vault', async () => {
        const mockImageName = 'vaultImage33.png';
        const mockImage = await sharp({
            create: {
                width: 100,
                height: 100,
                channels: 3,
                background: { r: 255, g: 0, b: 0 }
            }
        }).png().toBuffer();
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        await keymaster.addVaultItem(did, mockImageName, mockImage);

        const item = await keymaster.getVaultItem(did, mockImageName);

        expect(item).toStrictEqual(mockImage);
    });

    it('should return a document from the vault to a different member', async () => {
        const alice = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        await keymaster.addVaultMember(did, alice);
        await keymaster.addVaultItem(did, mockDocumentName, mockDocument);

        await keymaster.setCurrentId('Alice');
        const item = await keymaster.getVaultItem(did, mockDocumentName);

        expect(item).toStrictEqual(mockDocument);
    });

    it('should return a document from the vault after key rotation', async () => {
        // Need to register on local so key rotation is automatically confirmed
        const alice = await keymaster.createId('Alice', { registry: 'local' });
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        await keymaster.addVaultMember(did, alice);
        await keymaster.addVaultItem(did, mockDocumentName, mockDocument);

        await keymaster.setCurrentId('Alice');
        await keymaster.rotateKeys();

        const item = await keymaster.getVaultItem(did, mockDocumentName);

        expect(item).toStrictEqual(mockDocument);
    });

    it('should throw error if caller is not a member', async () => {
        await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        await keymaster.addVaultItem(did, mockDocumentName, mockDocument);

        await keymaster.setCurrentId('Alice');

        await expect(keymaster.getVaultItem(did, mockDocumentName)).rejects.toThrow('No access to vault');
    });

    it('should retrieve JSON', async () => {
        const login: VaultLogin = {
            service: 'https://example2.com',
            username: 'alice',
            password: '*******',
        };
        const buffer = Buffer.from(JSON.stringify({ login }), 'utf-8');
        const mockName = `login: ${login.service}`;
        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        await keymaster.addVaultItem(did, mockName, buffer);

        const itemBuffer = await keymaster.getVaultItem(did, mockName);
        const itemLogin = JSON.parse(itemBuffer!.toString('utf-8'));

        expect(itemLogin).toStrictEqual({ login });
    });

    it('should retrieve small items using inline data field (regression test for #44)', async () => {
        // Issue #44: getVaultItem returned "Item not found" for items that exist
        // Root cause: Gatekeeper always returns a CID but doesn't always store data to IPFS.
        // Small items (<8KB) store encrypted data inline in the 'data' field as a reliable fallback.
        // The old code only tried gatekeeper.getText(cid) which fails when IPFS storage wasn't done.
        // The fix: Check items[name].data first (reliable), fall back to gatekeeper.getText(cid)

        const smallDocument = Buffer.from('Small test document', 'utf-8');
        const itemName = 'small-doc.txt';

        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        await keymaster.addVaultItem(did, itemName, smallDocument);

        // Verify the item has inline data stored
        const items = await keymaster.listVaultItems(did);
        expect(items[itemName]).toBeDefined();
        expect(items[itemName].data).toBeDefined(); // Small items should have inline data
        expect(items[itemName].cid).toBeDefined();  // CID should also exist

        // Retrieve the item - this should use the inline data field
        const retrieved = await keymaster.getVaultItem(did, itemName);

        expect(retrieved).toStrictEqual(smallDocument);
    });

    it('should throw error when both inline data and IPFS retrieval fail', async () => {
        // This tests the error path when neither inline data nor gatekeeper.getText() returns data
        const largeDocument = Buffer.alloc(10 * 1024, 'X'); // 10KB - larger than 8KB threshold, no inline data
        const itemName = 'large-doc.bin';

        await keymaster.createId('Bob');
        const did = await keymaster.createVault();
        await keymaster.addVaultItem(did, itemName, largeDocument);

        // Verify no inline data for large items
        const items = await keymaster.listVaultItems(did);
        expect(items[itemName]).toBeDefined();
        expect(items[itemName].data).toBeUndefined(); // Large items don't have inline data
        expect(items[itemName].cid).toBeDefined();

        // Replace gatekeeper.getText to return null (simulating IPFS failure)
        const originalGetText = gatekeeper.getText.bind(gatekeeper);
        gatekeeper.getText = async () => null as any;

        try {
            await expect(keymaster.getVaultItem(did, itemName))
                .rejects.toThrow(`Failed to retrieve data for item '${itemName}'`);
        } finally {
            // Restore original function
            gatekeeper.getText = originalGetText;
        }
    });
});
