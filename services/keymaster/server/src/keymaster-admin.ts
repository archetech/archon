import express from 'express';
import { timingSafeEqual } from 'crypto';
import type { KeymasterApiConfig } from './keymaster-router-types.js';

const ARCHON_ADMIN_HEADER = 'x-archon-admin-key';

// Minimum length we accept for ARCHON_ADMIN_API_KEY. Below this we warn but
// still start — an existing deployment with a short key should not be bricked
// by an upgrade. `openssl rand -hex 32` (the documented generator) yields 64.
export const MIN_ADMIN_API_KEY_LENGTH = 32;

export interface StartupCheck {
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
export function checkAdminApiKey(adminApiKey: string): StartupCheck {
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

/**
 * Validate ARCHON_ENCRYPTED_PASSPHRASE at startup.
 *
 * Fail closed: the passphrase is both the wallet's encryption secret and the
 * credential POST /login checks before handing back the admin API key. An empty
 * one made /login return that key to any caller, and /login sits ahead of the
 * admin guard because it is how a client obtains the key in the first place.
 *
 * The Keymaster constructor already rejects an empty passphrase, but it runs
 * inside the listen callback where the throw does not stop the server.
 */
export function checkPassphrase(passphrase: string): StartupCheck {
    if (!passphrase) {
        return {
            fatal: 'ARCHON_ENCRYPTED_PASSPHRASE must be set — POST /login would otherwise return the admin API key without checking it.',
        };
    }

    return {};
}

/**
 * Decide what an empty wallet store means for this node.
 *
 * Empty cannot be told apart from lost by looking at the store, so the operator
 * says which it is: with ARCHON_KEYMASTER_REQUIRE_WALLET set, a node that
 * already holds an identity refuses rather than mint a new one over it.
 * Otherwise provisioning goes ahead, with a warning that names the store so a
 * node that has run before is not silently replaced.
 */
export function checkWalletStore(missing: boolean, requireWallet: boolean, db: string): StartupCheck {
    if (!missing) {
        return {};
    }

    if (requireWallet) {
        return {
            fatal: `No wallet in ${db} and ARCHON_KEYMASTER_REQUIRE_WALLET is set — refusing to mint a new identity. Check that the data volume is mounted and ARCHON_KEYMASTER_DB matches the store this node was using.`,
        };
    }

    return {
        warning: `No wallet found in ${db} — creating one. If this node has run before, its store is missing and its identity has been replaced. Set ARCHON_KEYMASTER_REQUIRE_WALLET=true to make this fatal.`,
    };
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
