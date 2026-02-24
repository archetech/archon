import axios from 'axios';
import { randomBytes } from 'crypto';
import type { ClnConfig, LightningInvoice, LightningPaymentResult } from './types.js';

export async function createInvoice(
    config: ClnConfig,
    amountSat: number,
    memo: string
): Promise<LightningInvoice> {
    const label = `l402-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const amountMsat = amountSat * 1000;

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

export async function waitInvoice(
    config: ClnConfig,
    label: string
): Promise<LightningPaymentResult> {
    const response = await axios.post(
        `${config.restUrl}/v1/waitinvoice`,
        {
            label,
        },
        {
            headers: {
                'Rune': config.rune,
                'Content-Type': 'application/json',
            },
        }
    );

    const data = response.data;

    return {
        paid: data.status === 'paid',
        preimage: data.payment_preimage,
        paymentHash: data.payment_hash,
        amountSat: data.amount_msat ? Math.floor(data.amount_msat / 1000) : undefined,
    };
}

// Re-export from macaroon.ts — single canonical implementation
export { verifyPreimage } from './macaroon.js';
