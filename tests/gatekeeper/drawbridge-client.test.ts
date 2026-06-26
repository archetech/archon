import nock from 'nock';
import DrawbridgeClient from '@didcid/gatekeeper/drawbridge';
import { ExpectedExceptionError } from '@didcid/common/errors';

const DrawbridgeURL = 'http://drawbridge.org';
const ServerError = { message: 'Server error' };
const Endpoints = {
    lightning: {
        supported: '/api/v1/lightning/supported',
        wallet: '/api/v1/lightning/wallet',
        balance: '/api/v1/lightning/balance',
        invoice: '/api/v1/lightning/invoice',
        pay: '/api/v1/lightning/pay',
        payment: '/api/v1/lightning/payment',
        publish: '/api/v1/lightning/publish',
        payments: '/api/v1/lightning/payments',
        zap: '/api/v1/lightning/zap',
    },
    didcommEndpoint: '/api/v1/didcomm-endpoint',
};

describe('DrawbridgeClient', () => {
    it('creates a connected client', async () => {
        const client = await DrawbridgeClient.create({ url: DrawbridgeURL });

        expect(client).toBeInstanceOf(DrawbridgeClient);
        expect(client.url).toBe(DrawbridgeURL);
    });

    it('returns lightning support status and treats failures as unsupported', async () => {
        nock(DrawbridgeURL)
            .get(Endpoints.lightning.supported)
            .reply(200, { supported: true })
            .get(Endpoints.lightning.supported)
            .reply(200, { supported: false })
            .get(Endpoints.lightning.supported)
            .reply(500, ServerError);

        const client = await DrawbridgeClient.create({ url: DrawbridgeURL });

        expect(await client.isLightningSupported()).toBe(true);
        expect(await client.isLightningSupported()).toBe(false);
        expect(await client.isLightningSupported()).toBe(false);
    });

    it('creates a lightning wallet', async () => {
        nock(DrawbridgeURL)
            .post(Endpoints.lightning.wallet, { name: 'Alice' })
            .reply(200, { walletId: 'wallet', adminKey: 'admin', invoiceKey: 'invoice' });

        const client = await DrawbridgeClient.create({ url: DrawbridgeURL });

        expect(await client.createLightningWallet('Alice')).toStrictEqual({
            walletId: 'wallet',
            adminKey: 'admin',
            invoiceKey: 'invoice',
        });
    });

    it('fetches lightning balance, invoice, payment status, and payment history', async () => {
        nock(DrawbridgeURL)
            .post(Endpoints.lightning.balance, { invoiceKey: 'invoice' })
            .reply(200, { balance: 123 })
            .post(Endpoints.lightning.invoice, { invoiceKey: 'invoice', amount: 21, memo: 'coffee' })
            .reply(200, { paymentRequest: 'lnbc...', paymentHash: 'hash' })
            .post(Endpoints.lightning.payment, { invoiceKey: 'invoice', paymentHash: 'hash' })
            .reply(200, { paid: true, paymentHash: 'hash', status: 'success' })
            .post(Endpoints.lightning.payments, { adminKey: 'admin' })
            .reply(200, { payments: [{ paymentHash: 'hash', amount: 21, fee: 0, memo: 'coffee', time: '2026-01-01T00:00:00.000Z', pending: false, status: 'success' }] });

        const client = await DrawbridgeClient.create({ url: DrawbridgeURL });

        expect(await client.getLightningBalance('invoice')).toStrictEqual({ balance: 123 });
        expect(await client.createLightningInvoice('invoice', 21, 'coffee')).toStrictEqual({ paymentRequest: 'lnbc...', paymentHash: 'hash' });
        expect(await client.checkLightningPayment('invoice', 'hash')).toStrictEqual({ paid: true, paymentHash: 'hash', status: 'success' });
        expect(await client.getLightningPayments('admin')).toStrictEqual([
            { paymentHash: 'hash', amount: 21, fee: 0, memo: 'coffee', time: '2026-01-01T00:00:00.000Z', pending: false, status: 'success' },
        ]);
    });

    it('pays invoices and zaps DIDs', async () => {
        nock(DrawbridgeURL)
            .post(Endpoints.lightning.pay, { adminKey: 'admin', bolt11: 'lnbc...' })
            .reply(200, { paymentHash: 'paid-hash' })
            .post(Endpoints.lightning.zap, { adminKey: 'admin', did: 'did:cid:alice', amount: 21, memo: 'zap' })
            .reply(200, { paymentHash: 'zap-hash' });

        const client = await DrawbridgeClient.create({ url: DrawbridgeURL });

        expect(await client.payLightningInvoice('admin', 'lnbc...')).toStrictEqual({ paymentHash: 'paid-hash' });
        expect(await client.zapLightning('admin', 'did:cid:alice', 21, 'zap')).toStrictEqual({ paymentHash: 'zap-hash' });
    });

    it('publishes and unpublishes lightning service endpoints', async () => {
        nock(DrawbridgeURL)
            .post(Endpoints.lightning.publish, { did: 'did:cid:alice', invoiceKey: 'invoice' })
            .reply(200, { ok: true, publicHost: 'https://example.com' })
            .delete(`${Endpoints.lightning.publish}/did%3Acid%3Aalice`)
            .reply(200, { ok: true });

        const client = await DrawbridgeClient.create({ url: DrawbridgeURL });

        expect(await client.publishLightning('did:cid:alice', 'invoice')).toStrictEqual({ ok: true, publicHost: 'https://example.com' });
        expect(await client.unpublishLightning('did:cid:alice')).toBe(true);
    });

    it('returns the DIDComm endpoint when available and undefined otherwise', async () => {
        nock(DrawbridgeURL)
            .get(Endpoints.didcommEndpoint)
            .reply(200, { endpoint: 'https://example.com/didcomm' })
            .get(Endpoints.didcommEndpoint)
            .reply(200, {})
            .get(Endpoints.didcommEndpoint)
            .reply(500, ServerError);

        const client = await DrawbridgeClient.create({ url: DrawbridgeURL });

        expect(await client.getDidCommEndpoint()).toBe('https://example.com/didcomm');
        expect(await client.getDidCommEndpoint()).toBeUndefined();
        expect(await client.getDidCommEndpoint()).toBeUndefined();
    });

    it('throws response data for lightning API errors', async () => {
        nock(DrawbridgeURL)
            .post(Endpoints.lightning.wallet, { name: 'Alice' })
            .reply(500, ServerError);

        const client = await DrawbridgeClient.create({ url: DrawbridgeURL });

        try {
            await client.createLightningWallet('Alice');
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe(ServerError.message);
        }
    });
});
