import crypto from 'crypto';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

import type { AccountResult, PoppyAccounts } from '../../services/herald/server/src/poppy/api.ts';

// A test Personal Agent that signs real ES256 client assertions, Session
// assertions and DPoP Proofs, its metadata served by an injected fetcher, and
// a fake Herald account adapter. Shared by the Herald and Drawbridge suites.

export const ORIGIN = 'https://archon.test';
export const ISSUER = `${ORIGIN}/names/poppy`;
export const TOKEN = `${ISSUER}/token`;
export const API = `${ISSUER}/api`;
export const AGENT_ID = 'https://agent.example/agent.json';
export const REDIRECT = 'https://agent.example/oauth/callback';
export const ALICE = 'did:cid:alice';
export const BOB = 'did:cid:bob';

export type Docs = Record<string, unknown>;

export class TestAgent {
    private key!: CryptoKey;
    readonly kid: string;
    publicJwk!: JWK;
    dpopKey!: CryptoKey;
    dpopJwk!: JWK;

    constructor(readonly clientId = AGENT_ID) {
        this.kid = clientId === AGENT_ID ? 'agent-key-1' : 'agent-key-2';
    }

    async init(): Promise<this> {
        const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
        this.key = privateKey as CryptoKey;
        this.publicJwk = { ...await exportJWK(publicKey), kid: this.kid, alg: 'ES256', use: 'sig' };
        await this.newDpopKey();
        return this;
    }

    async newDpopKey(): Promise<void> {
        const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
        this.dpopKey = privateKey as CryptoKey;
        this.dpopJwk = await exportJWK(publicKey);
    }

    docs(): Docs {
        return {
            [this.clientId]: {
                client_id: this.clientId,
                client_name: 'Example Agent',
                logo_uri: 'https://agent.example/logo.png',
                jwks_uri: 'https://agent.example/jwks.json',
                redirect_uris: [REDIRECT],
                token_endpoint_auth_method: 'private_key_jwt',
            },
            'https://agent.example/jwks.json': { keys: [this.publicJwk] },
        };
    }

    async assertion(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
        const now = Math.floor(Date.now() / 1000);
        return new SignJWT({ jti: crypto.randomBytes(16).toString('base64url'), ...claims })
            .setProtectedHeader({ alg: 'ES256', kid: this.kid, ...header })
            .setIssuer(this.clientId)
            .setSubject(String(claims.sub ?? this.clientId))
            .setAudience((claims.aud as string) ?? ISSUER)
            .setIssuedAt(now)
            .setExpirationTime(now + 60)
            .sign(this.key);
    }

    async clientAuth(): Promise<Record<string, string>> {
        return {
            client_id: this.clientId,
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: await this.assertion(),
        };
    }

    async proof(method: string, url: string, accessToken?: string, key = this.dpopKey, jwk = this.dpopJwk): Promise<string> {
        const claims: Record<string, unknown> = {
            jti: crypto.randomBytes(16).toString('base64url'),
            htm: method,
            htu: url,
            iat: Math.floor(Date.now() / 1000),
        };
        if (accessToken) {
            claims.ath = crypto.createHash('sha256').update(accessToken).digest('base64url');
        }
        return new SignJWT(claims).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk }).sign(key);
    }
}

// URLs the fetcher was asked for, in order; tests clear it with `.length = 0`.
export const fetches: string[] = [];

export function fetcherFor(docs: () => Docs) {
    return async (url: string) => {
        fetches.push(url);
        const body = docs()[url];
        if (body === undefined) {
            return new Response('not found', { status: 404 });
        }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
}

export function fakeAccounts() {
    let counter = 0;
    const descriptions: string[] = [];
    const users: Record<string, { name?: string; credentialDid?: string }> = {
        [ALICE]: { name: 'alice', credentialDid: 'did:cid:alice-credential' },
        [BOB]: { name: 'bob' },
    };
    const accounts: PoppyAccounts = {
        async createChallenge(_callback: string, description: string) {
            counter += 1;
            descriptions.push(description);
            return `did:cid:challenge-${counter}`;
        },
        async verifyResponse(response: string) {
            const { challenge, responder } = JSON.parse(response);
            return { match: true, challenge, responder };
        },
        async ensureUser(did: string) { users[did] ??= {}; },
        async nameOf(did: string) { return users[did]?.name; },
        async lookupName(name: string) {
            const entry = Object.entries(users).find(([, user]) => user.name === name);
            return entry ? { name, did: entry[0] } : null;
        },
        async member(name: string) { return (await accounts.lookupName(name)) ? { didDocument: { id: name } } : null; },
        async resolveDid(did: string) { return did.startsWith('did:') ? { didDocument: { id: did } } : null; },
        async directory() { return { version: 1, names: { alice: ALICE, bob: BOB } }; },
        async profile(did: string) { return users[did] ? { did, ...users[did] } : null; },
        async credential(did: string): Promise<AccountResult> {
            return users[did]?.credentialDid
                ? { status: 200, body: { credentialDid: users[did].credentialDid } }
                : { status: 404, body: { error: 'credential_not_found' } };
        },
        async setName(did: string, name: unknown): Promise<AccountResult> {
            users[did] = { ...users[did], name: String(name) };
            return { status: 200, body: { ok: true, name } };
        },
        async deleteName(did: string): Promise<AccountResult> {
            delete users[did].name;
            return { status: 200, body: { ok: true } };
        },
    };
    return { accounts, users, descriptions };
}
