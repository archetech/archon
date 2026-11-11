import config from './config.js';
import { LightningUnavailableError } from './errors.js';
import type { LightningInvoice, LightningPaymentResult, PendingInvoiceData } from './types.js';

const ARCHON_ADMIN_HEADER = 'X-Archon-Admin-Key';

// A 402 challenge waits on the mediator for its invoice, so a mediator that
// accepts the connection but never answers must not hold challenges open: past
// this deadline Lightning counts as unavailable and Cashu can be offered alone.
export const LIGHTNING_MEDIATOR_TIMEOUT_MS = 10_000;

async function requestLightningMediator<T>(
    baseUrl: string,
    path: string,
    options: RequestInit,
    timeoutMs = LIGHTNING_MEDIATOR_TIMEOUT_MS
): Promise<T> {
    let response: Response;
    try {
        response = await fetch(new URL(path, baseUrl), {
            ...options,
            // Covers reading the body as well as waiting for the headers.
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
                'Content-Type': 'application/json',
                ...(config.adminApiKey ? { [ARCHON_ADMIN_HEADER]: config.adminApiKey } : {}),
                ...(options.headers || {}),
            },
        });
    } catch (error) {
        // fetch rejects when the mediator cannot be reached at all.
        throw new LightningUnavailableError(
            `Lightning mediator unreachable: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: response.statusText }));
        throw new LightningUnavailableError(
            String(errorBody.error || response.statusText || 'Lightning mediator request failed')
        );
    }

    // A truncated or malformed body is as unavailable as no answer at all.
    try {
        return await response.json() as T;
    } catch (error) {
        throw new LightningUnavailableError(
            `Lightning mediator sent an unreadable response: ${error instanceof Error ? error.message : String(error)}`
        );
    }
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
    const response = await fetch(new URL(`/api/v1/l402/pending/${encodeURIComponent(paymentHash)}`, baseUrl), {
        headers: config.adminApiKey ? { [ARCHON_ADMIN_HEADER]: config.adminApiKey } : {},
    });
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
