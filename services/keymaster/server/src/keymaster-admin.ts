import express from 'express';
import { timingSafeEqual } from 'crypto';
import type { KeymasterApiConfig } from './keymaster-router-types.js';

const ARCHON_ADMIN_HEADER = 'x-archon-admin-key';

// Minimum length we accept for ARCHON_ADMIN_API_KEY. Below this we warn but
// still start — an existing deployment with a short key should not be bricked
// by an upgrade. `openssl rand -hex 32` (the documented generator) yields 64.
export const MIN_ADMIN_API_KEY_LENGTH = 32;

export interface AdminApiKeyCheck {
    // Set when the key is unusable and the process must not start.
    fatal?: string;
    // Set when the key works but is weak enough to be worth flagging.
    warning?: string;
}

/**
 * Validate ARCHON_ADMIN_API_KEY at startup.
 *
 * Fail closed: the guard covers the entire v1 router, not an admin subset, so
 * an unset key leaves wallet, identity, credential and Lightning operations
 * reachable by anyone who can open the port. Gatekeeper already refuses to
 * start on the same variable and starts unconditionally in every compose
 * stack, so no working node reaches this check with the key blank.
 *
 * Split out from the entry point so the rule is testable without spawning a
 * process.
 */
export function checkAdminApiKey(adminApiKey: string): AdminApiKeyCheck {
    if (!adminApiKey) {
        return {
            fatal: 'ARCHON_ADMIN_API_KEY must be set — the API would otherwise be unauthenticated. Generate one with: openssl rand -hex 32',
        };
    }

    if (adminApiKey.length < MIN_ADMIN_API_KEY_LENGTH) {
        return {
            warning: `Warning: ARCHON_ADMIN_API_KEY is shorter than ${MIN_ADMIN_API_KEY_LENGTH} characters — regenerate it with: openssl rand -hex 32`,
        };
    }

    return {};
}

// Admin API key middleware — every route mounted after it requires a matching
// X-Archon-Admin-Key header. This provides defense-in-depth even when running
// behind a reverse proxy.
//
// Fails closed: with no key configured the routes are refused rather than
// opened. The server entry point additionally refuses to start without
// ARCHON_ADMIN_API_KEY, so a 403 here means the app was constructed
// programmatically without one.
export function createRequireAdminKey(config: KeymasterApiConfig): express.RequestHandler {
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
