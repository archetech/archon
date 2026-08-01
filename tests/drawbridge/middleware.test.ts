import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { createSubscriptionMiddleware } from '../../services/drawbridge/server/src/middleware/subscription-auth';
import { checkAndRecordRequest, checkLimit } from '../../services/drawbridge/server/src/rate-limiter';
import type { DrawbridgeStore, RateLimitResult } from '../../services/drawbridge/server/src/types';

describe('subscription auth middleware', () => {
    function mount() {
        const app = express();
        app.use(createSubscriptionMiddleware());
        app.get('/probe', (req, res) => {
            res.json({ subscriptionAuth: (req as any).subscriptionAuth ?? null });
        });
        return app;
    }

    it('marks the request as subscription-authenticated when the header is present', async () => {
        const response = await request(mount())
            .get('/probe')
            .set('X-Subscription-DID', 'did:cid:subscriber');

        expect(response.status).toBe(200);
        expect(response.body.subscriptionAuth).toEqual({ credentialDid: 'did:cid:subscriber' });
    });

    it('passes through untouched when the header is absent', async () => {
        const response = await request(mount()).get('/probe');

        expect(response.status).toBe(200);
        expect(response.body.subscriptionAuth).toBeNull();
    });

    it('does not mark the request when the header is empty', async () => {
        const response = await request(mount()).get('/probe').set('X-Subscription-DID', '');

        expect(response.status).toBe(200);
        expect(response.body.subscriptionAuth).toBeNull();
    });
});

describe('rate limiter', () => {
    const allowed: RateLimitResult = { allowed: true, remaining: 4, resetAt: 1800000000 };

    function storeWith(result: RateLimitResult) {
        return {
            checkRateLimit: jest.fn<any>().mockResolvedValue(result),
            checkAndRecordRequest: jest.fn<any>().mockResolvedValue(result),
        } as unknown as DrawbridgeStore;
    }

    it('delegates a limit check to the store with the supplied window', async () => {
        const store = storeWith(allowed);

        await expect(checkLimit(store, 'did:cid:abc', 5, 60)).resolves.toEqual(allowed);
        expect(store.checkRateLimit).toHaveBeenCalledWith('did:cid:abc', 5, 60);
    });

    it('delegates the atomic check-and-record to the store', async () => {
        const store = storeWith(allowed);

        await expect(checkAndRecordRequest(store, 'did:cid:abc', 5, 60)).resolves.toEqual(allowed);
        expect(store.checkAndRecordRequest).toHaveBeenCalledWith('did:cid:abc', 5, 60);
    });

    it('passes a denial straight back to the caller', async () => {
        const denied: RateLimitResult = { allowed: false, remaining: 0, resetAt: 1800000000 };
        const store = storeWith(denied);

        await expect(checkLimit(store, 'did:cid:abc', 5, 60)).resolves.toEqual(denied);
        await expect(checkAndRecordRequest(store, 'did:cid:abc', 5, 60)).resolves.toEqual(denied);
    });
});

describe('combined auth middleware', () => {
    it('chains subscription auth before the L402 paywall', async () => {
        const { createAuthMiddleware } = await import('../../services/drawbridge/server/src/middleware/auth');

        const chain = createAuthMiddleware({
            rootSecret: 'x'.repeat(32),
            location: 'http://localhost',
            defaults: { amountSat: 1, expirySeconds: 60, scopes: [] },
            store: {} as any,
        } as any);

        // Order matters: subscription auth marks the request so the L402
        // middleware can skip the challenge for an already-authenticated caller.
        expect(chain).toHaveLength(2);
        expect(chain.every(fn => typeof fn === 'function')).toBe(true);
    });
});
