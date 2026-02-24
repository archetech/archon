import { createHash } from 'crypto';
import { checkInvoice, verifyPreimage } from './lightning.js';
import { redeemCashuToken } from './cashu.js';
import { PaymentVerificationError } from './errors.js';
import type { L402MiddlewareOptions, PaymentVerificationResult } from './types.js';

export async function verifyPayment(
    options: L402MiddlewareOptions,
    method: 'lightning' | 'cashu',
    proof: string,
    expectedPaymentHash?: string
): Promise<PaymentVerificationResult> {
    if (method === 'lightning') {
        return verifyLightningPayment(options, proof, expectedPaymentHash);
    } else if (method === 'cashu') {
        return verifyCashuPayment(options, proof);
    }

    throw new PaymentVerificationError(`Unknown payment method: ${method}`);
}

async function verifyLightningPayment(
    options: L402MiddlewareOptions,
    preimage: string,
    expectedPaymentHash?: string
): Promise<PaymentVerificationResult> {
    if (!options.cln) {
        throw new PaymentVerificationError('Lightning not configured');
    }

    // Compute the payment hash from the preimage
    const computedHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');

    // If we have an expected payment hash, verify it matches
    if (expectedPaymentHash && computedHash !== expectedPaymentHash) {
        throw new PaymentVerificationError('Preimage does not match payment hash');
    }

    // Verify the invoice was actually paid
    const result = await checkInvoice(options.cln, computedHash);

    if (!result.paid) {
        throw new PaymentVerificationError('Invoice not paid');
    }

    // Double-check the preimage if the invoice returned one
    if (result.preimage && !verifyPreimage(result.preimage, computedHash)) {
        throw new PaymentVerificationError('Invoice preimage mismatch');
    }

    return {
        method: 'lightning',
        verified: true,
        paymentHash: computedHash,
        amountSat: result.amountSat || 0,
    };
}

/**
 * Redeems a Cashu token at the mint (atomically prevents double-spend) and returns
 * verification result. Uses redeemCashuToken, not verifyCashuToken, to ensure
 * the token is actually consumed.
 */
async function verifyCashuPayment(
    options: L402MiddlewareOptions,
    tokenStr: string
): Promise<PaymentVerificationResult> {
    if (!options.cashu) {
        throw new PaymentVerificationError('Cashu not configured');
    }

    const redemption = await redeemCashuToken(options.cashu, tokenStr);

    // Derive a payment hash from the Cashu token for tracking
    const paymentHash = createHash('sha256').update(tokenStr).digest('hex');

    return {
        method: 'cashu',
        verified: true,
        paymentHash,
        amountSat: redemption.amount,
    };
}
