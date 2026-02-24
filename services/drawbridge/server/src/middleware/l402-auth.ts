import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { randomBytes } from 'crypto';
import { createMacaroon, verifyMacaroon, extractCaveats, getMacaroonId, verifyPreimage } from '../macaroon.js';
import { checkLimit, checkAndRecordRequest } from '../rate-limiter.js';
import { createInvoice } from '../lightning.js';
import { routeToScope, getPriceForOperation } from '../pricing.js';
import {
    PaymentRequiredError,
    InvalidMacaroonError,
    MacaroonRevokedError,
    RateLimitExceededError,
    InsufficientScopeError,
    PaymentVerificationError,
} from '../errors.js';
import type {
    L402Options,
    L402CaveatSet,
    PendingInvoiceData,
    PaymentRecord,
    MacaroonRecord,
} from '../types.js';

// Routes that bypass L402 auth
const UNPROTECTED_PATHS = ['/ready', '/version', '/status', '/metrics'];
const UNPROTECTED_PREFIXES = ['/l402/'];

function isProtectedRoute(path: string): boolean {
    const basePath = path.replace(/^\/api\/v1/, '');
    return !UNPROTECTED_PATHS.includes(basePath) &&
        !UNPROTECTED_PREFIXES.some(prefix => basePath.startsWith(prefix));
}

function parseL402Header(authHeader: string): { macaroon: string; proof: string } | null {
    if (!authHeader.startsWith('L402 ')) {
        return null;
    }

    const token = authHeader.slice(5);
    const colonIdx = token.indexOf(':');
    if (colonIdx === -1) {
        return null;
    }

    return {
        macaroon: token.slice(0, colonIdx),
        proof: token.slice(colonIdx + 1),
    };
}

export function createL402Middleware(options: L402Options): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const path = req.path;

        if (!isProtectedRoute(path)) {
            next();
            return;
        }

        // If subscription auth already passed, skip L402
        if ((req as any).subscriptionAuth) {
            next();
            return;
        }

        try {
            const authHeader = req.headers.authorization;
            const l402 = authHeader ? parseL402Header(authHeader) : null;

            if (l402) {
                await handleMacaroonAuth(options, l402, req, res, next);
                return;
            }

            // No auth — issue a challenge
            await handleChallenge(options, req, res);
        } catch (error) {
            if (error instanceof RateLimitExceededError) {
                const result = await checkLimit(
                    options.store,
                    req.headers['x-did'] as string || 'anonymous',
                    options.rateLimitRequests,
                    options.rateLimitWindowSeconds
                );
                res.status(429).json({
                    error: 'Rate limit exceeded',
                    resetAt: result.resetAt,
                });
                return;
            }

            if (error instanceof PaymentRequiredError ||
                error instanceof InvalidMacaroonError ||
                error instanceof MacaroonRevokedError) {
                options.hooks?.onMacaroonVerification?.('failure');
                res.status(401).json({ error: error.message });
                return;
            }

            if (error instanceof InsufficientScopeError) {
                res.status(403).json({ error: error.message });
                return;
            }

            const message = error instanceof Error ? error.message : 'Internal Drawbridge error';
            options.logger?.error?.({ err: error }, 'L402 middleware error');
            if (message.includes('Lightning not configured') || message.includes('ECONNREFUSED')) {
                res.status(503).json({ error: 'Lightning service unavailable' });
            } else {
                res.status(500).json({ error: 'Internal Drawbridge error' });
            }
        }
    };
}

async function handleMacaroonAuth(
    options: L402Options,
    l402: { macaroon: string; proof: string },
    req: Request,
    _res: Response,
    next: NextFunction
): Promise<void> {
    const scope = routeToScope(req.method, req.path);
    const did = req.headers['x-did'] as string | undefined;

    const caveats = extractCaveats(l402.macaroon);

    const macaroonId = getMacaroonId(l402.macaroon);
    const record = await options.store.getMacaroon(macaroonId);

    if (!record) {
        throw new InvalidMacaroonError('No macaroon record found');
    }

    if (record.revoked) {
        throw new MacaroonRevokedError();
    }

    // Verify preimage
    if (!verifyPreimage(l402.proof, caveats.paymentHash || '')) {
        throw new PaymentVerificationError('Invalid preimage');
    }

    // Verify macaroon HMAC chain and all caveats
    const context = {
        did,
        scope,
        currentTime: Math.floor(Date.now() / 1000),
        currentUses: record.currentUses,
        paymentHash: caveats.paymentHash,
    };

    const result = verifyMacaroon(options.rootSecret, l402.macaroon, context);

    if (!result.valid) {
        throw new InvalidMacaroonError('Macaroon verification failed');
    }

    // Enforce rate limits
    const rateLimitId = did || `ip:${req.ip || 'unknown'}`;
    const rateLimitResult = await checkAndRecordRequest(
        options.store,
        rateLimitId,
        options.rateLimitRequests,
        options.rateLimitWindowSeconds
    );
    if (!rateLimitResult.allowed) {
        throw new RateLimitExceededError();
    }

    await options.store.incrementUsage(macaroonId);

    options.hooks?.onMacaroonVerification?.('success');
    next();
}

async function handleChallenge(
    options: L402Options,
    req: Request,
    res: Response
): Promise<void> {
    const did = req.headers['x-did'] as string | undefined;

    // Rate limit challenge requests by IP
    const rateLimitId = `ip:${req.ip || 'unknown'}`;
    const rateLimitResult = await checkAndRecordRequest(
        options.store,
        rateLimitId,
        options.rateLimitRequests,
        options.rateLimitWindowSeconds
    );

    if (!rateLimitResult.allowed) {
        throw new RateLimitExceededError();
    }

    const scope = routeToScope(req.method, req.path);

    // Determine price
    let amountSat = options.defaults.amountSat;
    let operationName: string | undefined;

    if (options.pricing) {
        const price = getPriceForOperation(options.pricing, req.method, req.path);
        if (price) {
            amountSat = price.amountSat;
            operationName = scope;
        }
    }

    // Create Lightning invoice
    const memo = operationName
        ? `Drawbridge: ${operationName} (${amountSat} sats)`
        : `Drawbridge: ${scope} (${amountSat} sats)`;

    const invoice = await createInvoice(options.cln, amountSat, memo);

    // Create macaroon with caveats
    const expiryTime = Math.floor(Date.now() / 1000) + options.defaults.expirySeconds;
    const maxUses = operationName ? 1 : undefined; // Single-use for priced operations

    const caveatSet: L402CaveatSet = {
        did: did || undefined,
        scope: operationName ? [scope] : options.defaults.scopes,
        expiry: expiryTime,
        maxUses,
        paymentHash: invoice.paymentHash,
    };

    const token = createMacaroon(options.rootSecret, options.location, caveatSet);

    // Save macaroon record
    const macaroonRecord: MacaroonRecord = {
        id: token.id,
        did: did || 'anonymous',
        scope: caveatSet.scope || options.defaults.scopes,
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: expiryTime,
        maxUses: maxUses || 0,
        currentUses: 0,
        paymentHash: invoice.paymentHash,
        revoked: false,
    };
    await options.store.saveMacaroon(macaroonRecord);

    // Save pending invoice
    const pendingInvoice: PendingInvoiceData = {
        paymentHash: invoice.paymentHash,
        macaroonId: token.id,
        serializedMacaroon: token.macaroon,
        did: did || 'anonymous',
        scope: caveatSet.scope || options.defaults.scopes,
        amountSat,
        expiresAt: expiryTime,
        createdAt: Math.floor(Date.now() / 1000),
    };
    await options.store.savePendingInvoice(pendingInvoice);

    options.hooks?.onChallenge?.(!!did);

    res.setHeader('WWW-Authenticate',
        `L402 macaroon="${token.macaroon}", invoice="${invoice.paymentRequest}"`
    );

    if (operationName) {
        res.setHeader('X-L402-Price', String(amountSat));
        res.setHeader('X-L402-Operation', operationName);
    }

    res.status(402).json({
        error: 'Payment required',
        macaroon: token.macaroon,
        invoice: invoice.paymentRequest,
        paymentHash: invoice.paymentHash,
        amountSat,
        expiresAt: expiryTime,
        operation: operationName || undefined,
        acceptedMethods: ['lightning'],
    });
}

// Payment completion endpoint handler
export async function handlePaymentCompletion(
    options: L402Options,
    req: Request,
    res: Response
): Promise<void> {
    const { paymentHash, preimage } = req.body;

    if (!paymentHash) {
        res.status(400).json({ error: 'paymentHash is required' });
        return;
    }

    const pending = await options.store.getPendingInvoice(paymentHash);
    if (!pending) {
        res.status(404).json({ error: 'No pending invoice found for this payment hash' });
        return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (pending.expiresAt > 0 && now >= pending.expiresAt) {
        await options.store.deletePendingInvoice(paymentHash);
        res.status(410).json({ error: 'Invoice has expired' });
        return;
    }

    if (!preimage) {
        res.status(400).json({ error: 'preimage is required' });
        return;
    }

    if (!verifyPreimage(preimage, paymentHash)) {
        res.status(400).json({ error: 'Invalid preimage' });
        return;
    }

    // Save payment record
    const paymentRecord: PaymentRecord = {
        id: randomBytes(16).toString('hex'),
        did: pending.did,
        method: 'lightning',
        paymentHash,
        amountSat: pending.amountSat,
        createdAt: Math.floor(Date.now() / 1000),
        macaroonId: pending.macaroonId,
        scope: pending.scope,
    };
    await options.store.savePayment(paymentRecord);

    await options.store.deletePendingInvoice(paymentHash);

    res.json({
        macaroonId: pending.macaroonId,
        macaroon: pending.serializedMacaroon,
        paymentHash,
        method: 'lightning',
        amountSat: pending.amountSat,
    });
}

// Admin handler: revoke a macaroon
export async function handleRevokeMacaroon(
    options: L402Options,
    req: Request,
    res: Response
): Promise<void> {
    const { macaroonId } = req.body;

    if (!macaroonId) {
        res.status(400).json({ error: 'macaroonId is required' });
        return;
    }

    const existing = await options.store.getMacaroon(macaroonId);
    if (!existing) {
        res.status(404).json({ error: 'Macaroon not found' });
        return;
    }

    await options.store.revokeMacaroon(macaroonId);
    res.json({ revoked: true, macaroonId });
}

// Admin handler: get L402 status
export async function handleL402Status(
    options: L402Options,
    _req: Request,
    res: Response
): Promise<void> {
    res.json({
        enabled: true,
        lightning: true,
        pricing: options.pricing ? Object.keys(options.pricing.operations) : [],
    });
}

// Admin handler: get payments for a DID
export async function handleGetPayments(
    options: L402Options,
    req: Request,
    res: Response
): Promise<void> {
    const did = req.params.did as string;
    if (!did) {
        res.status(400).json({ error: 'DID parameter is required' });
        return;
    }

    const payments = await options.store.getPaymentsByDid(did);
    res.json(payments);
}
