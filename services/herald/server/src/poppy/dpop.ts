import crypto from 'crypto';
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import type { PoppyKV } from './kv.js';

// DPoP Proof validation (RFC 9449 §4.3, spec 4.3). htu is compared with the
// public URL the agent used, built from the configured origin rather than the
// Host header, because Herald sits behind Drawbridge.

export const DPOP_ALGORITHMS = ['ES256', 'RS256'];
const ACCEPTANCE_WINDOW_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 30;
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];

export class DpopError extends Error {}

export interface DpopCheck {
    header: string | string[] | undefined;
    method: string;
    url: string;
    accessToken?: string;
}

export function normalizeHtu(value: string): string {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.href;
}

export function accessTokenHash(token: string): string {
    return crypto.createHash('sha256').update(token, 'ascii').digest('base64url');
}

// Returns the proof key's JWK thumbprint, which binds a Session Token.
export async function verifyDpopProof(check: DpopCheck, kv: PoppyKV, now: () => number = Date.now): Promise<string> {
    const { header } = check;
    // Node joins repeated unknown headers with ", "; a compact JWT has no comma.
    if (typeof header !== 'string' || !header || header.includes(',')) {
        throw new DpopError('exactly one DPoP header is required');
    }

    let protectedHeader;
    try {
        protectedHeader = decodeProtectedHeader(header);
    }
    catch {
        throw new DpopError('DPoP proof is malformed');
    }
    if (protectedHeader.typ !== 'dpop+jwt') {
        throw new DpopError('DPoP proof typ must be dpop+jwt');
    }
    if (typeof protectedHeader.alg !== 'string' || !DPOP_ALGORITHMS.includes(protectedHeader.alg)) {
        throw new DpopError('DPoP proof alg is not supported');
    }
    const jwk = protectedHeader.jwk as JWK | undefined;
    if (!jwk || typeof jwk !== 'object' || PRIVATE_JWK_MEMBERS.some(member => member in jwk)) {
        throw new DpopError('DPoP proof jwk must be a public key');
    }

    let payload;
    try {
        const key = await importJWK(jwk, protectedHeader.alg);
        ({ payload } = await jwtVerify(header, key, {
            typ: 'dpop+jwt',
            algorithms: DPOP_ALGORITHMS,
            requiredClaims: ['jti', 'htm', 'htu', 'iat'],
        }));
    }
    catch (error) {
        throw new DpopError(error instanceof Error ? `DPoP proof rejected: ${error.message}` : 'DPoP proof rejected');
    }

    if (payload.htm !== check.method) {
        throw new DpopError('DPoP proof htm does not match the request');
    }
    let htu: string;
    try {
        htu = normalizeHtu(String(payload.htu));
    }
    catch {
        throw new DpopError('DPoP proof htu is not a URL');
    }
    if (htu !== normalizeHtu(check.url)) {
        throw new DpopError('DPoP proof htu does not match the request');
    }
    const nowSeconds = Math.floor(now() / 1000);
    const iat = payload.iat!;
    if (iat > nowSeconds + CLOCK_SKEW_SECONDS || iat < nowSeconds - ACCEPTANCE_WINDOW_SECONDS - CLOCK_SKEW_SECONDS) {
        throw new DpopError('DPoP proof is outside the acceptance window');
    }
    if (check.accessToken !== undefined && payload.ath !== accessTokenHash(check.accessToken)) {
        throw new DpopError('DPoP proof ath does not match the Session Token');
    }
    if (typeof payload.jti !== 'string' || !payload.jti) {
        throw new DpopError('DPoP proof jti is missing');
    }

    const thumbprint = await calculateJwkThumbprint(jwk, 'sha256');
    // The replay cache is shared through the store, so it covers every Herald
    // process. The token endpoint must have one; APIs check it too.
    const ttl = ACCEPTANCE_WINDOW_SECONDS + 2 * CLOCK_SKEW_SECONDS;
    if (!await kv.setIfAbsent(`jti:dpop:${thumbprint}:${payload.jti}`, '1', ttl)) {
        throw new DpopError('DPoP proof has already been used');
    }
    return thumbprint;
}
