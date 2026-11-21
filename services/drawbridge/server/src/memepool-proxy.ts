import type express from 'express';
import { proxyRequest } from './proxy.js';

// The public face of the node's Memepool service: its pages at `<node>/memepool/`
// and its API at `<node>/memepool/api/v1/...`. The mount's prefix is stripped.
//
// Under `/api` only the service's `/api/v1` is reachable, by the methods it
// uses. Anything else under the mount is a page or a file of one, which is read
// and never written: only GET and HEAD reach it.
//
// A preflight (OPTIONS) does not reach here: the node's CORS handling answers
// it first, for any origin and without credentials, as on every mount.
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
        // The path as the service will see it, with dot segments resolved, so
        // that one written to look like a page cannot reach the API.
        const path = new URL(req.originalUrl.replace(/^\/memepool/, '') || '/', 'http://memepool').pathname;
        const api = path === '/api' || path.startsWith('/api/');
        const reading = req.method === 'GET' || req.method === 'HEAD';

        if (api ? !METHODS.has(req.method) : !reading) {
            res.status(405).json({ error: 'Method not allowed' });
            return;
        }
        // `/memepool` names the pages' directory, and a page's own files are
        // found relative to it.
        if (req.originalUrl.split('?')[0] === '/memepool') {
            res.redirect(308, '/memepool/');
            return;
        }
        try {
            await proxyRequest(req, res, memepoolURL, '/memepool', api ? '/api/v1' : undefined, '/memepool');
        } catch (error: any) {
            logger?.error({ err: error, path: req.originalUrl }, 'Memepool proxy error');
            res.status(502).json({ error: 'Upstream memepool error' });
        }
    };
}
