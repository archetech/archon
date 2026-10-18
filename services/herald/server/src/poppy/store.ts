import crypto from 'crypto';
import type { PoppyKV } from './kv.js';

// Durable Poppy state. Bearer secrets (Session Tokens, Account Tokens,
// authorization and device codes) are stored only as SHA-256 hashes.

export interface Session {
    id: string;
    clientId: string;
    userId: string;
    createdAt: number;
    expiresAt: number;
    // The account (DID) this Session has ever been signed in to. It never
    // changes once set, even after sign-out (spec 4.4).
    account?: string;
    // The Account Token grant it is signed in with now, if any.
    grantId?: string;
}

export interface SessionToken {
    sessionId: string;
    clientId: string;
    userId: string;
    jkt: string;
    scope: string[];
    signedIn: boolean;
    grantId?: string;
    did?: string;
    expiresAt: number;
}

export interface Grant {
    id: string;
    tokenHash: string;
    clientId: string;
    clientName: string;
    domain: string;
    userId: string;
    did: string;
    scope: string[];
    createdAt: number;
    expiresAt: number;
    lastUsedAt: number;
}

export interface AuthCode {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    did: string;
    scope: string[];
}

export type SignInKind = 'direct' | 'device';

export interface SignIn {
    id: string;
    kind: SignInKind;
    browserSecretHash: string;
    csrfHash: string;
    clientId: string;
    clientName: string;
    logoUri?: string;
    domain: string;
    scope: string[];
    redirectUri?: string;
    state?: string;
    codeChallenge?: string;
    deviceCodeHash?: string;
    userCode?: string;
    challenge?: string;
    did?: string;
    name?: string;
    status: 'pending' | 'authenticated' | 'done';
    expiresAt: number;
}

export interface DeviceAuthorization {
    clientId: string;
    scope: string[];
    userCode: string;
    status: 'pending' | 'approved' | 'denied';
    did?: string;
    grantedScope?: string[];
    interval: number;
    lastPollAt?: number;
    expiresAt: number;
}

export function randomSecret(prefix: string, bytes = 32): string {
    return `${prefix}${crypto.randomBytes(bytes).toString('base64url')}`;
}

export function hashSecret(secret: string): string {
    return crypto.createHash('sha256').update(secret, 'utf8').digest('base64url');
}

const DEVICE_GRACE_MS = 10 * 60 * 1000;

function ttlUntil(expiresAt: number, now: number): number {
    return Math.max(1, Math.ceil((expiresAt - now) / 1000));
}

export class PoppyStore {
    constructor(readonly kv: PoppyKV, private readonly now: () => number = Date.now) {}

    private async getJson<T>(key: string): Promise<T | null> {
        const raw = await this.kv.get(key);
        return raw ? JSON.parse(raw) as T : null;
    }

    private async putJson(key: string, value: unknown, expiresAt: number): Promise<void> {
        await this.kv.set(key, JSON.stringify(value), ttlUntil(expiresAt, this.now()));
    }

    // Sessions

    async putSession(session: Session): Promise<void> {
        await this.putJson(`session:${session.id}`, session, session.expiresAt);
    }

    async getSession(id: unknown): Promise<Session | null> {
        if (typeof id !== 'string' || !id) {
            return null;
        }
        const session = await this.getJson<Session>(`session:${id}`);
        return session && session.expiresAt > this.now() ? session : null;
    }

    // Session Tokens

    async putSessionToken(token: string, record: SessionToken): Promise<void> {
        await this.putJson(`stoken:${hashSecret(token)}`, record, record.expiresAt);
    }

    async getSessionToken(token: string): Promise<SessionToken | null> {
        const record = await this.getJson<SessionToken>(`stoken:${hashSecret(token)}`);
        return record && record.expiresAt > this.now() ? record : null;
    }

    // Account Token grants

    async putGrant(grant: Grant): Promise<void> {
        await this.putJson(`grant:${grant.id}`, grant, grant.expiresAt);
        await this.kv.set(`grant-token:${grant.tokenHash}`, grant.id, ttlUntil(grant.expiresAt, this.now()));
        await this.kv.addToSet(`grants-by-did:${grant.did}`, grant.id);
    }

    async getGrant(id: string): Promise<Grant | null> {
        const grant = await this.getJson<Grant>(`grant:${id}`);
        return grant && grant.expiresAt > this.now() ? grant : null;
    }

    async getGrantByToken(token: unknown): Promise<Grant | null> {
        if (typeof token !== 'string' || !token) {
            return null;
        }
        const id = await this.kv.get(`grant-token:${hashSecret(token)}`);
        return id ? this.getGrant(id) : null;
    }

    async touchGrant(grant: Grant): Promise<void> {
        await this.putJson(`grant:${grant.id}`, { ...grant, lastUsedAt: this.now() }, grant.expiresAt);
    }

    async addGrantSession(grantId: string, sessionId: string): Promise<void> {
        await this.kv.addToSet(`grant-sessions:${grantId}`, sessionId);
    }

    async listGrantsForDid(did: string): Promise<Grant[]> {
        const ids = await this.kv.members(`grants-by-did:${did}`);
        const grants: Grant[] = [];
        for (const id of ids) {
            const grant = await this.getGrant(id);
            if (grant) {
                grants.push(grant);
            } else {
                await this.kv.removeFromSet(`grants-by-did:${did}`, id);
            }
        }
        return grants;
    }

    // Revokes a grant and signs out every Session signed in with it. The
    // Sessions continue signed out and keep their account (spec 4.9).
    async revokeGrant(grant: Grant): Promise<void> {
        await this.kv.del(`grant:${grant.id}`);
        await this.kv.del(`grant-token:${grant.tokenHash}`);
        await this.kv.removeFromSet(`grants-by-did:${grant.did}`, grant.id);
        for (const sessionId of await this.kv.members(`grant-sessions:${grant.id}`)) {
            const session = await this.getSession(sessionId);
            if (session?.grantId === grant.id) {
                await this.putSession({ ...session, grantId: undefined });
            }
        }
        await this.kv.del(`grant-sessions:${grant.id}`);
    }

    // Authorization codes, single use

    async putAuthCode(code: string, record: AuthCode, expiresAt: number): Promise<void> {
        await this.putJson(`code:${hashSecret(code)}`, record, expiresAt);
    }

    async takeAuthCode(code: unknown): Promise<AuthCode | null> {
        if (typeof code !== 'string' || !code) {
            return null;
        }
        const raw = await this.kv.take(`code:${hashSecret(code)}`);
        return raw ? JSON.parse(raw) as AuthCode : null;
    }

    // Sign-in requests in progress, for both Direct and Device Sign-In

    async putSignIn(signIn: SignIn): Promise<void> {
        await this.putJson(`signin:${signIn.id}`, signIn, signIn.expiresAt);
        if (signIn.challenge) {
            await this.kv.set(`challenge:${signIn.challenge}`, signIn.id, ttlUntil(signIn.expiresAt, this.now()));
        }
    }

    async getSignIn(id: unknown): Promise<SignIn | null> {
        if (typeof id !== 'string' || !id) {
            return null;
        }
        const signIn = await this.getJson<SignIn>(`signin:${id}`);
        return signIn && signIn.expiresAt > this.now() ? signIn : null;
    }

    async getSignInByChallenge(challenge: string): Promise<SignIn | null> {
        const id = await this.kv.get(`challenge:${challenge}`);
        return id ? this.getSignIn(id) : null;
    }

    // Device authorizations

    async putDevice(deviceCode: string, record: DeviceAuthorization): Promise<void> {
        await this.putDeviceByHash(hashSecret(deviceCode), record);
    }

    async putDeviceByHash(hash: string, record: DeviceAuthorization): Promise<void> {
        // Kept past expires_in so a late poll gets expired_token, not invalid_grant.
        await this.putJson(`device:${hash}`, record, record.expiresAt + DEVICE_GRACE_MS);
        await this.kv.set(`usercode:${record.userCode}`, hash, ttlUntil(record.expiresAt, this.now()));
    }

    async getDeviceByHash(hash: string): Promise<DeviceAuthorization | null> {
        return this.getJson<DeviceAuthorization>(`device:${hash}`);
    }

    async getDeviceHashByUserCode(userCode: string): Promise<string | null> {
        return this.kv.get(`usercode:${userCode}`);
    }

    async deleteDevice(hash: string, userCode: string): Promise<void> {
        await this.kv.del(`device:${hash}`);
        await this.kv.del(`usercode:${userCode}`);
    }
}
