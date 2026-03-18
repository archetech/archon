import axios from 'axios';
import { LightningPaymentError, LightningUnavailableError } from './errors.js';

/** Throw LightningPaymentError for business-logic errors or LightningUnavailableError for infra/auth errors. */
function throwLnbitsError(error: any): never {
    const detail = error.response?.data?.detail || error.code || error.message;
    const status = error.response?.status;
    // 400/402/409 = business logic (bad request, payment failed, already paid)
    // 401/403/404 = misconfiguration (bad key, wrong URL) → treat as unavailable
    if (status === 400 || status === 402 || status === 409) {
        throw new LightningPaymentError(String(detail));
    }
    throw new LightningUnavailableError(String(detail));
}

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
        throwLnbitsError(error);
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
        // LNbits returns balance in msats (field is "balance" or "balance_msat")
        const msats = response.data.balance ?? response.data.balance_msat ?? 0;
        return Math.floor(msats / 1000);
    } catch (error: any) {
        throwLnbitsError(error);
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
        throwLnbitsError(error);
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
        throwLnbitsError(error);
    }
}

/** Get payment history. Uses adminKey to see both incoming and outgoing. */
export async function getPayments(
    url: string,
    adminKey: string
): Promise<Array<{ paymentHash: string; amount: number; fee: number; memo: string; time: string; pending: boolean; status: 'success' | 'pending' | 'failed'; expiry?: number }>> {
    try {
        const response = await axios.get(`${url}/api/v1/payments`, {
            headers: { 'X-Api-Key': adminKey },
        });
        return (response.data || [])
            .map((p: any) => {
                const status = p.status === 'success' ? 'success'
                    : p.status === 'failed' ? 'failed'
                        : 'pending';
                return {
                    paymentHash: p.payment_hash || p.checking_id || '',
                    amount: Math.floor((p.amount || 0) / 1000),
                    fee: Math.floor(Math.abs(p.fee || 0) / 1000),
                    memo: p.memo || '',
                    time: p.time || '',
                    pending: status === 'pending',
                    status,
                    expiry: p.expiry ?? undefined,
                };
            });
    } catch (error: any) {
        throwLnbitsError(error);
    }
}

/** Check payment status by payment hash. Uses invoiceKey. */
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
        // Preimage may not be immediately available after payment settles
        if (result.paid && !result.preimage) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return doCheck();
        }
        return result;
    } catch (error: any) {
        throwLnbitsError(error);
    }
}
