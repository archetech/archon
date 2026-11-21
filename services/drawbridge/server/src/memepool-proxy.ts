import type express from 'express';
import { proxyRequest } from './proxy.js';

// The public face of the node's Memepool service: `<node>/memepool/api/v1/...`.
// Only the service's API is reachable: the mount's prefix is stripped and what
// is left has to stay under /api/v1.
//
// The service signs users in and keeps them signed in with cookies, which it
// sets for all its own paths. Here they are set for this mount, so that a
// browser sends them back to Memepool and to nothing else the node serves.

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE']);

export interface MemepoolProxyOptions {
    // The service's base URL, or empty when the node runs none.
    memepoolURL: string;
    logger?: { error(detail: unknown, message: string): void };
}

export function memepoolProxy({ memepoolURL, logger }: MemepoolProxyOptions): express.RequestHandler {
    return async (req, res) => {
        if (memepoolURL === '') {
            res.status(501).json({ error: 'Memepool is not enabled on this node' });
            return;
        }
        if (!METHODS.has(req.method)) {
            res.status(405).json({ error: 'Method not allowed' });
            return;
        }
        try {
            await proxyRequest(req, res, memepoolURL, '/memepool', '/api/v1', '/memepool');
        } catch (error: any) {
            logger?.error({ err: error, path: req.originalUrl }, 'Memepool proxy error');
            res.status(502).json({ error: 'Upstream memepool error' });
        }
    };
}
