import type { LightningInvoice, LightningPaymentResult } from './types.js';

async function postToLightningMediator<T>(
    baseUrl: string,
    path: string,
    payload: Record<string, unknown>
): Promise<T> {
    const response = await fetch(new URL(path, baseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(String(errorBody.error || response.statusText || 'Lightning mediator request failed'));
    }

    return response.json() as Promise<T>;
}

export function createL402Invoice(
    baseUrl: string,
    amountSat: number,
    memo: string
): Promise<LightningInvoice> {
    return postToLightningMediator<LightningInvoice>(baseUrl, '/api/v1/l402/invoice', {
        amountSat,
        memo,
    });
}

export function checkL402Invoice(
    baseUrl: string,
    paymentHash: string
): Promise<LightningPaymentResult> {
    return postToLightningMediator<LightningPaymentResult>(baseUrl, '/api/v1/l402/check', {
        paymentHash,
    });
}
