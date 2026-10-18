import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify, type JWTPayload } from 'jose';
import type { Agent, AgentDirectory } from './agents.js';
import type { PoppyKV } from './kv.js';

// Client assertions (spec 4.1, RFC 7523) and Session assertions (4.2), both
// signed with a key from the Personal Agent's jwks_uri and addressed to this
// Company's issuer as a single string.

export const ASSERTION_ALGORITHMS = ['ES256', 'RS256'];
const CLOCK_SKEW_SECONDS = 30;
const MAX_LIFETIME_SECONDS = 5 * 60;
const MIN_JTI_LENGTH = 16;

export class AssertionError extends Error {}

// Header types that belong to other uses and must never authenticate a token
// request: a browser assertion (spec 5) and a DPoP Proof (4.3).
const FOREIGN_TYPES = new Set(['poppy-browser+jwt', 'dpop+jwt']);

async function verifyWithAgentKeys(token: string, agent: Agent, directory: AgentDirectory, issuer: string) {
    const options = {
        algorithms: ASSERTION_ALGORITHMS,
        audience: issuer,
        clockTolerance: CLOCK_SKEW_SECONDS,
        requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'jti'],
    };
    try {
        return await jwtVerify(token, createLocalJWKSet(agent.jwks), options);
    }
    catch (error) {
        // An unknown kid may mean the agent rotated keys; refetch, throttled.
        if (error instanceof errors.JWKSNoMatchingKey) {
            const refreshed = await directory.get(agent.clientId, true);
            return jwtVerify(token, createLocalJWKSet(refreshed.jwks), options);
        }
        throw error;
    }
}

export interface VerifiedAssertion {
    payload: JWTPayload;
}

export async function verifyAssertion(
    token: unknown,
    agent: Agent,
    directory: AgentDirectory,
    issuer: string,
    kv: PoppyKV,
    now: () => number = Date.now,
): Promise<VerifiedAssertion> {
    if (typeof token !== 'string' || !token) {
        throw new AssertionError('assertion is missing');
    }
    let header;
    try {
        header = decodeProtectedHeader(token);
    }
    catch {
        throw new AssertionError('assertion is malformed');
    }
    if (typeof header.typ === 'string' && FOREIGN_TYPES.has(header.typ.toLowerCase())) {
        throw new AssertionError(`a ${header.typ} cannot be used here`);
    }
    if ('jku' in header || 'x5u' in header || 'jwk' in header) {
        // Keys come only from the agent's verified jwks_uri.
        throw new AssertionError('assertion header may not name its own key');
    }

    let payload: JWTPayload;
    try {
        ({ payload } = await verifyWithAgentKeys(token, agent, directory, issuer));
    }
    catch (error) {
        if (error instanceof AssertionError) {
            throw error;
        }
        throw new AssertionError(error instanceof Error ? `assertion rejected: ${error.message}` : 'assertion rejected');
    }

    // jose accepts an audience array that contains the issuer; the spec does not.
    if (payload.aud !== issuer) {
        throw new AssertionError('aud must be the issuer as a single string');
    }
    if (payload.iss !== agent.clientId) {
        throw new AssertionError('iss must be the client_id');
    }
    const iat = payload.iat!;
    const exp = payload.exp!;
    const nowSeconds = Math.floor(now() / 1000);
    if (iat > nowSeconds + CLOCK_SKEW_SECONDS) {
        throw new AssertionError('assertion was issued in the future');
    }
    if (exp - iat > MAX_LIFETIME_SECONDS) {
        throw new AssertionError('assertion lifetime is too long');
    }
    if (typeof payload.jti !== 'string' || payload.jti.length < MIN_JTI_LENGTH) {
        throw new AssertionError('jti must carry at least 128 random bits');
    }
    const ttl = Math.max(1, exp - nowSeconds + CLOCK_SKEW_SECONDS);
    if (!await kv.setIfAbsent(`jti:assertion:${agent.clientId}:${payload.jti}`, '1', ttl)) {
        throw new AssertionError('assertion has already been used');
    }
    return { payload };
}
