import nock from 'nock';
import { verifyPayment } from '../../packages/l402/src/payment.js';
import { PaymentVerificationError } from '../../packages/l402/src/errors.js';
import {
    createTestMiddlewareOptions,
    generateTestPreimage,
    MOCK_CLN_CONFIG,
    createMockClnListInvoicesResponse,
} from './helper.js';

describe('L402 Payment', () => {

    afterEach(() => {
        nock.cleanAll();
    });

    describe('verifyPayment - Lightning', () => {
        it('should verify a valid lightning payment', async () => {
            const { preimage, paymentHash } = generateTestPreimage();
            const options = createTestMiddlewareOptions();

            nock(MOCK_CLN_CONFIG.restUrl)
                .post('/v1/listinvoices')
                .reply(200, createMockClnListInvoicesResponse(paymentHash, true, preimage));

            const result = await verifyPayment(options, 'lightning', preimage, paymentHash);

            expect(result.method).toBe('lightning');
            expect(result.verified).toBe(true);
            expect(result.paymentHash).toBe(paymentHash);
        });

        it('should reject when preimage does not match payment hash', async () => {
            const options = createTestMiddlewareOptions();
            const { preimage } = generateTestPreimage();
            const wrongHash = 'a'.repeat(64);

            await expect(
                verifyPayment(options, 'lightning', preimage, wrongHash)
            ).rejects.toThrow(PaymentVerificationError);
        });

        it('should reject when invoice is not paid', async () => {
            const { preimage, paymentHash } = generateTestPreimage();
            const options = createTestMiddlewareOptions();

            nock(MOCK_CLN_CONFIG.restUrl)
                .post('/v1/listinvoices')
                .reply(200, createMockClnListInvoicesResponse(paymentHash, false));

            await expect(
                verifyPayment(options, 'lightning', preimage)
            ).rejects.toThrow(PaymentVerificationError);
        });

        it('should throw when lightning is not configured', async () => {
            const options = createTestMiddlewareOptions({ cln: undefined });

            await expect(
                verifyPayment(options, 'lightning', 'somepreimage')
            ).rejects.toThrow('Lightning not configured');
        });
    });

    describe('verifyPayment - Cashu', () => {
        it('should throw when cashu is not configured', async () => {
            const options = createTestMiddlewareOptions({ cashu: undefined });

            await expect(
                verifyPayment(options, 'cashu', 'sometoken')
            ).rejects.toThrow('Cashu not configured');
        });
    });

    describe('verifyPayment - Unknown method', () => {
        it('should throw for unknown payment method', async () => {
            const options = createTestMiddlewareOptions();

            await expect(
                verifyPayment(options, 'bitcoin' as any, 'proof')
            ).rejects.toThrow('Unknown payment method');
        });
    });
});
