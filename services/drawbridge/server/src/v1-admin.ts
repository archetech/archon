import express from 'express';
import { timingSafeEqual } from 'crypto';
import type { DrawbridgeApiConfig } from './v1-router-types.js';

export const ARCHON_ADMIN_HEADER = 'x-archon-admin-key';

// Shared by admin routes and the L402 exemption. An unset key never authenticates.
export function matchesAdminKey(header: string | string[] | undefined, expected?: string): boolean {
    const key = Array.isArray(header) ? header[0] : header;
    if (!key || !expected) return false;
    const keyBuf = Buffer.from(key);
    const expectedBuf = Buffer.from(expected);
    return keyBuf.length === expectedBuf.length && timingSafeEqual(keyBuf, expectedBuf);
}

// Admin API key middleware — admin routes require a matching X-Archon-Admin-Key
// header. This provides defense-in-depth even when running behind a reverse proxy.
export function createRequireAdminKey(config: DrawbridgeApiConfig): express.RequestHandler {
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
            res.status(401).json({ error: 'Admin API key required' });
            return;
        }

        if (!matchesAdminKey(key, config.adminApiKey)) {
            res.status(401).json({ error: 'Invalid admin API key' });
            return;
        }

        next();
    };
}
