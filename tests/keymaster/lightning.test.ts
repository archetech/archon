import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import { UnknownIDError, LightningNotConfiguredError, LightningUnavailableError } from '@didcid/common/errors';
import HeliaClient from '@didcid/ipfs/helia';

let ipfs: HeliaClient;
let gatekeeper: any;
let wallet: WalletJsonMemory;
let cipher: CipherNode;
let keymaster: Keymaster;

let calls: Array<{ method: string; args: any[] }>;

function trackCall(method: string, ...args: any[]) {
    calls.push({ method, args });
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
    const baseGatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm', 'BTC:signet'] });
    wallet = new WalletJsonMemory();
    cipher = new CipherNode();

    calls = [];

    // Create a gatekeeper proxy that adds DrawbridgeInterface Lightning methods
    gatekeeper = Object.create(baseGatekeeper);

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

    keymaster = new Keymaster({
        gatekeeper, wallet, cipher, passphrase: 'passphrase',
    });
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

    it('should store credentials in wallet IDInfo', async () => {
        await keymaster.createId('Bob');

        await keymaster.addLightning();

        const walletData = await keymaster.loadWallet();
        const bobInfo = Object.values(walletData.ids).find(id => id.did);
        expect(bobInfo?.lightning).toStrictEqual({
            walletId: 'w1',
            adminKey: 'admin1',
            invoiceKey: 'invoice1',
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
});

describe('removeLightning', () => {
    it('should remove Lightning config from IDInfo', async () => {
        await keymaster.createId('Bob');

        await keymaster.addLightning();

        const ok = await keymaster.removeLightning();
        expect(ok).toBe(true);

        const walletData = await keymaster.loadWallet();
        const bobInfo = Object.values(walletData.ids).find(id => id.did);
        expect(bobInfo?.lightning).toBeUndefined();
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

    it('should throw for missing memo', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.createLightningInvoice(100, '');
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

describe('Lightning without Drawbridge', () => {
    it('should throw when gatekeeper has no Lightning methods', async () => {
        const db = new DbJsonMemory('test');
        const plainGatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm', 'BTC:signet'] });
        const plainKeymaster = new Keymaster({
            gatekeeper: plainGatekeeper, wallet, cipher, passphrase: 'passphrase',
        });

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
