import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { randomBytes, createHash } from 'crypto';
import macaroonsJs from 'macaroons.js';
const { MacaroonsBuilder: MacBuilder } = macaroonsJs;
import { createMacaroon, verifyMacaroon, extractCaveats, verifyPreimage } from './macaroon.js';
import { checkLimit, recordRequest } from './rate-limiter.js';
import { createInvoice } from './lightning.js';
import { redeemCashuToken } from './cashu.js';
import { routeToScope, getPriceForOperation } from './pricing.js';
import {
    PaymentRequiredError,
    InvalidMacaroonError,
    MacaroonRevokedError,
    RateLimitExceededError,
    InsufficientScopeError,
    PaymentVerificationError,
} from './errors.js';
import type {
    L402MiddlewareOptions,
    L402CaveatSet,
    PendingInvoiceData,
    PaymentRecord,
    MacaroonRecord,
} from './types.js';

// Protected routes that require L402 auth (excludes health/status endpoints and L402 management)
const UNPROTECTED_PATHS = ['/ready', '/version', '/status', '/metrics'];
const UNPROTECTED_PREFIXES = ['/l402/'];

function isProtectedRoute(path: string): boolean {
    const basePath = path.replace(/^\/api\/v1/, '');
    if (UNPROTECTED_PATHS.includes(basePath)) return false;
    if (UNPROTECTED_PREFIXES.some(prefix => basePath.startsWith(prefix))) return false;
    return true;
}

function parseL402Header(authHeader: string): { macaroon: string; proof: string; method: 'lightning' | 'cashu' } | null {
    if (!authHeader.startsWith('L402 ')) {
        return null;
    }

    const token = authHeader.slice(5);
    const colonIdx = token.indexOf(':');
    if (colonIdx === -1) {
        return null;
    }

    const macaroon = token.slice(0, colonIdx);
    const rest = token.slice(colonIdx + 1);

    // Check for cashu payment: L402 <macaroon>:cashu:<token>
    if (rest.startsWith('cashu:')) {
        return {
            macaroon,
            proof: rest.slice(6),
            method: 'cashu',
        };
    }

    // Lightning payment: L402 <macaroon>:<preimage>
    return {
        macaroon,
        proof: rest,
        method: 'lightning',
    };
}

export function createL402Middleware(options: L402MiddlewareOptions): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const path = req.path;

        // Skip unprotected routes
        if (!isProtectedRoute(path)) {
            next();
            return;
        }

        try {
            // Check for direct Cashu payment on priced operations
            const cashuHeader = req.headers['x-cashu-token'] as string | undefined;
            if (cashuHeader && options.cashu && options.pricing) {
                const price = getPriceForOperation(options.pricing, req.method, path, req.body);
                if (price) {
                    try {
                        // Redeem atomically first to prevent double-spend (TOCTOU)
                        const redemption = await redeemCashuToken(options.cashu, cashuHeader);
                        if (redemption.amount < price.amountSat) {
                            res.status(402).json({
                                error: 'Insufficient Cashu payment',
                                required: price.amountSat,
                                provided: redemption.amount,
                            });
                            return;
                        }

                        // Record payment
                        const did = req.headers['x-did'] as string || 'anonymous';
                        const paymentHash = createHash('sha256').update(cashuHeader).digest('hex');
                        const scope = routeToScope(req.method, path);
                        const paymentRecord: PaymentRecord = {
                            id: randomBytes(16).toString('hex'),
                            did,
                            method: 'cashu',
                            paymentHash,
                            amountSat: redemption.amount,
                            createdAt: Math.floor(Date.now() / 1000),
                            macaroonId: 'direct-cashu',
                            scope: [scope],
                        };
                        await options.store.savePayment(paymentRecord);

                        // Allow the request through
                        next();
                        return;
                    } catch {
                        res.status(402).json({
                            error: 'Invalid Cashu token',
                        });
                        return;
                    }
                }
            }

            // Check for L402 Authorization header
            const authHeader = req.headers.authorization;
            const l402 = authHeader ? parseL402Header(authHeader) : null;

            if (l402) {
                // Verify existing macaroon
                await handleMacaroonAuth(options, l402, req, res, next);
                return;
            }

            // No L402 header — issue a challenge
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

            res.status(500).json({ error: 'Internal L402 error' });
        }
    };
}

async function handleMacaroonAuth(
    options: L402MiddlewareOptions,
    l402: { macaroon: string; proof: string; method: 'lightning' | 'cashu' },
    req: Request,
    _res: Response,
    next: NextFunction
): Promise<void> {
    const scope = routeToScope(req.method, req.path);
    const did = req.headers['x-did'] as string | undefined;

    // Extract caveats to get payment hash and DID before full verification
    const caveats = extractCaveats(l402.macaroon);

    // Check if the macaroon has been revoked
    const macaroonId = getMacaroonId(l402.macaroon);
    const record = await options.store.getMacaroon(macaroonId);

    if (record && record.revoked) {
        throw new MacaroonRevokedError();
    }

    // Build verification context
    const currentUses = record?.currentUses ?? 0;
    const context = {
        did,
        scope,
        currentTime: Math.floor(Date.now() / 1000),
        currentUses,
        paymentHash: caveats.paymentHash,
    };

    // Verify payment proof
    if (l402.method === 'lightning') {
        if (!verifyPreimage(l402.proof, caveats.paymentHash || '')) {
            throw new PaymentVerificationError('Invalid preimage');
        }
    } else if (l402.method === 'cashu') {
        if (!options.cashu) {
            throw new PaymentVerificationError('Cashu not configured');
        }
        // For Cashu, the proof of payment is that a payment was recorded for this macaroon
        // via handlePaymentCompletion (the Cashu token was redeemed at that point).
        // The l402.proof here is a receipt/reference; verify a payment record exists.
        if (!record) {
            throw new PaymentVerificationError('No macaroon record found');
        }
        // Verify that a payment was actually recorded for this macaroon
        const payments = await options.store.getPaymentsByDid(record.did);
        const hasCashuPayment = payments.some(
            p => p.macaroonId === macaroonId && p.method === 'cashu'
        );
        if (!hasCashuPayment) {
            throw new PaymentVerificationError('No Cashu payment found for this macaroon');
        }
    }

    // Verify macaroon HMAC chain and all caveats
    const result = verifyMacaroon(options.rootSecret, l402.macaroon, context);

    if (!result.valid) {
        throw new InvalidMacaroonError('Macaroon verification failed');
    }

    // Enforce rate limits on authenticated requests too
    const rateLimitId = did || `ip:${req.ip || 'unknown'}`;
    const rateLimitResult = await checkLimit(
        options.store,
        rateLimitId,
        options.rateLimitRequests,
        options.rateLimitWindowSeconds
    );
    if (!rateLimitResult.allowed) {
        throw new RateLimitExceededError();
    }

    // Increment usage counter
    if (record) {
        await options.store.incrementUsage(macaroonId);
    }

    // Record the request for rate limiting
    await recordRequest(options.store, rateLimitId, options.rateLimitWindowSeconds);

    options.hooks?.onMacaroonVerification?.('success');
    next();
}

async function handleChallenge(
    options: L402MiddlewareOptions,
    req: Request,
    res: Response
): Promise<void> {
    const did = req.headers['x-did'] as string | undefined;

    // Always check rate limits — use DID if available, otherwise fall back to IP
    const rateLimitId = did || `ip:${req.ip || 'unknown'}`;
    const rateLimitResult = await checkLimit(
        options.store,
        rateLimitId,
        options.rateLimitRequests,
        options.rateLimitWindowSeconds
    );

    if (!rateLimitResult.allowed) {
        throw new RateLimitExceededError();
    }

    // Validate DID via gatekeeper if available
    if (did && options.gatekeeper) {
        try {
            await options.gatekeeper.resolveDID(did);
        } catch {
            res.status(400).json({ error: 'Invalid DID' });
            return;
        }
    }

    const scope = routeToScope(req.method, req.path);

    // Determine the amount — check per-operation pricing first
    let amountSat = options.defaults.amountSat;
    let operationName: string | undefined;

    if (options.pricing) {
        const price = getPriceForOperation(options.pricing, req.method, req.path, req.body);
        if (price) {
            amountSat = price.amountSat;
            operationName = scope;
        }
    }

    if (!options.cln) {
        // No lightning configured — return 402 with info but no invoice
        options.hooks?.onChallenge?.(!!did);
        res.status(402).json({
            error: 'Payment required',
            amountSat,
            acceptedMethods: options.cashu ? ['cashu'] : [],
            cashuMints: options.cashu?.trustedMints || [],
        });
        return;
    }

    // Create a Lightning invoice
    const memo = operationName
        ? `L402 access: ${operationName} (${amountSat} sats)`
        : `L402 access: ${scope} (${amountSat} sats)`;

    const invoice = await createInvoice(options.cln, amountSat, memo);

    // Create a macaroon with caveats (payment_hash will bind it to this invoice)
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

    // Save the macaroon record
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

    // Save pending invoice (include serialized macaroon so it can be returned after payment)
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

    // Notify challenge hook
    options.hooks?.onChallenge?.(!!did);

    // Build response headers
    res.setHeader('WWW-Authenticate',
        `L402 macaroon="${token.macaroon}", invoice="${invoice.paymentRequest}"`
    );

    if (operationName) {
        res.setHeader('X-L402-Price', String(amountSat));
        res.setHeader('X-L402-Operation', operationName);
    }

    // Return 402 with full details
    res.status(402).json({
        error: 'Payment required',
        macaroon: token.macaroon,
        invoice: invoice.paymentRequest,
        paymentHash: invoice.paymentHash,
        amountSat,
        expiresAt: expiryTime,
        operation: operationName || undefined,
        acceptedMethods: ['lightning', ...(options.cashu ? ['cashu'] : [])],
        cashuMints: options.cashu?.trustedMints || [],
    });
}

function getMacaroonId(macaroonStr: string): string {
    try {
        const macaroon = MacBuilder.deserialize(macaroonStr);
        return macaroon.identifier;
    } catch {
        return '';
    }
}

// Payment completion endpoint handler
export async function handlePaymentCompletion(
    options: L402MiddlewareOptions,
    req: Request,
    res: Response
): Promise<void> {
    const { paymentHash, preimage, cashuToken } = req.body;

    if (!paymentHash) {
        res.status(400).json({ error: 'paymentHash is required' });
        return;
    }

    const pending = await options.store.getPendingInvoice(paymentHash);
    if (!pending) {
        res.status(404).json({ error: 'No pending invoice found for this payment hash' });
        return;
    }

    // Check if the pending invoice has expired
    const now = Math.floor(Date.now() / 1000);
    if (pending.expiresAt > 0 && now >= pending.expiresAt) {
        await options.store.deletePendingInvoice(paymentHash);
        res.status(410).json({ error: 'Invoice has expired' });
        return;
    }

    let method: 'lightning' | 'cashu';
    let verifiedAmountSat = pending.amountSat;

    if (preimage) {
        // Lightning payment
        if (!verifyPreimage(preimage, paymentHash)) {
            res.status(400).json({ error: 'Invalid preimage' });
            return;
        }
        method = 'lightning';
    } else if (cashuToken) {
        // Cashu payment
        if (!options.cashu) {
            res.status(400).json({ error: 'Cashu not configured' });
            return;
        }
        try {
            // Redeem atomically first to prevent double-spend (TOCTOU)
            const redemption = await redeemCashuToken(options.cashu, cashuToken);
            if (redemption.amount < pending.amountSat) {
                res.status(400).json({
                    error: 'Insufficient Cashu payment',
                    required: pending.amountSat,
                    provided: redemption.amount,
                });
                return;
            }
            verifiedAmountSat = redemption.amount;
            method = 'cashu';
        } catch (error: any) {
            res.status(400).json({ error: `Cashu verification failed: ${error.message}` });
            return;
        }
    } else {
        res.status(400).json({ error: 'preimage or cashuToken is required' });
        return;
    }

    // Save payment record
    const paymentRecord: PaymentRecord = {
        id: randomBytes(16).toString('hex'),
        did: pending.did,
        method,
        paymentHash,
        amountSat: verifiedAmountSat,
        createdAt: Math.floor(Date.now() / 1000),
        macaroonId: pending.macaroonId,
        scope: pending.scope,
    };
    await options.store.savePayment(paymentRecord);

    // Clean up pending invoice
    await options.store.deletePendingInvoice(paymentHash);

    // Return the serialized macaroon token for use in L402 headers
    res.json({
        macaroonId: pending.macaroonId,
        macaroon: pending.serializedMacaroon,
        paymentHash,
        method,
        amountSat: verifiedAmountSat,
    });
}

// Admin handler: revoke a macaroon
export async function handleRevokeMacaroon(
    options: L402MiddlewareOptions,
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
    options: L402MiddlewareOptions,
    _req: Request,
    res: Response
): Promise<void> {
    res.json({
        enabled: true,
        lightning: !!options.cln,
        cashu: !!options.cashu,
        pricing: options.pricing ? Object.keys(options.pricing.operations) : [],
    });
}

// Admin handler: get payments for a DID
export async function handleGetPayments(
    options: L402MiddlewareOptions,
    req: Request,
    res: Response
): Promise<void> {
    const did = req.params.did;
    if (!did) {
        res.status(400).json({ error: 'DID parameter is required' });
        return;
    }

    const payments = await options.store.getPaymentsByDid(did);
    res.json(payments);
}
