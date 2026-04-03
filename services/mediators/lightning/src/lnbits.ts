import axios from 'axios';

import { LightningPaymentError, LightningUnavailableError } from './errors.js';
import type { LnbitsPayment, LnbitsWallet } from './types.js';

function throwLnbitsError(error: any): never {
    const detail = error.response?.data?.detail || error.code || error.message;
    const status = error.response?.status;
    if (status === 400 || status === 402 || status === 409) {
        throw new LightningPaymentError(String(detail));
    }
    throw new LightningUnavailableError(String(detail));
}

export async function createWallet(
    url: string,
    walletName: string
): Promise<LnbitsWallet> {
    try {
        const response = await axios.post(`${url}/api/v1/account`, { name: walletName });
        return {
            walletId: response.data.id,
            adminKey: response.data.adminkey,
            invoiceKey: response.data.inkey,
        };
    } catch (error: any) {
        throwLnbitsError(error);
    }
}

export async function getBalance(
    url: string,
    invoiceKey: string
): Promise<number> {
    try {
        const response = await axios.get(`${url}/api/v1/wallet`, {
            headers: { 'X-Api-Key': invoiceKey },
        });
        const msats = response.data.balance ?? response.data.balance_msat ?? 0;
        return Math.floor(msats / 1000);
    } catch (error: any) {
        throwLnbitsError(error);
    }
}

export async function createInvoice(
    url: string,
    invoiceKey: string,
    amount: number,
    memo: string
): Promise<{ paymentRequest: string; paymentHash: string }> {
    try {
        const response = await axios.post(
            `${url}/api/v1/payments`,
            { out: false, amount, memo },
            { headers: { 'X-Api-Key': invoiceKey } }
        );
        return {
            paymentRequest: response.data.payment_request,
            paymentHash: response.data.payment_hash,
        };
    } catch (error: any) {
        throwLnbitsError(error);
    }
}

export async function payInvoice(
    url: string,
    adminKey: string,
    bolt11: string
): Promise<{ paymentHash: string }> {
    try {
        const response = await axios.post(
            `${url}/api/v1/payments`,
            { out: true, bolt11 },
            { headers: { 'X-Api-Key': adminKey } }
        );
        return {
            paymentHash: response.data.payment_hash,
        };
    } catch (error: any) {
        throwLnbitsError(error);
    }
}

export async function getPayments(
    url: string,
    adminKey: string
): Promise<LnbitsPayment[]> {
    try {
        const response = await axios.get(`${url}/api/v1/payments/paginated`, {
            headers: { 'X-Api-Key': adminKey },
            params: {
                limit: 100,
                sortby: 'time',
                direction: 'desc',
            },
        });

        const payments = Array.isArray(response.data)
            ? response.data
            : Array.isArray(response.data?.data)
                ? response.data.data
                : [];

        return payments.map((payment: any) => {
            const status = payment.status === 'success'
                ? 'success'
                : payment.status === 'failed'
                    ? 'failed'
                    : 'pending';

            return {
                paymentHash: payment.payment_hash || payment.checking_id || '',
                amount: Math.floor((payment.amount || 0) / 1000),
                fee: Math.floor(Math.abs(payment.fee || 0) / 1000),
                memo: payment.memo || '',
                time: payment.time || '',
                pending: status === 'pending',
                status,
                expiry: payment.expiry ?? undefined,
            };
        });
    } catch (error: any) {
        throwLnbitsError(error);
    }
}

export async function checkPayment(
    url: string,
    invoiceKey: string,
    paymentHash: string
): Promise<{ paid: boolean; preimage?: string }> {
    const doCheck = async () => {
        const response = await axios.get(
            `${url}/api/v1/payments/${paymentHash}`,
            { headers: { 'X-Api-Key': invoiceKey } }
        );
        return {
            paid: response.data.paid === true,
            preimage: response.data.preimage || undefined,
        };
    };

    try {
        const result = await doCheck();
        if (result.paid && !result.preimage) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return doCheck();
        }
        return result;
    } catch (error: any) {
        throwLnbitsError(error);
    }
}
