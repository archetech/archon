import type express from 'express';
import { proxyRequest } from './proxy.js';

// The public face of the node's Memeplex indexer: `<node>/memeplex/api/v1/...`.
// The index is read-only, and only its API is reachable: the mount's prefix is
// stripped and what is left has to stay under /api/v1, which keeps the indexer's
// /metrics off the public side.

export interface MemeplexProxyOptions {
    // The indexer's base URL, or empty when the node runs none.
    indexerURL: string;
    logger?: { error(detail: unknown, message: string): void };
}

export function memeplexProxy({ indexerURL, logger }: MemeplexProxyOptions): express.RequestHandler {
    return async (req, res) => {
        if (indexerURL === '') {
            res.status(501).json({ error: 'Memeplex is not enabled on this node' });
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.status(405).json({ error: 'Method not allowed' });
            return;
        }
        try {
            await proxyRequest(req, res, indexerURL, '/memeplex', '/api/v1');
        } catch (error: any) {
            logger?.error({ err: error, path: req.originalUrl }, 'Memeplex indexer proxy error');
            res.status(502).json({ error: 'Upstream memeplex indexer error' });
        }
    };
}
