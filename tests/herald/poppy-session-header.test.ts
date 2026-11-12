import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { AgentDirectory } from '../../services/herald/server/src/poppy/agents.ts';
import { MemoryKV } from '../../services/herald/server/src/poppy/kv.ts';
import {
    SessionHeaderError,
    verifySessionHeader,
    versionServed,
    type SessionCheck,
    type SessionVerifier,
} from '../../services/herald/server/src/poppy/session-header.ts';
import { AGENT_ID, API, ISSUER, TestAgent, fetcherFor, fetches, type Docs } from './poppy-helpers.ts';

// The Poppy-Session header (spec 0.4, 5.2 and 5.3) with real signatures: a
// delegation from a jwks_uri key, and a Session JWT from the delegated key.
// Each refusal is a way a request could otherwise claim an agent, User or
// Session that is not its own.

const URL = `${API}/account`;
const TOKEN = 'pat_access-token';

let agent: TestAgent;
let docs: Docs;
let verifier: SessionVerifier;

beforeEach(async () => {
    fetches.length = 0;
    agent = await new TestAgent().init();
    await agent.newSessionKey();
    docs = agent.docs();
    const directory = new AgentDirectory(fetcherFor(() => docs));
    verifier = {
        issuer: ISSUER,
        versions: ['0.4'],
        loadAgent: (clientId, refresh) => directory.get(clientId, refresh),
        kv: new MemoryKV(),
    };
});

function check(header: string, overrides: Partial<SessionCheck> = {}): SessionCheck {
    return { header, version: '0.4', method: 'GET', url: URL, ...overrides };
}

async function refusal(header: string, overrides: Partial<SessionCheck> = {}): Promise<SessionHeaderError> {
    try {
        await verifySessionHeader(check(header, overrides), verifier);
    }
    catch (error) {
        if (error instanceof SessionHeaderError) {
            return error;
        }
        throw error;
    }
    throw new Error('the header was accepted');
}

async function refused(header: string, description: string | RegExp, overrides: Partial<SessionCheck> = {}): Promise<void> {
    const error = await refusal(header, overrides);
    expect(error.code).toBe('invalid_session');
    expect(error.message).toMatch(typeof description === 'string' ? new RegExp(description) : description);
}

describe('a valid header', () => {
    it('names the agent, the Session and the User', async () => {
        await expect(verifySessionHeader(check(await agent.session('GET', URL)), verifier)).resolves.toEqual({
            clientId: AGENT_ID,
            sessionId: 'Yx2b7Qd_Kp8mR3vT1nWc4A',
            userId: 'usr_Q7c1vK',
        });
    });

    it('carries the optional Agent ID', async () => {
        const header = await agent.session('GET', URL, { agent_id: 'agt_travel' });
        await expect(verifySessionHeader(check(header), verifier)).resolves.toMatchObject({ agentId: 'agt_travel' });
    });

    it('is accepted with the access token it covers, issued to the same client', async () => {
        const header = await agent.session('GET', URL, {}, {}, TOKEN);
        const accessToken = { token: TOKEN, clientId: AGENT_ID };
        await expect(verifySessionHeader(check(header, { accessToken }), verifier)).resolves.toMatchObject({ clientId: AGENT_ID });
    });

    it('ignores the query and fragment of the request URL, as a DPoP Proof does', async () => {
        const header = await agent.session('GET', URL);
        await expect(verifySessionHeader(check(header, { url: `${URL}?page=2` }), verifier)).resolves.toBeDefined();
    });

    it('accepts a delegation signed with a key the agent has rotated in, refetching its keys', async () => {
        // The directory refetches a key set at most once per interval.
        let clock = Date.now();
        const directory = new AgentDirectory(fetcherFor(() => docs), () => clock);
        verifier.loadAgent = (clientId, refresh) => directory.get(clientId, refresh);
        await verifySessionHeader(check(await agent.session('GET', URL)), verifier);
        clock += 10 * 60 * 1000;
        const rotated = await new TestAgent().init();
        await rotated.newSessionKey();
        (rotated as { kid: string }).kid = 'agent-key-rotated';
        rotated.publicJwk = { ...rotated.publicJwk, kid: 'agent-key-rotated' };
        docs['https://agent.example/jwks.json'] = { keys: [rotated.publicJwk] };

        await expect(verifySessionHeader(check(await rotated.session('GET', URL)), verifier)).resolves.toBeDefined();
    });
});

describe('Poppy-Version', () => {
    it.each([undefined, '', '0.3', '0.5', '1.0', '0.4.1', 'latest', ['0.4', '0.4']])('refuses %p with version_unsupported', async (version) => {
        const error = await refusal(await agent.session('GET', URL), { version: version as never });
        expect(error.code).toBe('version_unsupported');
    });

    it('matches the minor version before 1.0 and only the major version from 1.0', () => {
        expect(versionServed('0.4', ['0.4'])).toBe(true);
        expect(versionServed('0.3', ['0.4', '0.3'])).toBe(true);
        expect(versionServed('0.5', ['0.4'])).toBe(false);
        expect(versionServed('1.2', ['1.0'])).toBe(true);
        expect(versionServed('2.0', ['1.0'])).toBe(false);
        expect(versionServed('0.4', ['1.0'])).toBe(false);
    });

    it('is checked before the Session JWT, so a wrong version is not reported as a bad Session', async () => {
        const error = await refusal('garbage', { version: '0.3' });
        expect(error.code).toBe('version_unsupported');
    });
});

describe('the header itself', () => {
    it.each([undefined, '', ['a', 'b']])('refuses %p', async (header) => {
        await refused(header as never, 'exactly one Poppy-Session header');
    });

    it('refuses two headers joined by the server', async () => {
        const header = await agent.session('GET', URL);
        await refused(`${header}, ${header}`, 'exactly one Poppy-Session header');
    });

    it('refuses what is not a JWT', async () => {
        await refused('garbage', 'malformed');
    });

    it('refuses another typ, so no other JWT of the agent can stand in', async () => {
        await refused(await agent.session('GET', URL, {}, { typ: 'dpop+jwt' }), 'typ must be poppy-session\\+jwt');
        await refused(await agent.session('GET', URL, {}, { typ: undefined }), 'typ must be poppy-session\\+jwt');
    });

    it('refuses a header that names its own key', async () => {
        await refused(await agent.session('GET', URL, {}, { jwk: agent.sessionJwk }), 'may not name its own key');
    });
});

describe('the delegation', () => {
    it('refuses a Session JWT without one, including one signed directly with a jwks_uri key', async () => {
        await refused(await agent.session('GET', URL, {}, { poppy_dlg: undefined }), 'carries no delegation');

        const direct = await agent.jwt(
            { iss: AGENT_ID, aud: ISSUER, sid: 'abc', sub: 'usr', htm: 'GET', htu: URL, iat: Math.floor(Date.now() / 1000), jti: 'j'.repeat(16) },
            { typ: 'poppy-session+jwt' },
        );
        await refused(direct, 'carries no delegation');
    });

    it('refuses one signed by a key that is not in jwks_uri', async () => {
        const stranger = await new TestAgent().init();
        stranger.sessionKey = agent.sessionKey;
        stranger.sessionJwk = agent.sessionJwk;
        const delegation = await stranger.delegation();
        await refused(await agent.session('GET', URL, {}, { poppy_dlg: delegation }), 'delegation rejected');
    });

    it('refuses another typ, so a client assertion cannot vouch for a key', async () => {
        const delegation = await agent.delegation({}, { typ: 'JWT' });
        await refused(await agent.session('GET', URL, {}, { poppy_dlg: delegation }), 'delegation typ');
    });

    it('refuses one without a kid', async () => {
        const delegation = await agent.delegation({}, { kid: undefined });
        await refused(await agent.session('GET', URL, {}, { poppy_dlg: delegation }), 'kid must name a key');
    });

    it('refuses one issued by another client', async () => {
        const delegation = await agent.delegation({ iss: 'https://other.example/agent.json' });
        await refused(await agent.session('GET', URL, {}, { poppy_dlg: delegation }), 'delegation rejected');
    });

    it('refuses an expired one', async () => {
        const now = Math.floor(Date.now() / 1000);
        const delegation = await agent.delegation({ iat: now - 7200, exp: now - 3600 });
        await refused(await agent.session('GET', URL, {}, { poppy_dlg: delegation }), 'delegation rejected');
    });

    it('refuses one that lasts longer than 24 hours', async () => {
        const now = Math.floor(Date.now() / 1000);
        const delegation = await agent.delegation({ iat: now, exp: now + 24 * 3600 + 1 });
        await refused(await agent.session('GET', URL, {}, { poppy_dlg: delegation }), 'longer than 24 hours');

        const atLimit = await agent.delegation({ iat: now, exp: now + 24 * 3600 });
        await expect(verifySessionHeader(check(await agent.session('GET', URL, {}, { poppy_dlg: atLimit })), verifier)).resolves.toBeDefined();
    });

    it('refuses one issued in the future', async () => {
        const now = Math.floor(Date.now() / 1000);
        const delegation = await agent.delegation({ iat: now + 600, exp: now + 3600 });
        await refused(await agent.session('GET', URL, {}, { poppy_dlg: delegation }), 'issued in the future');
    });

    it('refuses one without a public key, or with a private one', async () => {
        const none = await agent.delegation({ cnf: {} });
        await refused(await agent.session('GET', URL, {}, { poppy_dlg: none }), 'cnf.jwk must be a public key');

        const leaked = await agent.delegation({ cnf: { jwk: { ...agent.sessionJwk, d: 'secret' } } });
        await refused(await agent.session('GET', URL, {}, { poppy_dlg: leaked }), 'cnf.jwk must be a public key');
    });

    it('refuses a client whose metadata cannot be loaded', async () => {
        delete docs[AGENT_ID];
        await refused(await agent.session('GET', URL), 'client_id refused');
    });

    it('passes on what loading the agent throws that is not a refusal, such as a rate limit', async () => {
        const limit = new Error('too many new client_id values');
        verifier.loadAgent = async () => { throw limit; };
        await expect(verifySessionHeader(check(await agent.session('GET', URL)), verifier)).rejects.toBe(limit);
    });
});

describe('the Session JWT', () => {
    it('refuses one signed with a key the delegation does not name', async () => {
        const delegation = await agent.delegation();
        await agent.newSessionKey();
        await refused(await agent.session('GET', URL, {}, { poppy_dlg: delegation }), 'Session JWT rejected');
    });

    it('refuses a kid that is not the delegated key\'s thumbprint', async () => {
        await refused(await agent.session('GET', URL, {}, { kid: 'agent-key-1' }), 'thumbprint');
    });

    it('refuses another alg', async () => {
        const { privateKey, publicKey } = await generateKeyPair('PS384', { extractable: true });
        agent.sessionKey = privateKey as CryptoKey;
        agent.sessionJwk = await exportJWK(publicKey);
        const delegation = await agent.delegation();
        const header = await new SignJWT({ iss: AGENT_ID })
            .setProtectedHeader({ typ: 'poppy-session+jwt', alg: 'PS384', poppy_dlg: delegation } as never)
            .sign(agent.sessionKey);
        await refused(header, 'alg must be ES256');
    });

    it.each(['aud', 'sid', 'sub', 'htm', 'htu', 'iat', 'jti'])('refuses one without %s', async (claim) => {
        await refused(await agent.session('GET', URL, { [claim]: undefined }), 'Session JWT rejected');
    });

    it('refuses one without iss', async () => {
        await refused(await agent.session('GET', URL, { iss: undefined }), 'iss must be the client_id');
    });

    it('refuses an iss other than the delegation\'s', async () => {
        await refused(await agent.session('GET', URL, { iss: 'https://other.example/agent.json' }), 'client_id refused|delegation rejected');
    });

    it('refuses another audience, an audience list, and the token endpoint', async () => {
        await refused(await agent.session('GET', URL, { aud: 'https://other.example' }), 'aud must be');
        await refused(await agent.session('GET', URL, { aud: [ISSUER] }), 'aud must be');
        await refused(await agent.session('GET', URL, { aud: `${ISSUER}/token` }), 'aud must be');
    });

    it.each(['', 'has space', 'a'.repeat(257), 42])('refuses the sid %p', async (sid) => {
        await refused(await agent.session('GET', URL, { sid }), 'sid is not a Session ID|Session JWT rejected');
    });

    it.each(['', 'u'.repeat(256), 42])('refuses the sub %p', async (sub) => {
        await refused(await agent.session('GET', URL, { sub }), 'sub must be the User ID|Session JWT rejected');
    });

    it.each(['', 42, 'a'.repeat(256)])('refuses the agent_id %p', async (agentId) => {
        await refused(await agent.session('GET', URL, { agent_id: agentId }), 'agent_id must be an Agent ID');
    });

    it('refuses another method or URL, so a copied header works nowhere else', async () => {
        await refused(await agent.session('POST', URL), 'htm does not match');
        await refused(await agent.session('GET', `${API}/account/name`), 'htu does not match');
        await refused(await agent.session('GET', URL, { htu: 'not a url' }), 'htu is not a URL');
    });

    it('refuses one signed outside the acceptance window', async () => {
        const now = Math.floor(Date.now() / 1000);
        await refused(await agent.session('GET', URL, { iat: now - 120 }), 'acceptance window');
        await refused(await agent.session('GET', URL, { iat: now + 120 }), 'acceptance window');
    });

    it('refuses a short jti', async () => {
        await refused(await agent.session('GET', URL, { jti: 'short' }), 'jti must carry');
    });

    it('refuses a second use', async () => {
        const header = await agent.session('GET', URL);
        await verifySessionHeader(check(header), verifier);
        await refused(header, 'already been used');
    });
});

describe('the access token', () => {
    const accessToken = { token: TOKEN, clientId: AGENT_ID };

    it('refuses a header that does not cover the token sent', async () => {
        await refused(await agent.session('GET', URL), 'ath does not match', { accessToken });
        await refused(await agent.session('GET', URL, {}, {}, 'pat_another'), 'ath does not match', { accessToken });
    });

    it('refuses a token issued to another client, though the header covers it', async () => {
        const header = await agent.session('GET', URL, {}, {}, TOKEN);
        await refused(header, 'issued to another client', {
            accessToken: { token: TOKEN, clientId: 'https://other.example/agent.json' },
        });
    });

    it('refuses ath on a signed-out request', async () => {
        await refused(await agent.session('GET', URL, {}, {}, TOKEN), 'ath is present without an access token');
    });
});
