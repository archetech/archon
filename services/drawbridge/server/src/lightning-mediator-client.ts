import { LightningUnavailableError } from './errors.js';
import type { LightningInvoice, LightningPaymentResult, PendingInvoiceData } from './types.js';

async function requestLightningMediator<T>(
    baseUrl: string,
    path: string,
    options: RequestInit
): Promise<T> {
    const response = await fetch(new URL(path, baseUrl), {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    });

    if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: response.statusText }));
        throw new LightningUnavailableError(
            String(errorBody.error || response.statusText || 'Lightning mediator request failed')
        );
    }

    return response.json() as Promise<T>;
}

export function createL402Invoice(
    baseUrl: string,
    amountSat: number,
    memo: string
): Promise<LightningInvoice> {
    return requestLightningMediator<LightningInvoice>(baseUrl, '/api/v1/l402/invoice', {
        method: 'POST',
        body: JSON.stringify({
            amountSat,
            memo,
        }),
    });
}

export function checkL402Invoice(
    baseUrl: string,
    paymentHash: string
): Promise<LightningPaymentResult> {
    return requestLightningMediator<LightningPaymentResult>(baseUrl, '/api/v1/l402/check', {
        method: 'POST',
        body: JSON.stringify({
            paymentHash,
        }),
    });
}

export function savePendingL402Invoice(
    baseUrl: string,
    pendingInvoice: PendingInvoiceData
): Promise<{ ok: boolean; paymentHash: string }> {
    return requestLightningMediator(baseUrl, '/api/v1/l402/pending', {
        method: 'POST',
        body: JSON.stringify(pendingInvoice),
    });
}

export async function getPendingL402Invoice(
    baseUrl: string,
    paymentHash: string
): Promise<PendingInvoiceData | null> {
    const response = await fetch(new URL(`/api/v1/l402/pending/${encodeURIComponent(paymentHash)}`, baseUrl));
    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: response.statusText }));
        throw new LightningUnavailableError(
            String(errorBody.error || response.statusText || 'Lightning mediator request failed')
        );
    }

    return response.json() as Promise<PendingInvoiceData>;
}

export async function deletePendingL402Invoice(baseUrl: string, paymentHash: string): Promise<void> {
    await requestLightningMediator<{ ok: boolean; paymentHash: string }>(
        baseUrl,
        `/api/v1/l402/pending/${encodeURIComponent(paymentHash)}`,
        {
            method: 'DELETE',
        }
    );
}
