import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Subscription credential auth middleware (stub).
 *
 * TODO (#121): Implement full credential-based subscription verification:
 * 1. Extract credential DID and requesting DID from headers
 * 2. Resolve credential via Gatekeeper — verify it's a valid SubscriptionCredential
 * 3. Verify credential via Keymaster — check not expired, not revoked
 * 4. Verify group membership — confirm requesting DID is in the credential's group
 * 5. Check usage counters against tier limits
 *
 * For now, if the header is present, mark as subscription-authed and pass through.
 * This allows the dual-auth flow to be wired up before the subscription system is built.
 */
export function createSubscriptionMiddleware(): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction): void => {
        const subscriptionDid = req.headers['x-subscription-did'] as string | undefined;

        if (subscriptionDid) {
            // Mark request as subscription-authenticated for downstream middleware
            (req as any).subscriptionAuth = { credentialDid: subscriptionDid };
        }

        next();
    };
}
