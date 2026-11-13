import crypto from 'crypto';
import { currentScopes } from './config.js';
import type { PoppyKV } from './kv.js';

// Durable Poppy state. Secrets (access tokens, refresh tokens, authorization
// and device codes) are stored only as SHA-256 hashes.
//
// Herald may run several requests for the same Session, sign-in or device
// code at once, so every one-way transition is decided by one atomic store
// operation: binding a Session to an account, authenticating or deciding a
// sign-in, deciding and consuming a device authorization, and touching a grant
// that a revocation may have just deleted. Records that such transitions
// depend on are written once and never rewritten.

export interface AccessToken {
    clientId: string;
    did: string;
    scope: string[];
    grantId: string;
    // Thumbprint of the DPoP key the token is bound to.
    jkt: string;
    expiresAt: number;
}

// A refresh token and what it grants.
export interface Grant {
    id: string;
    tokenHash: string;
    clientId: string;
    clientName: string;
    domain: string;
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
    expiresAt: number;
}

export interface SignInAccount {
    did: string;
    name?: string;
}

export interface DeviceAuthorization {
    clientId: string;
    scope: string[];
    userCode: string;
    interval: number;
    expiresAt: number;
}

export interface DevicePolling {
    interval: number;
    lastPollAt: number;
}

export type DeviceDecision =
    | { approved: true; did: string; scope: string[] }
    | { approved: false };

export function randomSecret(prefix: string, bytes = 32): string {
    return `${prefix}${crypto.randomBytes(bytes).toString('base64url')}`;
}

export function hashSecret(secret: string): string {
    return crypto.createHash('sha256').update(secret, 'utf8').digest('base64url');
}

// Device records outlive expires_in so a late poll gets expired_token.
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

    private ttl(expiresAt: number): number {
        return ttlUntil(expiresAt, this.now());
    }

    // ---------- Sessions ----------

    // A Session is named by the agent, the Session ID and the User ID in a
    // verified Session header (spec 5.3). Herald keeps nothing for one beyond
    // the account it has used.
    sessionKey(clientId: string, sessionId: string, userId: string): string {
        return hashSecret(JSON.stringify([clientId, sessionId, userId]));
    }

    // A Session uses at most one account (5.4). The first DID to bind wins;
    // returns whether `did` is that account.
    async bindSessionAccount(sessionKey: string, did: string, lifetimeSeconds: number): Promise<boolean> {
        const key = `session-account:${sessionKey}`;
        if (await this.kv.setIfAbsent(key, did, lifetimeSeconds)) {
            return true;
        }
        return (await this.kv.get(key)) === did;
    }

    // ---------- Access tokens ----------

    async putAccessToken(token: string, record: AccessToken): Promise<void> {
        await this.putJson(`atoken:${hashSecret(token)}`, record, record.expiresAt);
    }

    async getAccessToken(token: string): Promise<AccessToken | null> {
        const record = await this.getJson<AccessToken>(`atoken:${hashSecret(token)}`);
        return record && record.expiresAt > this.now() ? record : null;
    }

    // ---------- Refresh token grants ----------

    async putGrant(grant: Grant): Promise<void> {
        const ttl = this.ttl(grant.expiresAt);
        await this.putJson(`grant:${grant.id}`, grant, grant.expiresAt);
        await this.kv.set(`grant-token:${grant.tokenHash}`, grant.id, ttl);
        await this.kv.addToSet(`grants-by-did:${grant.did}`, grant.id, ttl);
    }

    async getGrant(id: string): Promise<Grant | null> {
        const grant = await this.getJson<Grant>(`grant:${id}`);
        return grant && grant.expiresAt > this.now() ? { ...grant, scope: currentScopes(grant.scope) } : null;
    }

    async getGrantByToken(token: unknown): Promise<Grant | null> {
        if (typeof token !== 'string' || !token) {
            return null;
        }
        const id = await this.kv.get(`grant-token:${hashSecret(token)}`);
        return id ? this.getGrant(id) : null;
    }

    // Records use of a grant. Returns false, and writes nothing, when the
    // grant was revoked after the caller read it.
    async touchGrant(grant: Grant): Promise<boolean> {
        return this.kv.setIfPresent(`grant:${grant.id}`, JSON.stringify({ ...grant, lastUsedAt: this.now() }), this.ttl(grant.expiresAt));
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

    // Revokes a grant. Access tokens issued under it stop working at once,
    // since each is checked against its grant (spec 5.5).
    async revokeGrant(grant: Grant): Promise<void> {
        await this.kv.del(`grant:${grant.id}`);
        await this.kv.del(`grant-token:${grant.tokenHash}`);
        await this.kv.removeFromSet(`grants-by-did:${grant.did}`, grant.id);
    }

    // ---------- Authorization codes, single use ----------

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

    // ---------- Sign-in requests, for Direct and Device Sign-In ----------

    async putSignIn(signIn: SignIn): Promise<void> {
        await this.putJson(`signin:${signIn.id}`, signIn, signIn.expiresAt);
        if (signIn.challenge) {
            await this.kv.set(`challenge:${signIn.challenge}`, signIn.id, this.ttl(signIn.expiresAt));
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

    // The first wallet response for a sign-in decides its account.
    async authenticateSignIn(signIn: SignIn, account: SignInAccount): Promise<boolean> {
        return this.kv.setIfAbsent(`signin-account:${signIn.id}`, JSON.stringify(account), this.ttl(signIn.expiresAt));
    }

    async getSignInAccount(signIn: SignIn): Promise<SignInAccount | null> {
        return this.getJson<SignInAccount>(`signin-account:${signIn.id}`);
    }

    // Only one decision is acted on, however many times the page submits.
    async claimSignInDecision(signIn: SignIn): Promise<boolean> {
        return this.kv.setIfAbsent(`signin-decided:${signIn.id}`, '1', this.ttl(signIn.expiresAt));
    }

    async isSignInDecided(signIn: SignIn): Promise<boolean> {
        return (await this.kv.get(`signin-decided:${signIn.id}`)) !== null;
    }

    // ---------- Device authorizations ----------

    async putDevice(deviceCode: string, record: DeviceAuthorization): Promise<void> {
        const hash = hashSecret(deviceCode);
        const ttl = this.ttl(record.expiresAt + DEVICE_GRACE_MS);
        await this.kv.set(`device:${hash}`, JSON.stringify(record), ttl);
        await this.kv.set(`usercode:${record.userCode}`, hash, this.ttl(record.expiresAt));
    }

    async getDevice(hash: string): Promise<DeviceAuthorization | null> {
        return this.getJson<DeviceAuthorization>(`device:${hash}`);
    }

    async getDeviceHashByUserCode(userCode: string): Promise<string | null> {
        return this.kv.get(`usercode:${userCode}`);
    }

    // Polling state lives apart from the decision, so a poll cannot undo one.
    async getDevicePolling(hash: string): Promise<DevicePolling | null> {
        return this.getJson<DevicePolling>(`device-poll:${hash}`);
    }

    async putDevicePolling(hash: string, device: DeviceAuthorization, polling: DevicePolling): Promise<void> {
        await this.kv.set(`device-poll:${hash}`, JSON.stringify(polling), this.ttl(device.expiresAt + DEVICE_GRACE_MS));
    }

    // The User's decision is recorded once.
    async decideDevice(hash: string, device: DeviceAuthorization, decision: DeviceDecision): Promise<boolean> {
        return this.kv.setIfAbsent(`device-decision:${hash}`, JSON.stringify(decision), this.ttl(device.expiresAt + DEVICE_GRACE_MS));
    }

    async getDeviceDecision(hash: string): Promise<DeviceDecision | null> {
        return this.getJson<DeviceDecision>(`device-decision:${hash}`);
    }

    // The decision stays until the device code expires, so it keeps guarding
    // against a second decision; a separate marker lets exactly one poll act on it.
    async consumeDeviceDecision(hash: string, device: DeviceAuthorization): Promise<boolean> {
        return this.kv.setIfAbsent(`device-consumed:${hash}`, '1', this.ttl(device.expiresAt + DEVICE_GRACE_MS));
    }

    async deleteDevice(hash: string, device: DeviceAuthorization): Promise<void> {
        await this.kv.del(`device:${hash}`);
        await this.kv.del(`usercode:${device.userCode}`);
        await this.kv.del(`device-poll:${hash}`);
    }
}
