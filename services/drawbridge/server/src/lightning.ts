import axios from 'axios';
import https from 'https';
import { randomBytes } from 'crypto';
import { LightningUnavailableError } from './errors.js';
import type { ClnConfig, LightningInvoice, LightningPaymentResult } from './types.js';

// CLN REST uses a self-signed certificate
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

export async function createInvoice(
    config: ClnConfig,
    amountSat: number,
    memo: string
): Promise<LightningInvoice> {
    if (!config.rune) {
        throw new LightningUnavailableError('CLN rune is not configured');
    }

    const label = `drawbridge-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const amountMsat = amountSat * 1000;

    try {
    const response = await axios.post(
        `${config.restUrl}/v1/invoice`,
        {
            amount_msat: amountMsat,
            label,
            description: memo,
        },
        {
            headers: {
                'Rune': config.rune,
                'Content-Type': 'application/json',
            },
            httpsAgent,
        }
    );

    const data = response.data;

    return {
        paymentRequest: data.bolt11,
        paymentHash: data.payment_hash,
        amountSat,
        expiry: data.expires_at ? data.expires_at - Math.floor(Date.now() / 1000) : 3600,
        label,
    };
    } catch (error: any) {
        if (error instanceof LightningUnavailableError) throw error;
        throw new LightningUnavailableError(error.code || error.message);
    }
}

export async function checkInvoice(
    config: ClnConfig,
    paymentHash: string
): Promise<LightningPaymentResult> {
    const response = await axios.post(
        `${config.restUrl}/v1/listinvoices`,
        {
            payment_hash: paymentHash,
        },
        {
            headers: {
                'Rune': config.rune,
                'Content-Type': 'application/json',
            },
            httpsAgent,
        }
    );

    const invoices = response.data.invoices || [];
    const invoice = invoices.find((inv: any) => inv.payment_hash === paymentHash);

    if (!invoice) {
        return { paid: false, paymentHash };
    }

    return {
        paid: invoice.status === 'paid',
        preimage: invoice.payment_preimage,
        paymentHash: invoice.payment_hash,
        amountSat: invoice.amount_msat ? Math.floor(invoice.amount_msat / 1000) : undefined,
    };
}
