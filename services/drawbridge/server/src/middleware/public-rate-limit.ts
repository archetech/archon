import type { Request, Response, NextFunction } from 'express';
import type { DrawbridgeStore, RateLimitResult } from '../types.js';
import { checkAndRecordRequest } from '../rate-limiter.js';

// Rate limiting for public passthroughs that carry no identity to key on.
//
// The DIDComm relay behind /didcomm has two routes that are unauthenticated by
// design and cannot be otherwise: a sender must be able to reach a stranger's
// mailbox, and GET /challenge is the first step of proving DID control. So the
// per-DID keying used on the paid path does not apply here.
//
// Two things are limited separately, because they are not the same load:
//
//   deposits  POST of an envelope, up to the body limit (10mb here). Budgeted
//             by BYTES, not requests -- a request ceiling generous enough for
//             normal traffic still permits a couple of dozen max-size deposits,
//             which is all it takes to fill the relay's storage cap.
//   reads     challenge/fetch/remove polling. Cheap and chatty; one poll is
//             four requests, so this ceiling has to clear an active wallet.
//
// Each is bucketed per-source and globally. Per-source is only applied when the
// source is actually meaningful: `trust proxy` is not configured, so behind a
// reverse proxy or the bundled Tor container every request arrives from one
// private address. Applying a per-source ceiling there would throttle all such
// traffic to a fraction of the global allowance and the global bucket -- the
// one that is supposed to hold when sources are shared -- would never be
// reached. So a private/loopback source is limited globally only.

export interface PublicRateLimitOptions {
    store: DrawbridgeStore;
    // Namespace so separate surfaces get separate buckets.
    name: string;
    readPerSourceMax: number;
    readGlobalMax: number;
    depositPerSourceBytes: number;
    depositGlobalBytes: number;
    windowSeconds: number;
    // Requests that spend the byte budget rather than the read budget.
    isDeposit?: (req: Request) => boolean;
    logger?: { warn: (obj: unknown, msg: string) => void };
}

// Sources that do not identify a client: loopback, RFC1918, link-local,
// carrier-grade NAT, and IPv6 loopback / unique-local.
export function isMeaningfulSource(ip: string): boolean {
    if (!ip || ip === 'unknown') {
        return false;
    }

    const address = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;

    if (address === '::1' || address === '127.0.0.1') {
        return false;
    }

    // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
    if (/^f[cd]/i.test(address) || /^fe8/i.test(address)) {
        return false;
    }

    const octets = address.split('.').map(Number);
    if (octets.length === 4 && octets.every(part => Number.isInteger(part))) {
        const [a, b] = octets;
        if (a === 10 || a === 127) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && b === 168) return false;
        if (a === 169 && b === 254) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;
    }

    return true;
}

function defaultIsDeposit(req: Request): boolean {
    return req.method === 'POST' && /\/messages\/?$/.test(req.path);
}

// Body parsers run before this middleware, so the parsed body is the honest
// size. Content-Length is the fallback; a chunked request without either is
// charged one unit rather than nothing.
function requestBytes(req: Request): number {
    const body = (req as any).body;

    if (typeof body === 'string') {
        return Buffer.byteLength(body, 'utf-8');
    }

    if (body && typeof body === 'object') {
        try {
            return Buffer.byteLength(JSON.stringify(body), 'utf-8');
        }
        catch {
            // fall through to the header
        }
    }

    const declared = Number(req.headers['content-length']);
    return Number.isSafeInteger(declared) && declared > 0 ? declared : 1;
}

export function publicRateLimit(options: PublicRateLimitOptions) {
    const {
        store,
        name,
        readPerSourceMax,
        readGlobalMax,
        depositPerSourceBytes,
        depositGlobalBytes,
        windowSeconds,
        isDeposit = defaultIsDeposit,
    } = options;

    return async function publicRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
        const source = req.ip || 'unknown';
        const keyed = isMeaningfulSource(source);

        try {
            const results: RateLimitResult[] = [];

            if (isDeposit(req)) {
                const cost = requestBytes(req);
                if (keyed) {
                    results.push(await store.checkAndRecordCost(
                        `${name}:deposit:src:${source}`, cost, depositPerSourceBytes, windowSeconds));
                }
                results.push(await store.checkAndRecordCost(
                    `${name}:deposit:global`, cost, depositGlobalBytes, windowSeconds));
            }
            else {
                if (keyed) {
                    results.push(await checkAndRecordRequest(
                        store, `${name}:read:src:${source}`, readPerSourceMax, windowSeconds));
                }
                results.push(await checkAndRecordRequest(
                    store, `${name}:read:global`, readGlobalMax, windowSeconds));
            }

            const refused = results.find(result => !result.allowed);

            if (refused) {
                res.set('Retry-After', String(Math.max(1, refused.resetAt - Math.floor(Date.now() / 1000))));
                res.status(429).json({
                    error: 'Rate limit exceeded',
                    resetAt: refused.resetAt,
                });
                return;
            }
        }
        catch (error) {
            // Fail open. The limiter protects availability; if its own store is
            // unreachable, refusing every request would cause the outage it is
            // meant to prevent.
            //
            // Note this leaves the relay's storage caps as the only bound, and
            // those are only globally bounding on the memory backend: redis
            // enforces the per-recipient cap only, which rotating recipient DIDs
            // sidesteps, unless the deployment gives it a dedicated instance
            // with maxmemory. See docs/services/didcomm/README.md §5.3.
            options.logger?.warn({ err: error, surface: name }, 'rate limit check failed, allowing request');
        }

        next();
    };
}
