import type { L402Store, RateLimitResult } from './types.js';

export async function checkLimit(
    store: L402Store,
    did: string,
    maxRequests: number,
    windowSeconds: number
): Promise<RateLimitResult> {
    return store.checkRateLimit(did, maxRequests, windowSeconds);
}

export async function recordRequest(
    store: L402Store,
    did: string,
    windowSeconds: number
): Promise<void> {
    return store.recordRequest(did, windowSeconds);
}
