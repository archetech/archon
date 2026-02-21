import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import { WalletEncFile, WalletFile } from '@didcid/keymaster/types';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import { ExpectedExceptionError } from '@didcid/common/errors';
import HeliaClient from '@didcid/ipfs/helia';
import { DidCidDocument } from "@didcid/gatekeeper/types";
import { TestHelper } from './helper.ts';


let ipfs: HeliaClient;
let gatekeeper: Gatekeeper;
let wallet: WalletJsonMemory;
let cipher: CipherNode;
let keymaster: Keymaster;
let helper: TestHelper;
const PASSPHRASE = 'passphrase';

// These mocks were generated with PBKDF2_ITERATIONS=1 for fast tests
// Regenerate with: PBKDF2_ITERATIONS=1 npm test -- --testPathPattern="generate-mocks"
const MOCK_WALLET_V1: WalletFile = {
    "version": 1,
    "seed": {
        "mnemonicEnc": {
            "salt": "hWNH3lTQAJ5zsfyZO7zKUg==",
            "iv": "CVivp2Eh7L3UwDtY",
            "data": "aFU0bf/yu9hftHYf4cDSt/M+52ZhePLgRyDkR6BihnYj268CvuKCHFCVuUK+SNFGPKFFwHsYpE9Rwk5PyGuJXU2LtoXwtgs8UbFA6Yvp9e0D5L/lJcc="
        },
    },
    "counter": 0,
    "ids": {}
};

const MOCK_WALLET_V1_ENCRYPTED: WalletEncFile = {
    "version": 1,
    "seed": {
        "mnemonicEnc": {
            "salt": "hWNH3lTQAJ5zsfyZO7zKUg==",
            "iv": "CVivp2Eh7L3UwDtY",
            "data": "aFU0bf/yu9hftHYf4cDSt/M+52ZhePLgRyDkR6BihnYj268CvuKCHFCVuUK+SNFGPKFFwHsYpE9Rwk5PyGuJXU2LtoXwtgs8UbFA6Yvp9e0D5L/lJcc="
        }
    },
    "enc": "SUW0qL1l8hF3MiK-M5Yc_LnTvzYM4WqojHnirgsmXj9HyG7sKRrjDwOYExla4UWDdb9EeSwiXSsWMqHoGEs"
}

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
    keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase: PASSPHRASE });
    helper = new TestHelper(keymaster);
});

describe('loadWallet', () => {
    it('should create a wallet on first load', async () => {
        const wallet = await keymaster.loadWallet();

        expect(wallet).toEqual(
            expect.objectContaining({
                version: 2,
                counter: 0,
                seed: expect.objectContaining({
                    mnemonicEnc: {
                        salt: expect.any(String),
                        iv: expect.any(String),
                        data: expect.any(String),
                    },
                }),
                ids: {}
            })
        );
    });

    it('should return the same wallet on second load', async () => {
        const wallet1 = await keymaster.loadWallet();
        const wallet2 = await keymaster.loadWallet();

        expect(wallet2).toStrictEqual(wallet1);
    });

    it('should return null when loading non-existing wallet', async () => {
        const check_wallet = await wallet.loadWallet();
        expect(check_wallet).toBe(null);
    });

    it('should throw exception saving an unsupported wallet version', async () => {
        const mockWallet = { version: 0, seed: { mnemonic: "test" } };

        try {
            await keymaster.saveWallet(mockWallet as any);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Keymaster: Unsupported wallet version.');
        }
    });

    it('should load a v1 encrypted wallet', async () => {
        await wallet.saveWallet(MOCK_WALLET_V1_ENCRYPTED);
        const res = await keymaster.loadWallet();
        expect(res).toEqual(
            expect.objectContaining({
                version: 2,
                counter: 0,
                seed: expect.objectContaining({
                    mnemonicEnc: expect.any(Object)
                })
            })
        );
    });

    it('should load a v1 encrypted wallet from cache', async () => {
        await wallet.saveWallet(MOCK_WALLET_V1_ENCRYPTED);
        // prime cache
        await keymaster.loadWallet();
        // load from cache
        const res = await keymaster.loadWallet();
        expect(res).toEqual(
            expect.objectContaining({
                version: 2,
                counter: 0,
                seed: expect.objectContaining({
                    mnemonicEnc: expect.any(Object)
                })
            })
        );
    });

    it('should throw on unsupported wallet version', async () => {
        let clone = structuredClone(MOCK_WALLET_V1_ENCRYPTED);
        delete clone.seed.mnemonicEnc;
        await wallet.saveWallet(clone);

        try {
            await keymaster.loadWallet();
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Keymaster: Unsupported wallet version.');
        }
    });
});

describe('saveWallet', () => {
    it('test saving directly on the unencrypted wallet', async () => {
        const ok = await wallet.saveWallet(MOCK_WALLET_V1);
        expect(ok).toBe(true);
    });

    it('test saving directly on the wallet', async () => {
        const ok = await wallet.saveWallet(MOCK_WALLET_V1);

        expect(ok).toBe(true);
    });

    it('should save a wallet', async () => {
        const ok = await keymaster.saveWallet(MOCK_WALLET_V1);
        const wallet = await keymaster.loadWallet();

        expect(ok).toBe(true);
        expect(wallet).toStrictEqual(MOCK_WALLET_V1);
    });

    it('should ignore overwrite flag if unnecessary', async () => {
        const ok = await keymaster.saveWallet(MOCK_WALLET_V1, false);
        const wallet = await keymaster.loadWallet();

        expect(ok).toBe(true);
        expect(wallet).toStrictEqual(MOCK_WALLET_V1);
    });

    it('should overwrite an existing wallet', async () => {
        const mockWallet = MOCK_WALLET_V1;
        mockWallet.counter = 1;

        await keymaster.saveWallet(MOCK_WALLET_V1);
        const ok = await keymaster.saveWallet(mockWallet);
        const wallet = await keymaster.loadWallet();

        expect(ok).toBe(true);
        expect(wallet).toStrictEqual(mockWallet);
    });

    it('should not overwrite an existing wallet if specified', async () => {
        const mockWallet = MOCK_WALLET_V1;
        mockWallet.counter = 1;

        await keymaster.saveWallet(MOCK_WALLET_V1);
        const ok = await keymaster.saveWallet(mockWallet, false);
        const wallet = await keymaster.loadWallet();

        expect(ok).toBe(false);
        expect(wallet).toStrictEqual(MOCK_WALLET_V1);
    });

    it('should overwrite an existing wallet in a loop', async () => {
        for (let i = 0; i < 10; i++) {
            const mockWallet = MOCK_WALLET_V1;
            mockWallet.counter = i + 1;

            const ok = await keymaster.saveWallet(mockWallet);
            const wallet = await keymaster.loadWallet();

            expect(ok).toBe(true);
            expect(wallet).toStrictEqual(mockWallet);
        }
    });

    it('should not overwrite an existing wallet if specified', async () => {
        const mockWallet = MOCK_WALLET_V1;
        mockWallet.counter = 2;

        await keymaster.saveWallet(MOCK_WALLET_V1);
        const ok = await keymaster.saveWallet(mockWallet, false);
        const walletData = await keymaster.loadWallet();

        expect(ok).toBe(false);
        expect(walletData).toStrictEqual(MOCK_WALLET_V1);
    });

    it('wallet should return unencrypted wallet', async () => {
        const keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase: PASSPHRASE });
        const testWallet = await keymaster.loadWallet();
        const expectedWallet = await keymaster.loadWallet();

        expect(testWallet).toStrictEqual(expectedWallet);
    });

    it('should save augmented wallet', async () => {
        await keymaster.createId('Bob');
        const wallet = await keymaster.loadWallet();

        wallet.ids['Bob'].icon = 'smiley';
        wallet.metadata = { foo: 'bar' };
        await keymaster.saveWallet(wallet, true);

        const wallet2 = await keymaster.loadWallet();

        expect(wallet).toStrictEqual(wallet2);
    });

    it('should encrypt an unencrypted v1 wallet contents', async () => {
        const ok = await keymaster.saveWallet(MOCK_WALLET_V1);
        expect(ok).toBe(true);

        const res = await wallet.loadWallet();
        expect(res).toEqual(
            expect.objectContaining({
                version: 2,
                enc: expect.any(String),
                seed: expect.objectContaining({
                    mnemonicEnc: expect.any(Object),
                }),
            })
        );
    });

    it('should save a v1 encrypted wallet', async () => {
        const ok = await keymaster.saveWallet(MOCK_WALLET_V1_ENCRYPTED, true);
        expect(ok).toBe(true);
    });

    it('should throw on incorrect passphrase', async () => {
        const wallet = new WalletJsonMemory();
        const keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase: 'incorrect' });

        try {
            await keymaster.saveWallet(MOCK_WALLET_V1_ENCRYPTED, true);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Keymaster: Incorrect passphrase.');
        }
    });

    it('should not mask non-passphrase errors as incorrect passphrase', async () => {
        const corruptWallet: WalletEncFile = {
            version: 1,
            seed: {
                mnemonicEnc: { salt: 'ok', iv: 'ok' } as any, // missing 'data' property
            },
            enc: 'dummy',
        };

        const wallet = new WalletJsonMemory();
        const keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase: PASSPHRASE });

        try {
            await keymaster.saveWallet(corruptWallet, true);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).not.toBe('Keymaster: Incorrect passphrase.');
        }
    });
});

describe('decryptMnemonic', () => {
    it('should return 12 words', async () => {
        await keymaster.loadWallet();
        const mnemonic = await keymaster.decryptMnemonic();

        // Split the mnemonic into words
        const words = mnemonic.split(' ');
        expect(words.length).toBe(12);
    });
});

describe('changePassphrase', () => {
    it('should re-encrypt wallet with new passphrase', async () => {
        const did = await keymaster.createId('Bob');
        const mnemonicBefore = await keymaster.decryptMnemonic();

        const ok = await keymaster.changePassphrase('new-passphrase');
        expect(ok).toBe(true);

        // Wallet still works with the instance (passphrase updated in memory)
        const walletAfter = await keymaster.loadWallet();
        expect(walletAfter.ids['Bob'].did).toBe(did);

        // Mnemonic is unchanged
        const mnemonicAfter = await keymaster.decryptMnemonic();
        expect(mnemonicAfter).toBe(mnemonicBefore);
    });

    it('should load with new passphrase after change', async () => {
        await keymaster.createId('Bob');
        await keymaster.changePassphrase('new-passphrase');

        // Create a fresh keymaster with the new passphrase against the same wallet store
        const km2 = new Keymaster({ gatekeeper, wallet, cipher, passphrase: 'new-passphrase' });
        const loaded = await km2.loadWallet();
        expect(loaded.ids).toHaveProperty('Bob');
    });

    it('should fail to load with old passphrase after change', async () => {
        await keymaster.createId('Bob');
        await keymaster.changePassphrase('new-passphrase');

        const km2 = new Keymaster({ gatekeeper, wallet, cipher, passphrase: PASSPHRASE });
        try {
            await km2.loadWallet();
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Keymaster: Incorrect passphrase.');
        }
    });

    it('should throw on empty passphrase', async () => {
        await keymaster.loadWallet();
        try {
            await keymaster.changePassphrase('');
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error).not.toBeInstanceOf(ExpectedExceptionError);
        }
    });
});

describe('exportEncryptedWallet', () => {
    it('should export the wallet in encrypted form', async () => {
        const res = await keymaster.exportEncryptedWallet();
        expect(res).toEqual(
            expect.objectContaining({
                version: 2,
                seed: expect.objectContaining({
                    mnemonicEnc: expect.any(Object)
                }),
                enc: expect.any(String)
            })
        );
    });
});

describe('updateSeedBank', () => {
    it('should throw error on missing DID', async () => {
        const doc: DidCidDocument = {};

        try {
            await keymaster.updateSeedBank(doc);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: seed bank missing DID');
        }
    });
});

describe('newWallet', () => {
    it('should overwrite an existing wallet when allowed', async () => {
        const wallet1 = await keymaster.loadWallet();
        await keymaster.newWallet(undefined, true);
        const wallet2 = await keymaster.loadWallet();

        expect(wallet1.seed!.mnemonicEnc !== wallet2.seed!.mnemonicEnc).toBe(true);
    });

    it('should not overwrite an existing wallet by default', async () => {
        await keymaster.loadWallet();

        try {
            await keymaster.newWallet();
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Keymaster: save wallet failed');
        }
    });

    it('should create a wallet from a mnemonic', async () => {
        const mnemonic1 = cipher.generateMnemonic();
        await keymaster.newWallet(mnemonic1);
        const mnemonic2 = await keymaster.decryptMnemonic();

        expect(mnemonic1 === mnemonic2).toBe(true);
    });

    it('should throw exception on invalid mnemonic', async () => {
        try {
            // @ts-expect-error Testing invalid usage, incorrect argument
            await keymaster.newWallet([]);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: mnemonic');
        }
    });
});

describe('resolveSeedBank', () => {
    it('should create a deterministic seed bank ID', async () => {
        const bank1 = await keymaster.resolveSeedBank();
        const bank2 = await keymaster.resolveSeedBank();

        // Update the retrieved timestamp to match any value
        bank1.didResolutionMetadata!.retrieved = expect.any(String);

        expect(bank1).toStrictEqual(bank2);
    });
});

describe('backupWallet', () => {
    it('should return a valid DID', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.backupWallet();
        const doc = await keymaster.resolveDID(did);

        expect(did === doc.didDocument!.id).toBe(true);
    });

    it('should store backup in seed bank', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.backupWallet();
        const bank = await keymaster.resolveSeedBank();

        expect(did === (bank.didDocumentData! as { wallet: string }).wallet).toBe(true);
    });
});

describe('recoverWallet', () => {
    it('should recover wallet from seed bank', async () => {
        await keymaster.createId('Bob');
        const wallet = await keymaster.loadWallet();
        const mnemonic = await keymaster.decryptMnemonic();
        await keymaster.backupWallet();

        // Recover wallet from mnemonic
        await keymaster.newWallet(mnemonic, true);
        const recovered = await keymaster.recoverWallet();

        expect(recovered).toEqual(
            expect.objectContaining({
                counter: wallet.counter,
                version: wallet.version,
                seed: {
                    mnemonicEnc: expect.any(Object),
                },
                current: wallet.current,
                ids: wallet.ids
            })
        );
    });

    it('should recover over existing wallet', async () => {
        await keymaster.createId('Bob');
        await keymaster.loadWallet();
        await keymaster.backupWallet();
        await keymaster.createId('Alice');

        // Recover over existing wallet
        const recovered = await keymaster.recoverWallet();

        expect(recovered).toEqual(
            expect.objectContaining({
                version: 2,
                counter: 1,
                current: "Bob",
                seed: expect.objectContaining({
                    mnemonicEnc: expect.any(Object),
                }),
                ids: expect.objectContaining({
                    Bob: expect.objectContaining({
                        account: 0,
                        did: expect.any(String),
                        index: 0
                    }),
                })
            })
        );
    });

    it('should recover augmented wallet from seed bank', async () => {
        await keymaster.createId('Bob');
        const wallet = await keymaster.loadWallet();
        const mnemonic = await keymaster.decryptMnemonic();

        wallet.ids['Bob'].icon = 'smiley';
        wallet.metadata = { foo: 'bar' };
        await keymaster.saveWallet(wallet, true);
        await keymaster.backupWallet();

        // Recover wallet from mnemonic
        await keymaster.newWallet(mnemonic, true);
        const recovered = await keymaster.recoverWallet();

        expect(recovered).toEqual(
            expect.objectContaining({
                counter: wallet.counter,
                version: wallet.version,
                seed: {
                    mnemonicEnc: expect.any(Object),
                },
                current: wallet.current,
                ids: wallet.ids
            })
        );
    });

    it('should recover wallet from backup DID', async () => {
        await keymaster.createId('Bob');
        const wallet = await keymaster.loadWallet();
        const mnemonic = await keymaster.decryptMnemonic();
        const did = await keymaster.backupWallet();

        // Recover wallet from mnemonic and recovery DID
        await keymaster.newWallet(mnemonic, true);
        const recovered = await keymaster.recoverWallet(did);

        expect(recovered).toEqual(
            expect.objectContaining({
                counter: wallet.counter,
                version: wallet.version,
                seed: {
                    mnemonicEnc: expect.any(Object),
                },
                current: wallet.current,
                ids: wallet.ids
            })
        );
    });

    it('should do nothing if wallet was not backed up', async () => {
        await keymaster.createId('Bob');
        const mnemonic = await keymaster.decryptMnemonic();

        // Recover wallet from mnemonic
        await keymaster.newWallet(mnemonic, true);
        const recovered = await keymaster.recoverWallet();

        expect(recovered.ids).toStrictEqual({});
    });

    it('should do nothing if backup DID is invalid', async () => {
        const agentDID = await keymaster.createId('Bob');
        const mnemonic = await keymaster.decryptMnemonic();

        // Recover wallet from mnemonic
        await keymaster.newWallet(mnemonic, true);
        const recovered = await keymaster.recoverWallet(agentDID);

        expect(recovered.ids).toStrictEqual({});
    });
});

describe('checkWallet', () => {
    it('should report no problems with empty wallet', async () => {
        const { checked, invalid, deleted } = await keymaster.checkWallet();

        expect(checked).toBe(0);
        expect(invalid).toBe(0);
        expect(deleted).toBe(0);
    });

    it('should report no problems with wallet with only one ID', async () => {
        await keymaster.createId('Alice');

        const { checked, invalid, deleted } = await keymaster.checkWallet();

        expect(checked).toBe(1);
        expect(invalid).toBe(0);
        expect(deleted).toBe(0);
    });

    it('should detect revoked ID', async () => {
        const agentDID = await keymaster.createId('Alice');
        await keymaster.revokeDID(agentDID);

        const { checked, invalid, deleted } = await keymaster.checkWallet();

        expect(checked).toBe(1);
        expect(invalid).toBe(0);
        expect(deleted).toBe(1);
    });

    it('should detect removed DIDs', async () => {
        const agentDID = await keymaster.createId('Alice');
        const schemaDID = await keymaster.createSchema();
        await keymaster.addAlias('schema', schemaDID);
        await gatekeeper.removeDIDs([agentDID, schemaDID]);

        const { checked, invalid, deleted } = await keymaster.checkWallet();

        expect(checked).toBe(3);
        expect(invalid).toBe(3);
        expect(deleted).toBe(0);
    });

    it('should detect invalid DIDs', async () => {
        await keymaster.createId('Alice');
        await keymaster.addToOwned('did:cid:mock1');
        await keymaster.addToHeld('did:cid:mock2');

        const { checked, invalid, deleted } = await keymaster.checkWallet();

        expect(checked).toBe(3);
        expect(invalid).toBe(2);
        expect(deleted).toBe(0);
    });

    it('should detect revoked credentials in wallet', async () => {
        const credentials = await helper.setupCredentials();
        await keymaster.addAlias('credential-0', credentials[0]);
        await keymaster.addAlias('credential-2', credentials[2]);
        await keymaster.revokeCredential(credentials[0]);
        await keymaster.revokeCredential(credentials[2]);

        const { checked, invalid, deleted } = await keymaster.checkWallet();

        expect(checked).toBe(16);
        expect(invalid).toBe(0);
        expect(deleted).toBe(4); // 2 credentials mentioned both in held and name lists
    });
});

describe('fixWallet', () => {
    it('should report no problems with empty wallet', async () => {
        const { idsRemoved, ownedRemoved, heldRemoved, aliasesRemoved } = await keymaster.fixWallet();

        expect(idsRemoved).toBe(0);
        expect(ownedRemoved).toBe(0);
        expect(heldRemoved).toBe(0);
        expect(aliasesRemoved).toBe(0);
    });

    it('should report no problems with wallet with only one ID', async () => {
        await keymaster.createId('Alice');
        const { idsRemoved, ownedRemoved, heldRemoved, aliasesRemoved } = await keymaster.fixWallet();

        expect(idsRemoved).toBe(0);
        expect(ownedRemoved).toBe(0);
        expect(heldRemoved).toBe(0);
        expect(aliasesRemoved).toBe(0);
    });

    it('should remove revoked ID', async () => {
        const agentDID = await keymaster.createId('Alice');
        await keymaster.revokeDID(agentDID);

        const { idsRemoved, ownedRemoved, heldRemoved, aliasesRemoved } = await keymaster.fixWallet();

        expect(idsRemoved).toBe(1);
        expect(ownedRemoved).toBe(0);
        expect(heldRemoved).toBe(0);
        expect(aliasesRemoved).toBe(0);
    });

    it('should remove deleted DIDs', async () => {
        const agentDID = await keymaster.createId('Alice');
        const schemaDID = await keymaster.createSchema();
        await keymaster.addAlias('schema', schemaDID);
        await gatekeeper.removeDIDs([agentDID, schemaDID]);

        const { idsRemoved, ownedRemoved, heldRemoved, aliasesRemoved } = await keymaster.fixWallet();

        expect(idsRemoved).toBe(1);
        expect(ownedRemoved).toBe(0);
        expect(heldRemoved).toBe(0);
        expect(aliasesRemoved).toBe(1);
    });

    it('should remove invalid DIDs', async () => {
        await keymaster.createId('Alice');
        await keymaster.addToOwned('did:cid:mock1');
        await keymaster.addToHeld('did:cid:mock2');

        const { idsRemoved, ownedRemoved, heldRemoved, aliasesRemoved } = await keymaster.fixWallet();

        expect(idsRemoved).toBe(0);
        expect(ownedRemoved).toBe(1);
        expect(heldRemoved).toBe(1);
        expect(aliasesRemoved).toBe(0);
    });

    it('should remove revoked credentials', async () => {
        const credentials = await helper.setupCredentials();
        await keymaster.addAlias('credential-0', credentials[0]);
        await keymaster.addAlias('credential-2', credentials[2]);
        await keymaster.revokeCredential(credentials[0]);
        await keymaster.revokeCredential(credentials[2]);

        const { idsRemoved, ownedRemoved, heldRemoved, aliasesRemoved } = await keymaster.fixWallet();

        expect(idsRemoved).toBe(0);
        expect(ownedRemoved).toBe(0);
        expect(heldRemoved).toBe(2);
        expect(aliasesRemoved).toBe(2);
    });
});

describe('updateWallet', () => {
    it('should throw when no wallet has been created', async () => {
        const test = new WalletJsonMemory();
        try {
            await test.updateWallet(() => { });
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('updateWallet: no wallet found to update');
        }
    });
});

