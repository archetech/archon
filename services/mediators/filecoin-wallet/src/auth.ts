import express from 'express';
import { timingSafeEqual } from 'crypto';

const ARCHON_ADMIN_HEADER = 'x-archon-admin-key';

export function requireAdminKeyFor(expectedKey?: string) {
    return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
        if (!expectedKey) {
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

        const keyBuf = Buffer.from(key);
        const expectedBuf = Buffer.from(expectedKey);

        if (keyBuf.length !== expectedBuf.length || !timingSafeEqual(keyBuf, expectedBuf)) {
            res.status(401).json({ error: 'Invalid admin API key' });
            return;
        }

        next();
    };
}
