import type { Request, RequestHandler, Response, NextFunction } from 'express';
import type { DrawbridgeStore, RateLimitResult } from '../types.js';
import { checkAndRecordRequest } from '../rate-limiter.js';

// Rate limiting for public passthroughs that carry no identity to key on.
//
// Drawbridge fronts several upstreams on routes that are unauthenticated by
// design and cannot be otherwise: a DIDComm sender must be able to reach a
// stranger's mailbox, a universal resolver does not speak L402, and a name
// claim proves DID control rather than presenting a macaroon. So the per-DID
// keying used on the paid path does not apply to any of them.
//
// A surface gets one budget, or two when its requests are not all the same
// load:
//
//   reads     the ordinary traffic of the surface. Budgeted by REQUEST count.
//             Often chatty -- a DIDComm poll is four requests and an explorer
//             page load is dozens -- so a ceiling here has to clear normal use.
//   deposits  requests that leave something behind upstream. Budgeted by
//             BYTES, because a request ceiling generous enough for normal
//             traffic still permits a couple of dozen max-size deposits, which
//             is all it takes to fill the DIDComm relay's storage cap. Omit
//             the byte budgets on a surface that stores nothing.
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
    // Byte budgets for requests that store data upstream. Give both, for a
    // surface with a deposit bucket, or neither, for one where every request is
    // a read; anything else is refused at construction.
    depositPerSourceBytes?: number;
    depositGlobalBytes?: number;
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

    // Omitting both byte budgets means the surface stores nothing and every
    // request is a read. Omitting one is a typo, and silently accepting it
    // would downgrade deposits to the request-count bucket -- switching off the
    // budget that actually bounds them, which is exactly what having it is for.
    const budgeted = depositPerSourceBytes !== undefined || depositGlobalBytes !== undefined;
    if (budgeted && (depositPerSourceBytes === undefined || depositGlobalBytes === undefined)) {
        throw new Error(
            `publicRateLimit(${name}): depositPerSourceBytes and depositGlobalBytes must be given together`);
    }
    if (!budgeted && options.isDeposit) {
        throw new Error(
            `publicRateLimit(${name}): isDeposit has no effect without the deposit byte budgets`);
    }

    const chargeAsDeposit = budgeted ? isDeposit : () => false;

    return async function publicRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
        const source = req.ip || 'unknown';
        const keyed = isMeaningfulSource(source);

        const deposit = chargeAsDeposit(req);
        const bucket = deposit ? 'deposit' : 'read';
        const cost = deposit ? requestBytes(req) : 1;

        const charge = (key: string, max: number): Promise<RateLimitResult> => deposit
            ? store.checkAndRecordCost(key, cost, max, windowSeconds)
            : checkAndRecordRequest(store, key, max, windowSeconds);

        try {
            let refused: RateLimitResult | undefined;

            if (keyed) {
                const perSource = await charge(
                    `${name}:${bucket}:src:${source}`,
                    deposit ? depositPerSourceBytes! : readPerSourceMax);
                if (!perSource.allowed) {
                    refused = perSource;
                }
            }

            // A request refused by its per-source bucket never reaches the
            // upstream, so it must not be charged to the global one. Charging it
            // anyway would let a single source that is already being refused
            // drain the budget meant to hold when sources are shared -- and the
            // per-source ceiling would protect nothing but its own counter.
            if (!refused) {
                const global = await charge(
                    `${name}:${bucket}:global`,
                    deposit ? depositGlobalBytes! : readGlobalMax);
                if (!global.allowed) {
                    refused = global;
                }
            }

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
            // Note this leaves the DIDComm relay's storage caps as the only bound, and
            // those are only globally bounding on the memory backend: redis
            // enforces the per-recipient cap only, which rotating recipient DIDs
            // sidesteps, unless the deployment gives it a dedicated instance
            // with maxmemory. See docs/services/didcomm/README.md §5.3.
            options.logger?.warn({ err: error, surface: name }, 'rate limit check failed, allowing request');
        }

        next();
    };
}

// A surface fronted by one mount can still carry two kinds of load: Herald
// answers name lookups and claims on the same prefix, and a claim mints a
// credential where a lookup reads one. The bucket is therefore chosen per
// request. Everything outside the safe methods is a write, so a verb added to
// the upstream later lands on the tighter budget rather than the looser one.
export function byMethod(buckets: { read: RequestHandler, write: RequestHandler }): RequestHandler {
    return (req, res, next) => {
        const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
        const bucket = safe ? buckets.read : buckets.write;
        bucket(req, res, next);
    };
}
