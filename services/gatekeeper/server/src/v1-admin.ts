import express from 'express';
import type { GatekeeperApiConfig } from './v1-router-types.js';

const ARCHON_ADMIN_HEADER = 'x-archon-admin-key';

// Admin API key middleware — when ARCHON_ADMIN_API_KEY is set, admin
// routes require a matching X-Archon-Admin-Key header.
// This provides defense-in-depth even when running behind a reverse proxy.
export function createRequireAdminKey(config: GatekeeperApiConfig): express.RequestHandler {
    return function requireAdminKey(req: express.Request, res: express.Response, next: express.NextFunction): void {
        if (!config.adminApiKey) {
            // No key configured — admin routes are unprotected (development mode).
            // In production, set ARCHON_ADMIN_API_KEY to enable protection.
            next();
            return;
        }

        const adminHeader = req.headers[ARCHON_ADMIN_HEADER];
        const key = typeof adminHeader === 'string'
            ? adminHeader
            : Array.isArray(adminHeader)
                ? adminHeader[0]
                : null;

        if (!key || key !== config.adminApiKey) {
            res.status(401).json({ error: 'Unauthorized — valid admin API key required' });
            return;
        }
        next();
    };
}
