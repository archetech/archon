import type { Request, Response, NextFunction } from 'express';
import type { DrawbridgeStore } from '../types.js';
import { checkAndRecordRequest } from '../rate-limiter.js';

// Rate limiting for public passthroughs that carry no identity to key on.
//
// The DIDComm relay behind /didcomm has two routes that are unauthenticated by
// design and cannot be otherwise: a sender must be able to reach a stranger's
// mailbox, and GET /challenge is the first step of proving DID control. So the
// per-DID keying used on the paid path does not apply here.
//
// Two buckets, because neither is sufficient alone:
//
//   per-source  meaningful on clearnet; useless over Tor, where every request
//               arrives from the local daemon and shares one source
//   global      a backstop that holds regardless of source, including Tor
//
// The global bucket is blunt: during a flood it also turns away legitimate
// senders. That is still better than the alternative, where an unbounded flood
// fills the relay's storage caps and legitimate senders are refused anyway, for
// as long as the attacker keeps them full.

export interface PublicRateLimitOptions {
    store: DrawbridgeStore;
    // Namespace so separate surfaces get separate buckets.
    name: string;
    perSourceMax: number;
    globalMax: number;
    windowSeconds: number;
    logger?: { warn: (obj: unknown, msg: string) => void };
}

export function publicRateLimit(options: PublicRateLimitOptions) {
    const { store, name, perSourceMax, globalMax, windowSeconds } = options;

    return async function publicRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
        // `trust proxy` is not configured, so req.ip is the socket peer: the
        // reverse proxy or Tor daemon when there is one in front. That makes the
        // per-source bucket a coarse signal rather than a per-client one, which
        // is why the global bucket exists.
        const source = req.ip || 'unknown';

        try {
            const perSource = await checkAndRecordRequest(store, `${name}:src:${source}`, perSourceMax, windowSeconds);
            const global = await checkAndRecordRequest(store, `${name}:global`, globalMax, windowSeconds);

            if (!perSource.allowed || !global.allowed) {
                const result = perSource.allowed ? global : perSource;
                res.set('Retry-After', String(Math.max(1, result.resetAt - Math.floor(Date.now() / 1000))));
                res.status(429).json({
                    error: 'Rate limit exceeded',
                    resetAt: result.resetAt,
                });
                return;
            }
        }
        catch (error) {
            // Fail open. The limiter protects availability; if its own store is
            // unreachable, refusing every request would cause the outage it is
            // meant to prevent. The relay's storage caps still bound growth.
            options.logger?.warn({ err: error, surface: name }, 'rate limit check failed, allowing request');
        }

        next();
    };
}
