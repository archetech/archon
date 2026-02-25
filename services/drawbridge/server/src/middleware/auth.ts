import type { RequestHandler } from 'express';
import { createSubscriptionMiddleware } from './subscription-auth.js';
import { createL402Middleware } from './l402-auth.js';
import type { L402Options } from '../types.js';

/**
 * Creates the dual-auth middleware chain.
 *
 * Order:
 * 1. Subscription auth runs first — checks for X-Subscription-DID header.
 *    If present, marks the request as subscription-authenticated.
 * 2. L402 auth runs second — if subscription auth already passed, it skips.
 *    Otherwise, it enforces the L402 challenge-response flow.
 *
 * This means either auth method works: clients can present a subscription
 * credential OR pay per-request via Lightning. No auth → 402 challenge.
 */
export function createAuthMiddleware(l402Options: L402Options): RequestHandler[] {
    return [
        createSubscriptionMiddleware(),
        createL402Middleware(l402Options),
    ];
}
