import type { DrawbridgeStore, RateLimitResult } from './types.js';

export async function checkLimit(
    store: DrawbridgeStore,
    did: string,
    maxRequests: number,
    windowSeconds: number
): Promise<RateLimitResult> {
    return store.checkRateLimit(did, maxRequests, windowSeconds);
}

/** Atomically check rate limit and record the request if allowed */
export async function checkAndRecordRequest(
    store: DrawbridgeStore,
    did: string,
    maxRequests: number,
    windowSeconds: number
): Promise<RateLimitResult> {
    return store.checkAndRecordRequest(did, maxRequests, windowSeconds);
}
