import express from 'express';
import { timingSafeEqual } from 'crypto';
import type { GatekeeperApiConfig } from './v1-router-types.js';

const ARCHON_ADMIN_HEADER = 'x-archon-admin-key';

// Admin API key middleware — admin routes require a matching
// X-Archon-Admin-Key header. This provides defense-in-depth even when
// running behind a reverse proxy.
//
// Fails closed: with no key configured the admin routes are refused rather
// than opened. The server entry point (main) additionally refuses to start
// without ARCHON_ADMIN_API_KEY, so a 403 here means the app was constructed
// programmatically without one.
export function createRequireAdminKey(config: GatekeeperApiConfig): express.RequestHandler {
    return function requireAdminKey(req: express.Request, res: express.Response, next: express.NextFunction): void {
        if (!config.adminApiKey) {
            res.status(403).json({ error: 'Admin API key not configured' });
            return;
        }

        const adminHeader = req.headers[ARCHON_ADMIN_HEADER];
        const key = typeof adminHeader === 'string'
            ? adminHeader
            : Array.isArray(adminHeader)
                ? adminHeader[0]
                : null;

        if (!key) {
            res.status(401).json({ error: 'Unauthorized — valid admin API key required' });
            return;
        }

        const keyBuf = Buffer.from(key);
        const expectedBuf = Buffer.from(config.adminApiKey);

        if (keyBuf.length !== expectedBuf.length || !timingSafeEqual(keyBuf, expectedBuf)) {
            res.status(401).json({ error: 'Unauthorized — valid admin API key required' });
            return;
        }

        next();
    };
}
