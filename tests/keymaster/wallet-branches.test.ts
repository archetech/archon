import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { StoredWallet } from '@didcid/keymaster/types';

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
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm'] });
    wallet = new WalletJsonMemory();
    cipher = new CipherNode();
    keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase: 'passphrase' });
    await keymaster.loadOrCreateWallet();
});

// A store that keeps what it already holds and reports every later save as
// failed, as a full disk or a read-only volume would.
class FrozenWallet extends WalletJsonMemory {
    frozen = false;

    async saveWallet(stored: StoredWallet, overwrite: boolean = false): Promise<boolean> {
        if (this.frozen) {
            return false;
        }
        return super.saveWallet(stored, overwrite);
    }
}

describe('loadOrCreateWallet', () => {
    it('does not replace a stored wallet it cannot decrypt', async () => {
        await keymaster.createId('Alice');
        const before = wallet.walletCache;

        const wrong = new Keymaster({ gatekeeper, wallet, cipher, passphrase: 'not the passphrase' });

        await expect(wrong.loadOrCreateWallet()).rejects.toThrow('Incorrect passphrase');
        expect(wallet.walletCache).toBe(before);
    });
});

describe('changePassphrase', () => {
    it('keeps the old passphrase when the new wallet cannot be saved', async () => {
        const frozen = new FrozenWallet();
        const km = new Keymaster({ gatekeeper, wallet: frozen, cipher, passphrase: 'old' });
        await km.loadOrCreateWallet();
        await km.createId('Alice');
        frozen.frozen = true;

        await expect(km.changePassphrase('new')).rejects.toThrow('Failed to save wallet with new passphrase');

        const reopened = new Keymaster({ gatekeeper, wallet: frozen, cipher, passphrase: 'old' });
        expect(Object.keys((await reopened.loadWallet()).ids)).toEqual(['Alice']);
    });
});

describe('checkWallet and fixWallet', () => {
    it('count a revoked identity as deleted and then remove it', async () => {
        const alice = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        await keymaster.revokeDID(alice);

        expect(await keymaster.checkWallet()).toStrictEqual({ checked: 2, invalid: 0, deleted: 1 });

        expect(await keymaster.fixWallet()).toMatchObject({ idsRemoved: 1 });
        expect(Object.keys((await keymaster.loadWallet()).ids)).toEqual(['Bob']);
    });

    // revokeDID drops an asset from the wallet that revoked it, so a revoked
    // asset stays listed only in another copy of the wallet.
    it('count an asset revoked from another copy of the wallet as deleted and then remove it', async () => {
        await keymaster.createId('Alice');
        const kept = await keymaster.createAsset({ keep: true });
        const revoked = await keymaster.createAsset({ keep: false });

        const copy = new WalletJsonMemory();
        copy.walletCache = wallet.walletCache;
        const other = new Keymaster({ gatekeeper, wallet: copy, cipher, passphrase: 'passphrase' });
        await other.revokeDID(revoked);

        expect(await keymaster.checkWallet()).toStrictEqual({ checked: 3, invalid: 0, deleted: 1 });

        expect(await keymaster.fixWallet()).toMatchObject({ idsRemoved: 0, ownedRemoved: 1 });
        expect((await keymaster.loadWallet()).ids.Alice.owned).toEqual([kept]);
    });
});

describe('loadWallet', () => {
    it('refuses a stored wallet from a later version', async () => {
        await keymaster.createId('Alice');
        const stored = JSON.parse(wallet.walletCache!);
        stored.version = 3;

        const store = new WalletJsonMemory();
        await store.saveWallet(stored);
        const km = new Keymaster({ gatekeeper, wallet: store, cipher, passphrase: 'passphrase' });

        await expect(km.loadWallet()).rejects.toThrow('Unsupported wallet version.');
    });
});

describe('backupId', () => {
    it('needs an identity when none is named', async () => {
        await expect(keymaster.backupId()).rejects.toThrow('Invalid parameter: no current ID');
    });
});

describe('recoverId', () => {
    it('refuses an identity that was never backed up', async () => {
        const alice = await keymaster.createId('Alice');

        await expect(keymaster.recoverId(alice)).rejects.toThrow('didDocumentData missing backupStore');
    });

    it('refuses a backup store that holds no backup', async () => {
        const alice = await keymaster.createId('Alice');
        const store = await keymaster.createAsset({ notABackup: true });
        await keymaster.mergeData(alice, { backupStore: store });

        await expect(keymaster.recoverId(alice)).rejects.toThrow('backup not found in backupStore');
    });
});

describe('importNostr', () => {
    it.each(['', undefined])('refuses a missing nsec (%j)', async (nsec) => {
        await keymaster.createId('Alice');

        await expect(keymaster.importNostr(nsec as any)).rejects.toThrow('Invalid parameter: nsec');
    });
});

// A backup holds the identity's key index at the time it was taken. Recovered
// after a rotation, the identity has none of the keys its document now
// publishes, so everything that signs or decrypts as it must fail plainly.
describe('an identity recovered from a backup older than its key', () => {
    let alice: string;
    let bob: string;

    beforeEach(async () => {
        bob = await keymaster.createId('Bob', { registry: 'local' });
        alice = await keymaster.createId('Alice', { registry: 'local' });
        await keymaster.backupId('Alice');
        await keymaster.rotateKeys();
        await keymaster.removeId('Alice');
        await keymaster.recoverId(alice);
    });

    it('has no key pair', async () => {
        expect(await keymaster.fetchKeyPair('Alice')).toBeNull();
    });

    it('cannot encrypt a message', async () => {
        await expect(keymaster.encryptMessage('hi', bob)).rejects.toThrow('No valid sender keypair');
    });

    it('cannot sign', async () => {
        await expect(keymaster.addProof({ claim: 1 })).rejects.toThrow('addProof: no keypair');
    });

    it('cannot add, export or use a Nostr key', async () => {
        await expect(keymaster.addNostr()).rejects.toThrow('Invalid parameter: id');
        await expect(keymaster.exportNsec()).rejects.toThrow('Invalid parameter: id');
        await expect(keymaster.signNostrEvent({
            created_at: 0,
            kind: 1,
            tags: [],
            content: 'hello',
        } as any)).rejects.toThrow('Invalid parameter: id');
    });
});
