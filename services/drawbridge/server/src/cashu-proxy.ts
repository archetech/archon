import type express from 'express';

import { publicRateLimit } from './middleware/public-rate-limit.js';
import { proxyRequest } from './proxy.js';
import { ARCHON_ADMIN_HEADER, matchesAdminKey } from './v1-admin.js';
import type { DrawbridgeStore } from './types.js';

export interface CashuProxyOptions {
    store: DrawbridgeStore;
    config: {
        cashuMintURL: string;
        cashuPerSource: number;
        cashuGlobal: number;
        cashuRateLimitWindow: number;
        adminApiKey: string;
    };
    logger: {
        warn: (obj: unknown, msg: string) => void;
        error: (obj: unknown, msg: string) => void;
    };
}

// The node's Cashu mint behind `/cashu`. Mint URLs may carry a path, so the
// public mint URL is `<public host>/cashu` and the mint itself needs no prefix
// support. Only the mint API (`/v1/...`) is forwarded; the mint publishes no
// host port, so this is the only way to it.
export function cashuProxyHandlers(options: CashuProxyOptions): { rateLimit: express.RequestHandler; proxy: express.RequestHandler } {
    const { store, config, logger } = options;

    const limit = publicRateLimit({
        store,
        name: 'cashu',
        readPerSourceMax: config.cashuPerSource,
        readGlobalMax: config.cashuGlobal,
        windowSeconds: config.cashuRateLimitWindow,
        logger,
    });

    // This node's server-side Keymaster carries the admin key, and one
    // Keymaster serves every identity on the node.
    const rateLimit: express.RequestHandler = (req, res, next) => {
        if (matchesAdminKey(req.headers[ARCHON_ADMIN_HEADER], config.adminApiKey)) {
            next();
            return;
        }
        limit(req, res, next);
    };

    const proxy: express.RequestHandler = async (req, res) => {
        if (config.cashuMintURL === '') {
            res.status(501).json({ error: 'Cashu is not enabled on this node' });
            return;
        }
        // The mint is third-party software; it has no use for the node's
        // admin secret.
        delete req.headers[ARCHON_ADMIN_HEADER];
        try {
            await proxyRequest(req, res, config.cashuMintURL, '/cashu', '/v1');
        } catch (error: any) {
            logger.error({ err: error, path: req.originalUrl }, 'Cashu mint proxy error');
            res.status(502).json({ error: 'Upstream cashu mint error' });
        }
    };

    return { rateLimit, proxy };
}

// The public mint URL `GET /cashu-mint` returns. Unlike the DIDComm endpoint
// there is no onion fallback: that would be an http:// URL, which the wallet's
// https-only mint fetch refuses and outside wallets could not redeem against.
export function publicCashuMintUrl(config: { cashuMintURL: string; publicHost: string }): string | null {
    if (config.cashuMintURL === '' || !/^https:\/\//i.test(config.publicHost)) {
        return null;
    }
    return `${config.publicHost.replace(/\/+$/, '')}/cashu`;
}
