import axios from 'axios';
import { LightningUnavailableError } from './errors.js';

/** Create a new LNbits account with an initial wallet (one account per DID). */
export async function createWallet(
    url: string,
    walletName: string
): Promise<{ walletId: string; adminKey: string; invoiceKey: string }> {
    try {
        const response = await axios.post(
            `${url}/api/v1/account`,
            { name: walletName }
        );
        return {
            walletId: response.data.id,
            adminKey: response.data.adminkey,
            invoiceKey: response.data.inkey,
        };
    } catch (error: any) {
        const detail = error.response?.data?.detail || error.code || error.message;
        throw new LightningUnavailableError(String(detail));
    }
}

/** Get wallet balance in sats. Uses invoiceKey (read-only). */
export async function getBalance(
    url: string,
    invoiceKey: string
): Promise<number> {
    try {
        const response = await axios.get(`${url}/api/v1/wallet`, {
            headers: { 'X-Api-Key': invoiceKey },
        });
        // LNbits returns balance in millisats
        return Math.floor(response.data.balance / 1000);
    } catch (error: any) {
        const detail = error.response?.data?.detail || error.code || error.message;
        throw new LightningUnavailableError(String(detail));
    }
}

/** Create a Lightning invoice to receive sats. Uses invoiceKey. */
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
        const detail = error.response?.data?.detail || error.code || error.message;
        throw new LightningUnavailableError(String(detail));
    }
}

/** Pay a bolt11 invoice. Uses adminKey (spending key). */
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
        const detail = error.response?.data?.detail || error.code || error.message;
        throw new LightningUnavailableError(String(detail));
    }
}

/** Check payment status by payment hash. Uses invoiceKey. */
export async function checkPayment(
    url: string,
    invoiceKey: string,
    paymentHash: string
): Promise<{ paid: boolean; preimage?: string }> {
    try {
        const response = await axios.get(
            `${url}/api/v1/payments/${paymentHash}`,
            { headers: { 'X-Api-Key': invoiceKey } }
        );
        return {
            paid: response.data.paid === true,
            preimage: response.data.preimage,
        };
    } catch (error: any) {
        const detail = error.response?.data?.detail || error.code || error.message;
        throw new LightningUnavailableError(String(detail));
    }
}
