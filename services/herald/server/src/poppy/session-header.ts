import {
    calculateJwkThumbprint,
    createLocalJWKSet,
    decodeJwt,
    decodeProtectedHeader,
    errors,
    importJWK,
    jwtVerify,
    type JWK,
    type JWTPayload,
    type ProtectedHeaderParameters,
} from 'jose';
import { AgentError, type Agent } from './agents.js';
import { accessTokenHash, normalizeHtu } from './dpop.js';
import type { PoppyKV } from './kv.js';

// Verifies the Poppy-Session header (spec 0.4, sections 5.2 and 5.3) and the
// Poppy-Version header that travels with it (3.4). The header holds a JWT the
// Personal Agent signs for one request with a delegated key; a key from the
// agent's jwks_uri vouches for that key in a delegation the JWT carries.
//
// A verified header says which agent, User and Session a request is from. It
// never grants account access: that is the access token's job.

export const SESSION_ALGORITHM = 'ES256';
export const DELEGATION_ALGORITHMS = ['ES256', 'PS384'];
const SESSION_TYPE = 'poppy-session+jwt';
const DELEGATION_TYPE = 'poppy-delegation+jwt';
const MAX_DELEGATION_SECONDS = 24 * 60 * 60;
const ACCEPTANCE_WINDOW_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 30;
const MIN_JTI_LENGTH = 16;
const MAX_ID_LENGTH = 255;
// The characters of Conversation IDs (8.2), which Session IDs share.
const SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/;
const VERSION = /^(\d+)\.(\d+)$/;
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];
// A JWT here is verified only with keys reached through the agent's jwks_uri.
const KEY_NAMING_HEADERS = ['jku', 'x5u', 'jwk', 'x5c'];

export type SessionErrorCode = 'invalid_session' | 'version_unsupported';

// Both codes are answered with HTTP 400 and a JSON body (5.3, 3.4).
export class SessionHeaderError extends Error {
    constructor(readonly code: SessionErrorCode, description: string) {
        super(description);
    }
}

export interface SessionCheck {
    header: string | string[] | undefined;
    version: string | string[] | undefined;
    method: string;
    // The public URL the agent called, as for a DPoP Proof.
    url: string;
    // The request's access token and the client it was issued to, when signed in.
    accessToken?: { token: string; clientId: string };
}

export interface SessionVerifier {
    // The Company's identifier (3.2): the audience of every Session JWT.
    issuer: string;
    // The protocol versions served, as `major.minor`.
    versions: string[];
    // Loads the agent's metadata and keys. An AgentError refuses the client;
    // anything else it throws, such as a rate limit, is passed on.
    loadAgent(clientId: string, refreshKeys?: boolean): Promise<Agent>;
    kv: PoppyKV;
    now?: () => number;
}

export interface VerifiedSession {
    clientId: string;
    sessionId: string;
    userId: string;
    agentId?: string;
}

function invalid(description: string): SessionHeaderError {
    return new SessionHeaderError('invalid_session', description);
}

// Two versions are compatible with the same major version and, before 1.0,
// the same minor version (3.4).
export function versionServed(value: unknown, served: string[]): boolean {
    const asked = typeof value === 'string' ? VERSION.exec(value) : null;
    if (!asked) {
        return false;
    }
    return served.some(version => {
        const ours = VERSION.exec(version);
        return ours !== null && ours[1] === asked[1] && (asked[1] !== '0' || ours[2] === asked[2]);
    });
}

function protectedHeader(token: string, what: string): ProtectedHeaderParameters {
    let header: ProtectedHeaderParameters;
    try {
        header = decodeProtectedHeader(token);
    }
    catch {
        throw invalid(`${what} is malformed`);
    }
    if (KEY_NAMING_HEADERS.some(name => name in header)) {
        throw invalid(`${what} header may not name its own key`);
    }
    return header;
}

async function verifyDelegation(token: string, clientId: string, verifier: SessionVerifier, nowSeconds: number) {
    const header = protectedHeader(token, 'delegation');
    if (header.typ !== DELEGATION_TYPE) {
        throw invalid(`delegation typ must be ${DELEGATION_TYPE}`);
    }
    if (typeof header.kid !== 'string' || !header.kid) {
        throw invalid('delegation kid must name a key in jwks_uri');
    }
    const options = {
        algorithms: DELEGATION_ALGORITHMS,
        typ: DELEGATION_TYPE,
        issuer: clientId,
        clockTolerance: CLOCK_SKEW_SECONDS,
        currentDate: new Date(nowSeconds * 1000),
        requiredClaims: ['iss', 'iat', 'exp', 'jti', 'cnf'],
    };
    let payload: JWTPayload;
    try {
        const agent = await verifier.loadAgent(clientId);
        try {
            ({ payload } = await jwtVerify(token, createLocalJWKSet(agent.jwks), options));
        }
        catch (error) {
            // An unknown kid may mean the agent rotated keys; refetch, throttled.
            if (!(error instanceof errors.JWKSNoMatchingKey)) {
                throw error;
            }
            const refreshed = await verifier.loadAgent(clientId, true);
            ({ payload } = await jwtVerify(token, createLocalJWKSet(refreshed.jwks), options));
        }
    }
    catch (error) {
        if (error instanceof AgentError) {
            throw invalid(`client_id refused: ${error.message}`);
        }
        if (error instanceof errors.JOSEError) {
            throw invalid(`delegation rejected: ${error.message}`);
        }
        throw error;
    }

    const iat = payload.iat!;
    const exp = payload.exp!;
    if (iat > nowSeconds + CLOCK_SKEW_SECONDS) {
        throw invalid('delegation was issued in the future');
    }
    if (exp - iat > MAX_DELEGATION_SECONDS) {
        throw invalid('delegation lasts longer than 24 hours');
    }
    const jwk = (payload.cnf as { jwk?: JWK } | undefined)?.jwk;
    if (!jwk || typeof jwk !== 'object' || PRIVATE_JWK_MEMBERS.some(member => member in jwk)) {
        throw invalid('delegation cnf.jwk must be a public key');
    }
    return { jwk, exp };
}

export async function verifySessionHeader(check: SessionCheck, verifier: SessionVerifier): Promise<VerifiedSession> {
    const nowSeconds = Math.floor((verifier.now ?? Date.now)() / 1000);

    if (!versionServed(check.version, verifier.versions)) {
        throw new SessionHeaderError('version_unsupported', 'Poppy-Version is missing or not served');
    }

    const { header: token } = check;
    // Node joins repeated unknown headers with ", "; a compact JWT has no comma.
    if (typeof token !== 'string' || !token || token.includes(',')) {
        throw invalid('exactly one Poppy-Session header is required');
    }
    const header = protectedHeader(token, 'Session JWT');
    if (header.typ !== SESSION_TYPE) {
        throw invalid(`Session JWT typ must be ${SESSION_TYPE}`);
    }
    if (header.alg !== SESSION_ALGORITHM) {
        throw invalid(`Session JWT alg must be ${SESSION_ALGORITHM}`);
    }
    // A JWT signed directly with a key from jwks_uri has no delegation.
    const delegation = (header as { poppy_dlg?: unknown }).poppy_dlg;
    if (typeof delegation !== 'string' || !delegation) {
        throw invalid('Session JWT carries no delegation');
    }

    let clientId: unknown;
    try {
        clientId = decodeJwt(token).iss;
    }
    catch {
        throw invalid('Session JWT is malformed');
    }
    if (typeof clientId !== 'string' || !clientId) {
        throw invalid('Session JWT iss must be the client_id');
    }

    const delegated = await verifyDelegation(delegation, clientId, verifier, nowSeconds);

    let payload: JWTPayload;
    try {
        ({ payload } = await jwtVerify(token, await importJWK(delegated.jwk, SESSION_ALGORITHM), {
            algorithms: [SESSION_ALGORITHM],
            typ: SESSION_TYPE,
            clockTolerance: CLOCK_SKEW_SECONDS,
            currentDate: new Date(nowSeconds * 1000),
            requiredClaims: ['iss', 'aud', 'sid', 'sub', 'htm', 'htu', 'iat', 'jti'],
        }));
        if (header.kid !== await calculateJwkThumbprint(delegated.jwk, 'sha256')) {
            throw invalid('Session JWT kid must be the delegated key\'s thumbprint');
        }
    }
    catch (error) {
        if (error instanceof SessionHeaderError) {
            throw error;
        }
        throw invalid(error instanceof Error ? `Session JWT rejected: ${error.message}` : 'Session JWT rejected');
    }

    // jose accepts an audience array that contains the issuer; the spec does not.
    if (payload.aud !== verifier.issuer) {
        throw invalid('aud must be the Company\'s identifier as a single string');
    }
    const { sid, sub, agent_id: agentId, jti } = payload as JWTPayload & { sid?: unknown; agent_id?: unknown };
    if (typeof sid !== 'string' || !SESSION_ID.test(sid)) {
        throw invalid('sid is not a Session ID');
    }
    if (typeof sub !== 'string' || !sub || sub.length > MAX_ID_LENGTH) {
        throw invalid('sub must be the User ID');
    }
    if (agentId !== undefined && (typeof agentId !== 'string' || !agentId || agentId.length > MAX_ID_LENGTH)) {
        throw invalid('agent_id must be an Agent ID');
    }
    if (payload.htm !== check.method) {
        throw invalid('htm does not match the request');
    }
    let htu: string;
    try {
        htu = normalizeHtu(String(payload.htu));
    }
    catch {
        throw invalid('htu is not a URL');
    }
    if (htu !== normalizeHtu(check.url)) {
        throw invalid('htu does not match the request');
    }
    const iat = payload.iat!;
    if (iat > nowSeconds + CLOCK_SKEW_SECONDS || iat < nowSeconds - ACCEPTANCE_WINDOW_SECONDS - CLOCK_SKEW_SECONDS) {
        throw invalid('Session JWT is outside the acceptance window');
    }
    if (iat > delegated.exp + CLOCK_SKEW_SECONDS) {
        throw invalid('Session JWT was signed after its delegation expired');
    }
    if (typeof jti !== 'string' || jti.length < MIN_JTI_LENGTH) {
        throw invalid('jti must carry at least 128 random bits');
    }

    // ath shows the header covers these token bytes; the client check shows the
    // token and the header belong to the same agent (5.3, step 3).
    const { accessToken } = check;
    if (accessToken) {
        if (payload.ath !== accessTokenHash(accessToken.token)) {
            throw invalid('ath does not match the access token');
        }
        if (accessToken.clientId !== clientId) {
            throw invalid('the access token was issued to another client');
        }
    }
    else if (payload.ath !== undefined) {
        throw invalid('ath is present without an access token');
    }

    // One second longer than the longest a JWT stays acceptable, from one
    // signed the full skew ahead, so the entry cannot expire first.
    const ttl = ACCEPTANCE_WINDOW_SECONDS + 2 * CLOCK_SKEW_SECONDS + 1;
    if (!await verifier.kv.setIfAbsent(`jti:session:${clientId}:${jti}`, '1', ttl)) {
        throw invalid('Session JWT has already been used');
    }

    return {
        clientId,
        sessionId: sid,
        userId: sub,
        ...(typeof agentId === 'string' && { agentId }),
    };
}
