import crypto from 'crypto';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

import { AgentDirectory, type Agent } from '../../services/herald/server/src/poppy/agents.ts';
import { verifyAssertion } from '../../services/herald/server/src/poppy/assertions.ts';
import { verifyDpopProof } from '../../services/herald/server/src/poppy/dpop.ts';
import { MemoryKV } from '../../services/herald/server/src/poppy/kv.ts';
import { AGENT_ID, ISSUER, TOKEN, TestAgent, fetcherFor, type Docs } from './poppy-helpers.ts';

// DPoP Proof and assertion validation, each case a real signed token with one
// thing wrong, checked against the reason it is refused.

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

function jti(): string {
    return crypto.randomBytes(16).toString('base64url');
}

describe('DPoP Proof validation', () => {
    let key: CryptoKey;
    let jwk: JWK;
    let kv: MemoryKV;

    beforeEach(async () => {
        const pair = await generateKeyPair('ES256', { extractable: true });
        key = pair.privateKey as CryptoKey;
        jwk = await exportJWK(pair.publicKey);
        kv = new MemoryKV();
    });

    async function proof(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, signer = key) {
        return new SignJWT({ jti: jti(), htm: 'POST', htu: TOKEN, iat: nowSeconds(), ...claims })
            .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk, ...header })
            .sign(signer);
    }

    function verify(header: string | string[] | undefined, extra: { method?: string; url?: string; accessToken?: string } = {}, now?: () => number) {
        return verifyDpopProof({ header, method: extra.method ?? 'POST', url: extra.url ?? TOKEN, accessToken: extra.accessToken }, kv, now);
    }

    it('returns the thumbprint of a valid proof key', async () => {
        await expect(verify(await proof())).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('rejects two DPoP headers joined into one', async () => {
        await expect(verify(`${await proof()}, ${await proof()}`)).rejects.toThrow('exactly one DPoP header is required');
    });

    it('rejects a header that is not a JWT', async () => {
        await expect(verify('not-a-jwt')).rejects.toThrow('DPoP proof is malformed');
    });

    it('rejects a proof whose typ is not dpop+jwt', async () => {
        await expect(verify(await proof({}, { typ: 'JWT' }))).rejects.toThrow('typ must be dpop+jwt');
    });

    it('rejects a proof signed with an algorithm outside the supported set', async () => {
        const pair = await generateKeyPair('ES384', { extractable: true });
        const es384 = await new SignJWT({ jti: jti(), htm: 'POST', htu: TOKEN, iat: nowSeconds() })
            .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES384', jwk: await exportJWK(pair.publicKey) })
            .sign(pair.privateKey);
        await expect(verify(es384)).rejects.toThrow('alg is not supported');
    });

    it('rejects a proof without a jwk, and one carrying a private key', async () => {
        await expect(verify(await proof({}, { jwk: undefined }))).rejects.toThrow('jwk must be a public key');
        const exported = await exportJWK(key);
        await expect(verify(await proof({}, { jwk: exported }))).rejects.toThrow('jwk must be a public key');
    });

    it('rejects a proof not signed by the key in its header', async () => {
        const other = await generateKeyPair('ES256', { extractable: true });
        await expect(verify(await proof({}, {}, other.privateKey as CryptoKey))).rejects.toThrow('DPoP proof rejected');
    });

    it('rejects a proof for another HTTP method', async () => {
        await expect(verify(await proof({ htm: 'GET' }))).rejects.toThrow('htm does not match');
    });

    it('rejects an htu that is not a URL', async () => {
        await expect(verify(await proof({ htu: 'token' }))).rejects.toThrow('htu is not a URL');
    });

    it('ignores the query and fragment of htu but not its path', async () => {
        await expect(verify(await proof({ htu: `${TOKEN}?x=1#y` }))).resolves.toBeTruthy();
        await expect(verify(await proof({ htu: `${TOKEN}x` }))).rejects.toThrow('htu does not match');
    });

    it('rejects a proof issued too far in the future or the past', async () => {
        const now = Date.now();
        const seconds = Math.floor(now / 1000);
        // Thirty seconds of skew ahead; sixty seconds of validity plus skew behind.
        await expect(verify(await proof({ iat: seconds + 31 }), {}, () => now)).rejects.toThrow('outside the acceptance window');
        await expect(verify(await proof({ iat: seconds - 91 }), {}, () => now)).rejects.toThrow('outside the acceptance window');
        await expect(verify(await proof({ iat: seconds - 89 }), {}, () => now)).resolves.toBeTruthy();
    });

    it('rejects a proof whose ath is for another token, or missing', async () => {
        const ath = crypto.createHash('sha256').update('pst_other').digest('base64url');
        await expect(verify(await proof({ ath }), { accessToken: 'pst_mine' })).rejects.toThrow('ath does not match');
        await expect(verify(await proof(), { accessToken: 'pst_mine' })).rejects.toThrow('ath does not match');
    });

    it('rejects an empty or non-string jti', async () => {
        await expect(verify(await proof({ jti: '' }))).rejects.toThrow('jti is missing');
        await expect(verify(await proof({ jti: 12345 }))).rejects.toThrow('jti is missing');
    });
});

describe('assertion validation', () => {
    let agent: TestAgent;
    let docs: Docs;
    let directory: AgentDirectory;
    let loaded: Agent;
    let kv: MemoryKV;
    let clock: number;

    beforeEach(async () => {
        agent = await new TestAgent().init();
        docs = agent.docs();
        clock = Date.now();
        directory = new AgentDirectory(fetcherFor(() => docs), () => clock);
        loaded = await directory.get(AGENT_ID);
        kv = new MemoryKV();
    });

    function verify(token: unknown, now: () => number = Date.now) {
        return verifyAssertion(token, loaded, directory, ISSUER, kv, now);
    }

    function claims(overrides: Record<string, unknown> = {}) {
        const iat = nowSeconds();
        return { iss: AGENT_ID, sub: AGENT_ID, aud: ISSUER, iat, exp: iat + 60, jti: jti(), ...overrides };
    }

    it('accepts a well-formed assertion once', async () => {
        const token = await agent.jwt(claims());
        await expect(verify(token)).resolves.toMatchObject({ payload: { iss: AGENT_ID } });
        await expect(verify(token)).rejects.toThrow('already been used');
    });

    it('rejects a missing assertion and one that is not a JWT', async () => {
        await expect(verify(undefined)).rejects.toThrow('assertion is missing');
        await expect(verify('not-a-jwt')).rejects.toThrow('assertion is malformed');
    });

    it('rejects an assertion header that names its own key', async () => {
        for (const header of [{ jwk: agent.publicJwk }, { jku: 'https://agent.example/jwks.json' }, { x5u: 'https://agent.example/cert.pem' }]) {
            await expect(verify(await agent.jwt(claims(), header))).rejects.toThrow('may not name its own key');
        }
    });

    it('rejects an assertion issued by someone other than the client', async () => {
        await expect(verify(await agent.jwt(claims({ iss: 'https://other.example/agent.json' })))).rejects.toThrow('iss must be the client_id');
    });

    it('rejects an assertion issued in the future by Herald’s clock', async () => {
        // Herald's clock runs two minutes behind the agent's.
        await expect(verify(await agent.jwt(claims()), () => Date.now() - 120_000)).rejects.toThrow('issued in the future');
    });

    it('rejects an assertion valid for more than five minutes', async () => {
        const iat = nowSeconds();
        await expect(verify(await agent.jwt(claims({ iat, exp: iat + 301 })))).rejects.toThrow('lifetime is too long');
    });

    it('rejects a jti too short to be random', async () => {
        await expect(verify(await agent.jwt(claims({ jti: 'short' })))).rejects.toThrow('at least 128 random bits');
    });

    describe('key rotation', () => {
        let rotatedToken: string;

        beforeEach(async () => {
            // The agent replaces its key with one under a new kid.
            const rotated = await new TestAgent().init();
            docs['https://agent.example/jwks.json'] = { keys: [{ ...rotated.publicJwk, kid: 'agent-key-rotated' }] };
            rotatedToken = await rotated.jwt(claims(), { kid: 'agent-key-rotated' });
        });

        it('refetches the key set for an unknown kid', async () => {
            clock += 31_000;
            await expect(verify(rotatedToken)).resolves.toBeTruthy();
        });

        it('refetches at most once every thirty seconds', async () => {
            clock += 29_000;
            await expect(verify(rotatedToken)).rejects.toThrow('assertion rejected');
        });
    });
});
