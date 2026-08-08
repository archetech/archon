import type { RequestHandler } from 'express';
import { createSubscriptionMiddleware } from './subscription-auth.js';
import { createL402Middleware } from './l402-auth.js';
import type { L402Options } from '../types.js';

export interface AuthMiddlewareOptions {
    /**
     * WARNING: the subscription-auth middleware is a stub (#121) that marks any
     * request carrying an X-Subscription-DID header as authenticated WITHOUT
     * verifying a credential. Enabling it disables L402 payment enforcement for
     * those requests. Leave disabled (the default) until #121 lands.
     */
    subscriptionAuthEnabled?: boolean;
}

/**
 * Creates the auth middleware chain.
 *
 * Default: L402 only. No auth → 402 challenge.
 *
 * When `subscriptionAuthEnabled` is explicitly set:
 * 1. Subscription auth (stub, unverified — see above) runs first and marks
 *    requests carrying X-Subscription-DID.
 * 2. L402 auth runs second and skips requests marked by step 1.
 */
export function createAuthMiddleware(
    l402Options: L402Options,
    options: AuthMiddlewareOptions = {},
): RequestHandler[] {
    const chain: RequestHandler[] = [];

    if (options.subscriptionAuthEnabled === true) {
        chain.push(createSubscriptionMiddleware());
    }

    chain.push(createL402Middleware(l402Options));
    return chain;
}
