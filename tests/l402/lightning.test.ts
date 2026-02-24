import nock from 'nock';
import { createInvoice, checkInvoice, verifyPreimage } from '../../packages/l402/src/lightning.js';
import { MOCK_CLN_CONFIG, generateTestPreimage, createMockClnInvoiceResponse, createMockClnListInvoicesResponse } from './helper.js';

describe('L402 Lightning', () => {

    afterEach(() => {
        nock.cleanAll();
    });

    describe('createInvoice', () => {
        it('should create a Lightning invoice via CLN REST', async () => {
            const { paymentHash } = generateTestPreimage();

            nock(MOCK_CLN_CONFIG.restUrl)
                .post('/v1/invoice')
                .reply(200, createMockClnInvoiceResponse(paymentHash));

            const invoice = await createInvoice(MOCK_CLN_CONFIG, 100, 'test invoice');

            expect(invoice.paymentRequest).toBe('lnbc1000n1pjtest...');
            expect(invoice.paymentHash).toBe(paymentHash);
            expect(invoice.amountSat).toBe(100);
            expect(invoice.label).toMatch(/^l402-/);
        });

        it('should send correct amount in msats', async () => {
            const { paymentHash } = generateTestPreimage();

            nock(MOCK_CLN_CONFIG.restUrl)
                .post('/v1/invoice', (body: any) => {
                    return body.amount_msat === 50000; // 50 sats * 1000
                })
                .reply(200, createMockClnInvoiceResponse(paymentHash));

            const invoice = await createInvoice(MOCK_CLN_CONFIG, 50, 'test');
            expect(invoice.amountSat).toBe(50);
        });

        it('should include Rune auth header', async () => {
            const { paymentHash } = generateTestPreimage();

            nock(MOCK_CLN_CONFIG.restUrl)
                .post('/v1/invoice')
                .matchHeader('Rune', MOCK_CLN_CONFIG.rune)
                .reply(200, createMockClnInvoiceResponse(paymentHash));

            await createInvoice(MOCK_CLN_CONFIG, 100, 'test');
        });

        it('should throw on CLN error', async () => {
            nock(MOCK_CLN_CONFIG.restUrl)
                .post('/v1/invoice')
                .reply(500, { error: 'Internal error' });

            await expect(createInvoice(MOCK_CLN_CONFIG, 100, 'test')).rejects.toThrow();
        });
    });

    describe('checkInvoice', () => {
        it('should return paid status for a paid invoice', async () => {
            const { preimage, paymentHash } = generateTestPreimage();

            nock(MOCK_CLN_CONFIG.restUrl)
                .post('/v1/listinvoices')
                .reply(200, createMockClnListInvoicesResponse(paymentHash, true, preimage));

            const result = await checkInvoice(MOCK_CLN_CONFIG, paymentHash);

            expect(result.paid).toBe(true);
            expect(result.preimage).toBe(preimage);
            expect(result.paymentHash).toBe(paymentHash);
        });

        it('should return unpaid status for an unpaid invoice', async () => {
            const { paymentHash } = generateTestPreimage();

            nock(MOCK_CLN_CONFIG.restUrl)
                .post('/v1/listinvoices')
                .reply(200, createMockClnListInvoicesResponse(paymentHash, false));

            const result = await checkInvoice(MOCK_CLN_CONFIG, paymentHash);

            expect(result.paid).toBe(false);
        });

        it('should return not paid when invoice not found', async () => {
            const { paymentHash } = generateTestPreimage();

            nock(MOCK_CLN_CONFIG.restUrl)
                .post('/v1/listinvoices')
                .reply(200, { invoices: [] });

            const result = await checkInvoice(MOCK_CLN_CONFIG, paymentHash);

            expect(result.paid).toBe(false);
        });
    });

    describe('verifyPreimage', () => {
        it('should verify a correct preimage', () => {
            const { preimage, paymentHash } = generateTestPreimage();
            expect(verifyPreimage(preimage, paymentHash)).toBe(true);
        });

        it('should reject an incorrect preimage', () => {
            const { paymentHash } = generateTestPreimage();
            const wrongPreimage = '0'.repeat(64);
            expect(verifyPreimage(wrongPreimage, paymentHash)).toBe(false);
        });
    });
});
