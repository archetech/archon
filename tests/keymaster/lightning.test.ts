import express from 'express';
import request from 'supertest';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import { UnknownIDError, InvalidParameterError, LightningNotConfiguredError, LightningStateError, LightningUnavailableError } from '@didcid/common/errors';
import MemoryClient from '@didcid/ipfs/memory';
import { createLightningRouter } from '../../services/keymaster/server/src/keymaster-lightning-router.ts';

let ipfs: MemoryClient;
let gatekeeper: any;
let wallet: WalletJsonMemory;
let cipher: CipherNode;
let keymaster: Keymaster;

let calls: Array<{ method: string; args: any[] }>;

function trackCall(method: string, ...args: any[]) {
    calls.push({ method, args });
}

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
    const baseGatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm', 'BTC:signet'] });
    wallet = new WalletJsonMemory();
    cipher = new CipherNode();

    calls = [];

    // Create a gatekeeper proxy that adds DrawbridgeInterface Lightning methods
    gatekeeper = Object.create(baseGatekeeper);
    gatekeeper.url = 'http://test-drawbridge';

    gatekeeper.createLightningWallet = (name: string) => {
        trackCall('createLightningWallet', name);
        return Promise.resolve({ walletId: 'w1', adminKey: 'admin1', invoiceKey: 'invoice1' });
    };

    gatekeeper.getLightningBalance = (invoiceKey: string) => {
        trackCall('getLightningBalance', invoiceKey);
        return Promise.resolve({ balance: 1000 });
    };

    gatekeeper.createLightningInvoice = (invoiceKey: string, amount: number, memo: string) => {
        trackCall('createLightningInvoice', invoiceKey, amount, memo);
        return Promise.resolve({ paymentRequest: 'lnbc100...', paymentHash: 'hash123' });
    };

    gatekeeper.payLightningInvoice = (adminKey: string, bolt11: string) => {
        trackCall('payLightningInvoice', adminKey, bolt11);
        return Promise.resolve({ paymentHash: 'out-hash' });
    };

    gatekeeper.checkLightningPayment = (invoiceKey: string, paymentHash: string) => {
        trackCall('checkLightningPayment', invoiceKey, paymentHash);
        return Promise.resolve({ paid: true, preimage: 'preimage123', paymentHash });
    };

    gatekeeper.publishLightning = (did: string, invoiceKey: string) => {
        trackCall('publishLightning', did, invoiceKey);
        return Promise.resolve({ ok: true });
    };

    gatekeeper.unpublishLightning = (did: string) => {
        trackCall('unpublishLightning', did);
        return Promise.resolve(true);
    };

    gatekeeper.zapLightning = (adminKey: string, did: string, amount: number, memo?: string) => {
        trackCall('zapLightning', adminKey, did, amount, memo);
        return Promise.resolve({ paymentHash: 'zap-hash' });
    };

    gatekeeper.getLightningPayments = (adminKey: string) => {
        trackCall('getLightningPayments', adminKey);
        return Promise.resolve([
            { paymentHash: 'hash1', amount: 100, fee: 0, memo: 'received', time: '2023-11-14T22:13:20+00:00', pending: false },
        ]);
    };

    keymaster = new Keymaster({
        gatekeeper, wallet, cipher, passphrase: 'passphrase',
    });
    await keymaster.loadOrCreateWallet();
    // The stubbed gatekeeper.url is a black-hole host; preset the memoized node
    // capability manifest so the gating fetch doesn't hit the network (a real node
    // offering Lightning would return this).
    (keymaster as any)._nodeCapabilities = { didcomm: true, lightning: true };
});

describe('addLightning', () => {
    it('should create a Lightning wallet for the current ID', async () => {
        await keymaster.createId('Bob');

        const config = await keymaster.addLightning();

        expect(config).toStrictEqual({
            walletId: 'w1',
            adminKey: 'admin1',
            invoiceKey: 'invoice1',
        });
    });

    it('should store credentials in wallet IDInfo keyed by URL', async () => {
        await keymaster.createId('Bob');

        await keymaster.addLightning();

        const walletData = await keymaster.loadWallet();
        const bobInfo = Object.values(walletData.ids).find(id => id.did);
        expect(bobInfo?.lightning).toStrictEqual({
            'http://test-drawbridge': {
                walletId: 'w1',
                adminKey: 'admin1',
                invoiceKey: 'invoice1',
            },
        });
    });

    it('should be idempotent on repeat call', async () => {
        await keymaster.createId('Bob');

        const config1 = await keymaster.addLightning();
        const config2 = await keymaster.addLightning();

        expect(config1).toStrictEqual(config2);
        const walletCalls = calls.filter(c => c.method === 'createLightningWallet');
        expect(walletCalls.length).toBe(1);
    });

    it('should create separate wallets for different DIDs', async () => {
        let walletCounter = 0;
        gatekeeper.createLightningWallet = (name: string) => {
            walletCounter++;
            trackCall('createLightningWallet', name);
            return Promise.resolve({
                walletId: `w-${walletCounter}`,
                adminKey: `admin-${walletCounter}`,
                invoiceKey: `invoice-${walletCounter}`,
            });
        };

        await keymaster.createId('Alice');
        const aliceConfig = await keymaster.addLightning();

        await keymaster.createId('Bob');
        const bobConfig = await keymaster.addLightning();

        expect(aliceConfig.walletId).not.toBe(bobConfig.walletId);
        const walletCalls = calls.filter(c => c.method === 'createLightningWallet');
        expect(walletCalls.length).toBe(2);
    });

    it('should create wallet for a named ID', async () => {
        gatekeeper.createLightningWallet = (name: string) => {
            trackCall('createLightningWallet', name);
            return Promise.resolve({
                walletId: 'w-alice',
                adminKey: 'admin-alice',
                invoiceKey: 'invoice-alice',
            });
        };

        await keymaster.createId('Alice');
        await keymaster.createId('Bob');

        const config = await keymaster.addLightning('Alice');

        expect(config.walletId).toBe('w-alice');
    });

    it('should throw for unknown ID name', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.addLightning('Unknown');
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(UnknownIDError.type);
        }
    });

    it('should throw when no ID exists', async () => {
        try {
            await keymaster.addLightning();
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error).toBeDefined();
        }
    });

    it('should migrate old flat format to per-URL dictionary', async () => {
        await keymaster.createId('Bob');

        // Manually inject old flat format
        const walletData = await keymaster.loadWallet();
        const bobInfo = Object.values(walletData.ids).find(id => id.did)!;
        bobInfo.lightning = { walletId: 'w1', adminKey: 'admin1', invoiceKey: 'invoice1' };
        await keymaster.saveWallet(walletData, true);

        // addLightning should migrate and return existing config
        const config = await keymaster.addLightning();

        expect(config).toStrictEqual({
            walletId: 'w1',
            adminKey: 'admin1',
            invoiceKey: 'invoice1',
        });

        // Verify migration persisted as per-URL dictionary
        const updated = await keymaster.loadWallet();
        const updatedBob = Object.values(updated.ids).find(id => id.did)!;
        expect(updatedBob.lightning).toStrictEqual({
            'http://test-drawbridge': {
                walletId: 'w1',
                adminKey: 'admin1',
                invoiceKey: 'invoice1',
            },
        });

        // Should not have called createLightningWallet
        const walletCalls = calls.filter(c => c.method === 'createLightningWallet');
        expect(walletCalls.length).toBe(0);
    });

    it('should create separate wallets per Drawbridge URL', async () => {
        await keymaster.createId('Bob');

        // Add lightning on first URL
        await keymaster.addLightning();

        // Switch to a different Drawbridge URL
        gatekeeper.url = 'http://other-drawbridge';
        gatekeeper.createLightningWallet = (name: string) => {
            trackCall('createLightningWallet', name);
            return Promise.resolve({ walletId: 'w2', adminKey: 'admin2', invoiceKey: 'invoice2' });
        };

        const config2 = await keymaster.addLightning();
        expect(config2.walletId).toBe('w2');

        // Verify both URLs stored
        const walletData = await keymaster.loadWallet();
        const bobInfo = Object.values(walletData.ids).find(id => id.did)!;
        expect(bobInfo.lightning).toStrictEqual({
            'http://test-drawbridge': {
                walletId: 'w1',
                adminKey: 'admin1',
                invoiceKey: 'invoice1',
            },
            'http://other-drawbridge': {
                walletId: 'w2',
                adminKey: 'admin2',
                invoiceKey: 'invoice2',
            },
        });
    });
});

describe('removeLightning', () => {
    const keysOf = async (name = 'Bob') => (await keymaster.loadWallet()).ids[name].lightning;

    function emptyWallet() {
        gatekeeper.getLightningBalance = () => Promise.resolve({ balance: 0 });
    }

    it('should remove Lightning config for current URL', async () => {
        await keymaster.createId('Bob');
        emptyWallet();

        await keymaster.addLightning();

        const ok = await keymaster.removeLightning();
        expect(ok).toBe(true);

        const walletData = await keymaster.loadWallet();
        const bobInfo = Object.values(walletData.ids).find(id => id.did);
        expect(bobInfo?.lightning).toBeUndefined();
    });

    it('should only remove config for current URL, preserving others', async () => {
        await keymaster.createId('Bob');
        emptyWallet();

        // Add lightning on two URLs
        await keymaster.addLightning();

        gatekeeper.url = 'http://other-drawbridge';
        gatekeeper.createLightningWallet = () =>
            Promise.resolve({ walletId: 'w2', adminKey: 'admin2', invoiceKey: 'invoice2' });
        await keymaster.addLightning();

        // Remove only the second URL
        await keymaster.removeLightning();

        const walletData = await keymaster.loadWallet();
        const bobInfo = Object.values(walletData.ids).find(id => id.did)!;
        expect(bobInfo.lightning).toStrictEqual({
            'http://test-drawbridge': {
                walletId: 'w1',
                adminKey: 'admin1',
                invoiceKey: 'invoice1',
            },
        });
    });

    it('should handle old flat format removal', async () => {
        await keymaster.createId('Bob');
        emptyWallet();

        // Manually inject old flat format
        const walletData = await keymaster.loadWallet();
        const bobInfo = Object.values(walletData.ids).find(id => id.did)!;
        bobInfo.lightning = { walletId: 'w1', adminKey: 'admin1', invoiceKey: 'invoice1' };
        await keymaster.saveWallet(walletData, true);

        const ok = await keymaster.removeLightning();
        expect(ok).toBe(true);

        const updated = await keymaster.loadWallet();
        const updatedBob = Object.values(updated.ids).find(id => id.did)!;
        expect(updatedBob.lightning).toBeUndefined();
    });

    it('should succeed even if Lightning was not configured', async () => {
        await keymaster.createId('Bob');

        const ok = await keymaster.removeLightning();
        expect(ok).toBe(true);
    });

    it('should throw for unknown ID name', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.removeLightning('Unknown');
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(UnknownIDError.type);
        }
    });

    it('refuses while the wallet holds funds, changing nothing', async () => {
        const did = await keymaster.createId('Bob');
        await keymaster.addLightning();
        await keymaster.publishLightning();
        calls = [];

        await expect(keymaster.removeLightning()).rejects.toThrow(LightningStateError);
        await expect(keymaster.removeLightning()).rejects.toThrow('holds 1000 sats');

        expect(await keysOf()).toBeDefined();
        expect(calls.some(call => call.method === 'unpublishLightning')).toBe(false);
        expect((await keymaster.resolveDID(did)).didDocument!.service).toHaveLength(1);
    });

    it('treats an unreadable balance as a refusal, not as zero', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();

        gatekeeper.getLightningBalance = () => Promise.reject(new Error('LNbits is down'));
        await expect(keymaster.removeLightning()).rejects.toThrow(LightningStateError);
        await expect(keymaster.removeLightning()).rejects.toThrow('LNbits is down');

        gatekeeper.getLightningBalance = () => Promise.resolve({});
        await expect(keymaster.removeLightning()).rejects.toThrow(LightningStateError);

        expect(await keysOf()).toBeDefined();
    });

    it('refuses when the wallet is on another node, whose balance it cannot read', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();
        emptyWallet();
        gatekeeper.url = 'http://other-drawbridge';

        await expect(keymaster.removeLightning()).rejects.toThrow(LightningStateError);

        expect(Object.keys((await keysOf())!)).toStrictEqual(['http://test-drawbridge']);
    });

    it('unpublishes an empty wallet before removing it, keeping other services', async () => {
        const did = await keymaster.createId('Bob');
        await keymaster.addLightning();
        await keymaster.publishLightning();
        const doc = await keymaster.resolveDID(did);
        const other = { id: `${did}#other`, type: 'Other', serviceEndpoint: 'https://example.com' };
        doc.didDocument!.service!.push(other);
        await keymaster.updateDID(did, doc);
        emptyWallet();
        calls = [];

        expect(await keymaster.removeLightning()).toBe(true);

        expect(calls).toContainEqual({ method: 'unpublishLightning', args: [did.split(':').pop()] });
        expect((await keymaster.resolveDID(did)).didDocument!.service).toStrictEqual([other]);
        expect(await keysOf()).toBeUndefined();
    });

    it('writes no DID update when the wallet was never published', async () => {
        const did = await keymaster.createId('Bob');
        await keymaster.addLightning();
        emptyWallet();
        const before = (await keymaster.resolveDID(did)).didDocumentMetadata!.versionId;

        await keymaster.removeLightning();

        expect((await keymaster.resolveDID(did)).didDocumentMetadata!.versionId).toBe(before);
        expect(await keysOf()).toBeUndefined();
    });

    it('keeps the keys when the wallet cannot be unpublished', async () => {
        const did = await keymaster.createId('Bob');
        await keymaster.addLightning();
        await keymaster.publishLightning();
        emptyWallet();

        gatekeeper.unpublishLightning = () => Promise.reject(new Error('directory is down'));
        await expect(keymaster.removeLightning()).rejects.toThrow('could not be unpublished (directory is down)');
        expect(await keysOf()).toBeDefined();

        gatekeeper.unpublishLightning = () => Promise.resolve(true);
        const updateDID = gatekeeper.updateDID;
        gatekeeper.updateDID = () => Promise.reject(new Error('gatekeeper is down'));
        await expect(keymaster.removeLightning()).rejects.toThrow(LightningStateError);
        expect(await keysOf()).toBeDefined();

        gatekeeper.updateDID = () => Promise.resolve(false);
        await expect(keymaster.removeLightning()).rejects.toThrow('the DID update was rejected');
        await expect(keymaster.unpublishLightning()).rejects.toThrow('the DID update was rejected');
        await expect(keymaster.publishLightning()).rejects.toThrow('the DID update was rejected');
        expect(await keysOf()).toBeDefined();

        gatekeeper.updateDID = updateDID;
        expect(await keymaster.removeLightning()).toBe(true);
        expect((await keymaster.resolveDID(did)).didDocument!.service).toBeUndefined();
        expect(await keysOf()).toBeUndefined();
    });

    it('treats a refused unpublish reply as a failure', async () => {
        const did = await keymaster.createId('Bob');
        await keymaster.addLightning();
        await keymaster.publishLightning();
        emptyWallet();
        gatekeeper.unpublishLightning = () => Promise.resolve(false);

        await expect(keymaster.unpublishLightning()).rejects.toThrow('Drawbridge did not unpublish the DID');
        await expect(keymaster.removeLightning()).rejects.toThrow(LightningStateError);
        expect(await keysOf()).toBeDefined();
        expect((await keymaster.resolveDID(did)).didDocument!.service).toHaveLength(1);

        expect(await keymaster.removeLightning(undefined, true)).toBe(true);
        expect(await keysOf()).toBeUndefined();
    });

    it('keeps a wallet added while an overlapping removal was in progress', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();
        emptyWallet();
        const unpublish = gatekeeper.unpublishLightning;
        gatekeeper.createLightningWallet = () =>
            Promise.resolve({ walletId: 'w2', adminKey: 'admin2', invoiceKey: 'invoice2' });
        gatekeeper.unpublishLightning = async () => {
            gatekeeper.unpublishLightning = unpublish;
            await keymaster.removeLightning();
            await keymaster.addLightning();
            return true;
        };

        await expect(keymaster.removeLightning()).rejects.toThrow('replaced during removal');

        expect(await keysOf()).toStrictEqual({
            'http://test-drawbridge': { walletId: 'w2', adminKey: 'admin2', invoiceKey: 'invoice2' },
        });
    });

    it('succeeds when an overlapping removal took the wallet first', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();
        emptyWallet();
        const unpublish = gatekeeper.unpublishLightning;
        gatekeeper.unpublishLightning = async () => {
            gatekeeper.unpublishLightning = unpublish;
            await keymaster.removeLightning();
            return true;
        };

        expect(await keymaster.removeLightning()).toBe(true);

        expect(await keysOf()).toBeUndefined();
    });

    it('force discards a funded wallet and unpublishes it', async () => {
        const did = await keymaster.createId('Bob');
        await keymaster.addLightning();
        await keymaster.publishLightning();
        calls = [];

        expect(await keymaster.removeLightning(undefined, true)).toBe(true);

        expect(calls.some(call => call.method === 'getLightningBalance')).toBe(false);
        expect(calls.some(call => call.method === 'unpublishLightning')).toBe(true);
        expect((await keymaster.resolveDID(did)).didDocument!.service).toBeUndefined();
        expect(await keysOf()).toBeUndefined();
    });

    it('force discards the keys even if the DID update is rejected', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();
        await keymaster.publishLightning();
        gatekeeper.updateDID = () => Promise.resolve(false);

        expect(await keymaster.removeLightning(undefined, true)).toBe(true);

        expect(await keysOf()).toBeUndefined();
    });

    it('force works with the node unreachable, and unpublishing can follow without the keys', async () => {
        const did = await keymaster.createId('Bob');
        await keymaster.addLightning();
        await keymaster.publishLightning();

        const down = () => Promise.reject(new Error('node is down'));
        gatekeeper.getLightningBalance = down;
        gatekeeper.unpublishLightning = down;

        expect(await keymaster.removeLightning(undefined, true)).toBe(true);
        expect(await keysOf()).toBeUndefined();
        expect((await keymaster.resolveDID(did)).didDocument!.service).toHaveLength(1);

        gatekeeper.unpublishLightning = () => Promise.resolve(true);
        expect(await keymaster.unpublishLightning()).toBe(true);
        expect((await keymaster.resolveDID(did)).didDocument!.service).toBeUndefined();
    });

    it('force discards the wallets on every node, the old flat format, and without a Drawbridge', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();
        gatekeeper.url = 'http://other-drawbridge';
        await keymaster.addLightning();

        await keymaster.removeLightning(undefined, true);
        expect(await keysOf()).toBeUndefined();

        const walletData = await keymaster.loadWallet();
        walletData.ids.Bob.lightning = { walletId: 'w1', adminKey: 'admin1', invoiceKey: 'invoice1' };
        await keymaster.saveWallet(walletData, true);
        gatekeeper.createLightningWallet = undefined;

        await keymaster.removeLightning(undefined, true);
        expect(await keysOf()).toBeUndefined();
    });

    it.each(['true', 1, {}])('does not take %p for force', async (force) => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();

        await expect(keymaster.removeLightning(undefined, force as never)).rejects.toThrow(LightningStateError);

        expect(await keysOf()).toBeDefined();
    });

    it('acts on the named identity, not the current one', async () => {
        await keymaster.createId('Alice');
        await keymaster.addLightning();
        await keymaster.createId('Bob');
        await keymaster.addLightning();
        emptyWallet();

        await keymaster.removeLightning('Alice');

        expect(await keysOf('Alice')).toBeUndefined();
        expect(await keysOf('Bob')).toBeDefined();
    });

    it('removes an empty wallet from a revoked identity with no DID update', async () => {
        const did = await keymaster.createId('Bob');
        await keymaster.addLightning();
        emptyWallet();
        await keymaster.revokeDID(did);

        expect(await keymaster.removeLightning()).toBe(true);
        expect(await keysOf()).toBeUndefined();
    });
});

describe('removing an identity holding Lightning keys', () => {
    it('removeId refuses, whichever node the keys are for, until they are removed', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();
        gatekeeper.url = 'http://other-drawbridge';

        await expect(keymaster.removeId('Bob')).rejects.toThrow(LightningStateError);
        expect((await keymaster.loadWallet()).ids.Bob).toBeDefined();

        await keymaster.removeLightning('Bob', true);

        expect(await keymaster.removeId('Bob')).toBe(true);
    });

    it('fixWallet keeps a revoked identity holding keys, and reports it', async () => {
        const did = await keymaster.createId('Bob');
        await keymaster.addLightning();
        const dave = await keymaster.createId('Dave');
        await keymaster.revokeDID(did);
        await keymaster.revokeDID(dave);

        const result = await keymaster.fixWallet();

        expect(result).toMatchObject({ idsRemoved: 1, idsKept: ['Bob'] });
        const { ids } = await keymaster.loadWallet();
        expect(ids.Bob.lightning).toBeDefined();
        expect(ids.Dave).toBeUndefined();
    });

    it('an identity whose wallet entry is empty has no keys to protect', async () => {
        await keymaster.createId('Bob');
        const walletData = await keymaster.loadWallet();
        walletData.ids.Bob.lightning = {};
        await keymaster.saveWallet(walletData, true);

        expect(await keymaster.removeId('Bob')).toBe(true);
    });
});

describe('getLightningBalance', () => {
    it('should return balance from gateway', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();

        const result = await keymaster.getLightningBalance();

        expect(result.balance).toBe(1000);

        const balanceCalls = calls.filter(c => c.method === 'getLightningBalance');
        expect(balanceCalls.length).toBe(1);
        expect(balanceCalls[0].args).toStrictEqual(['invoice1']);
    });

    it('should return balance for old flat format wallet', async () => {
        await keymaster.createId('Bob');

        // Manually inject old flat format
        const walletData = await keymaster.loadWallet();
        const bobInfo = Object.values(walletData.ids).find(id => id.did)!;
        bobInfo.lightning = { walletId: 'w1', adminKey: 'admin1', invoiceKey: 'invoice1' };
        await keymaster.saveWallet(walletData, true);

        const result = await keymaster.getLightningBalance();
        expect(result.balance).toBe(1000);
    });

    it('should throw when Lightning not configured', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.getLightningBalance();
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(LightningNotConfiguredError.type);
        }
    });

    it('should throw when Lightning configured on different URL', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();

        // Switch to a different Drawbridge URL
        gatekeeper.url = 'http://other-drawbridge';

        try {
            await keymaster.getLightningBalance();
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(LightningNotConfiguredError.type);
        }
    });
});

describe('createLightningInvoice', () => {
    it('should create an invoice via gateway', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();

        const invoice = await keymaster.createLightningInvoice(100, 'test payment');

        expect(invoice.paymentRequest).toBe('lnbc100...');
        expect(invoice.paymentHash).toBe('hash123');
    });

    it('should throw for invalid amount', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.createLightningInvoice(0, 'test');
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe('Invalid parameter');
        }
    });


    it('should throw when Lightning not configured', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.createLightningInvoice(100, 'test');
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(LightningNotConfiguredError.type);
        }
    });
});

describe('payLightningInvoice', () => {
    it('should pay an invoice via gateway', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();

        const payment = await keymaster.payLightningInvoice('lnbc100...');

        expect(payment.paymentHash).toBe('out-hash');

        const payCalls = calls.filter(c => c.method === 'payLightningInvoice');
        expect(payCalls.length).toBe(1);
        expect(payCalls[0].args).toStrictEqual(['admin1', 'lnbc100...']);
    });

    it('should throw for empty bolt11', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.payLightningInvoice('');
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe('Invalid parameter');
        }
    });

    it('should throw when Lightning not configured', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.payLightningInvoice('lnbc100...');
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(LightningNotConfiguredError.type);
        }
    });
});

describe('checkLightningPayment', () => {
    it('should check payment status via gateway', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();

        const status = await keymaster.checkLightningPayment('hash123');

        expect(status.paid).toBe(true);
        expect(status.preimage).toBe('preimage123');
        expect(status.paymentHash).toBe('hash123');
    });

    it('should throw for empty payment hash', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.checkLightningPayment('');
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe('Invalid parameter');
        }
    });

    it('should throw when Lightning not configured', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.checkLightningPayment('hash123');
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(LightningNotConfiguredError.type);
        }
    });
});

// BOLT11 test vectors from the spec (https://github.com/lightning/bolts/blob/master/11-payment-encoding.md)
const COFFEE_INVOICE = 'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh';
const DONATION_INVOICE = 'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';

describe('decodeLightningInvoice', () => {
    it('should decode a coffee invoice with amount and expiry', async () => {
        const info = await keymaster.decodeLightningInvoice(COFFEE_INVOICE);

        expect(info.amount).toBe('250000 sats');
        expect(info.description).toBe('1 cup coffee');
        expect(info.payment_hash).toBe('0001020304050607080900010203040506070809000102030405060708090102');
        expect(info.expiry).toBe('60 seconds');
        expect(info.network).toBe('bc');
        expect(info.created).toBeDefined();
        expect(info.expires).toBeDefined();
    });

    it('should decode a donation invoice with no amount', async () => {
        const info = await keymaster.decodeLightningInvoice(DONATION_INVOICE);

        expect(info.amount).toBeUndefined();
        expect(info.description).toBe('Please consider supporting this project');
        expect(info.payment_hash).toBe('0001020304050607080900010203040506070809000102030405060708090102');
        expect(info.network).toBe('bc');
    });

    it('should compute expires from timestamp + expiry', async () => {
        const info = await keymaster.decodeLightningInvoice(COFFEE_INVOICE);

        const expectedExpires = new Date((1496314658 + 60) * 1000).toISOString();
        expect(info.expires).toBe(expectedExpires);
    });

    it('should not set expires when no expiry in invoice', async () => {
        const info = await keymaster.decodeLightningInvoice(DONATION_INVOICE);

        expect(info.expiry).toBeUndefined();
        expect(info.expires).toBeUndefined();
    });

    it('should throw for empty bolt11', async () => {
        try {
            await keymaster.decodeLightningInvoice('');
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(InvalidParameterError.type);
        }
    });

    it('should throw for invalid bolt11 string', async () => {
        await expect(keymaster.decodeLightningInvoice('not-a-valid-invoice')).rejects.toThrow();
    });
});

describe('publishLightning', () => {
    it('should register invoiceKey and add service endpoint to DID doc', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();

        const ok = await keymaster.publishLightning();
        expect(ok).toBe(true);

        // Check that publishLightning was called on drawbridge with DID suffix and invoiceKey
        const publishCalls = calls.filter(c => c.method === 'publishLightning');
        expect(publishCalls.length).toBe(1);
        expect(publishCalls[0].args[1]).toBe('invoice1');

        // Check that DID document has service endpoint
        const doc = await keymaster.resolveDID('Bob');
        expect(doc.didDocument!.service).toBeDefined();
        expect(doc.didDocument!.service!.length).toBe(1);
        expect(doc.didDocument!.service![0].type).toBe('Lightning');
        expect(doc.didDocument!.service![0].serviceEndpoint).toContain('/invoice/');
    });

    it('should throw when Lightning wallet not configured', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.publishLightning();
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(LightningNotConfiguredError.type);
        }
    });

    it('should use publicHost from Drawbridge when available', async () => {
        gatekeeper.publishLightning = (did: string, invoiceKey: string) => {
            trackCall('publishLightning', did, invoiceKey);
            return Promise.resolve({ ok: true, publicHost: 'http://abc123.onion:4222' });
        };

        await keymaster.createId('Bob');
        await keymaster.addLightning();
        await keymaster.publishLightning();

        const doc = await keymaster.resolveDID('Bob');
        expect(doc.didDocument!.service![0].serviceEndpoint).toMatch(/^http:\/\/abc123\.onion:4222\/invoice\//);
    });

    it('should replace existing lightning service on re-publish', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();

        await keymaster.publishLightning();
        await keymaster.publishLightning();

        const doc = await keymaster.resolveDID('Bob');
        expect(doc.didDocument!.service!.length).toBe(1);
    });
});

describe('unpublishLightning', () => {
    it('should remove service endpoint from DID doc', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();
        await keymaster.publishLightning();

        const ok = await keymaster.unpublishLightning();
        expect(ok).toBe(true);

        // Check that unpublishLightning was called on drawbridge
        const unpublishCalls = calls.filter(c => c.method === 'unpublishLightning');
        expect(unpublishCalls.length).toBe(1);

        // Check that DID document no longer has service endpoint
        const doc = await keymaster.resolveDID('Bob');
        expect(doc.didDocument!.service).toBeUndefined();
    });

    it('should succeed even if not published', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();

        const ok = await keymaster.unpublishLightning();
        expect(ok).toBe(true);
    });
});

describe('lightning routes with a missing required field', () => {
    function app() {
        const server = express();
        server.use(express.json());
        server.use(createLightningRouter({ getKeymaster: () => keymaster } as any));
        return server;
    }

    const REQUIRED: Array<[string, object, string]> = [
        ['/lightning/invoice', { memo: 'coffee' }, 'amount'],
        ['/lightning/pay', { id: 'Bob' }, 'bolt11'],
        ['/lightning/payment', { id: 'Bob' }, 'paymentHash'],
        ['/lightning/decode', {}, 'bolt11'],
        ['/lightning/zap', { amount: 100 }, 'did'],
        ['/lightning/zap', { did: 'NotAKnownAlias' }, 'amount'],
    ];

    it.each(REQUIRED)('%s answers 400 for %j', async (path, body, field) => {
        const response = await request(app()).post(path).send(body);

        expect(response.status).toBe(400);
        expect(response.body.error).toContain(`Invalid parameter: ${field}`);
    });

    it.each([
        ['/lightning/invoice', 'amount'],
        ['/lightning/pay', 'bolt11'],
        ['/lightning/payment', 'paymentHash'],
        ['/lightning/decode', 'bolt11'],
        ['/lightning/zap', 'did'],
    ])('%s answers 400 with no body, naming %s', async (path, field) => {
        const response = await request(app()).post(path);

        expect(response.status).toBe(400);
        expect(response.body.error).toContain(`Invalid parameter: ${field}`);
    });
});

describe('zapLightning', () => {
    it('should throw for missing did', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.zapLightning('', 100);
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(InvalidParameterError.type);
            expect(error.detail).toBe('did');
        }
    });

    it('should report a missing amount before looking up the did', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.zapLightning('NotAKnownAlias', 0);
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(InvalidParameterError.type);
            expect(error.detail).toBe('amount');
        }
    });

    it('should throw for invalid amount', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.zapLightning('did:cid:test', 0);
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(InvalidParameterError.type);
        }
    });

    it('should delegate to drawbridge zapLightning', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();
        await keymaster.createId('Alice');
        const aliceDoc = await keymaster.resolveDID('Alice');
        const aliceDid = aliceDoc.didDocument!.id!;

        await keymaster.setCurrentId('Bob');
        const result = await keymaster.zapLightning('Alice', 100);
        expect(result.paymentHash).toBe('zap-hash');

        // Verify zapLightning was called on drawbridge with resolved DID
        const zapCalls = calls.filter(c => c.method === 'zapLightning');
        expect(zapCalls.length).toBe(1);
        expect(zapCalls[0].args[0]).toBe('admin1'); // adminKey
        expect(zapCalls[0].args[1]).toBe(aliceDid); // resolved DID from alias
        expect(zapCalls[0].args[2]).toBe(100); // amount
        expect(zapCalls[0].args[3]).toBeUndefined(); // no memo
    });

    it('should pass memo to drawbridge zapLightning', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();
        await keymaster.createId('Alice');

        await keymaster.setCurrentId('Bob');
        await keymaster.zapLightning('Alice', 50, 'thanks for the coffee');

        const zapCalls = calls.filter(c => c.method === 'zapLightning');
        expect(zapCalls[0].args[2]).toBe(50);
        expect(zapCalls[0].args[3]).toBe('thanks for the coffee');
    });

    it('should pass LUD-16 address directly without lookupDID', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();

        const result = await keymaster.zapLightning('alice@example.com', 21, 'hi');
        expect(result.paymentHash).toBe('zap-hash');

        const zapCalls = calls.filter(c => c.method === 'zapLightning');
        expect(zapCalls.length).toBe(1);
        expect(zapCalls[0].args[1]).toBe('alice@example.com'); // passed through as-is
        expect(zapCalls[0].args[2]).toBe(21);
        expect(zapCalls[0].args[3]).toBe('hi');
    });
});

describe('getLightningPayments', () => {
    it('should return payments from drawbridge', async () => {
        await keymaster.createId('Bob');
        await keymaster.addLightning();

        const result = await keymaster.getLightningPayments();
        expect(result).toStrictEqual([
            { paymentHash: 'hash1', amount: 100, fee: 0, memo: 'received', time: '2023-11-14T22:13:20+00:00', pending: false },
        ]);
    });

    it('should throw when Lightning not configured', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.getLightningPayments();
            throw new Error('Expected exception');
        } catch (error: any) {
            expect(error.type).toBe(LightningNotConfiguredError.type);
        }
    });
});

describe('Lightning without Drawbridge', () => {
    it('should throw when gatekeeper has no Lightning methods', async () => {
        const db = new DbJsonMemory('test');
        const plainGatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm', 'BTC:signet'] });
        const plainKeymaster = new Keymaster({
            gatekeeper: plainGatekeeper, wallet, cipher, passphrase: 'passphrase',
        });
        await plainKeymaster.loadOrCreateWallet();

        await plainKeymaster.createId('Bob');

        try {
            await plainKeymaster.addLightning();
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(LightningUnavailableError.type);
        }
    });
});
