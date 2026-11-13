import { MemoryKV } from '../../services/herald/server/src/poppy/kv.ts';
import { RateLimiter } from '../../services/herald/server/src/poppy/rate-limit.ts';
import { PoppyStore, type Grant } from '../../services/herald/server/src/poppy/store.ts';
import { AGENT_ID, ALICE } from './poppy-helpers.ts';

// Poppy's durable state and its request limits, on an injected clock.

let clock: number;
let kv: MemoryKV;
let store: PoppyStore;

beforeEach(() => {
    clock = 1_000_000;
    kv = new MemoryKV(() => clock);
    store = new PoppyStore(kv, () => clock);
});

function grant(id: string, lifetimeMs: number): Grant {
    return {
        id,
        tokenHash: `hash-${id}`,
        clientId: AGENT_ID,
        clientName: 'Example Agent',
        domain: 'agent.example',
        did: ALICE,
        scope: ['profile:read'],
        createdAt: clock,
        expiresAt: clock + lifetimeMs,
        lastUsedAt: clock,
    };
}

describe('PoppyStore', () => {
    it('treats a missing or non-string identifier as unknown', async () => {
        expect(await store.getSignIn('')).toBeNull();
        expect(await store.takeAuthCode(undefined)).toBeNull();
        expect(await store.getGrantByToken(undefined)).toBeNull();
    });

    it('names a Session by its agent, Session ID and User ID together', () => {
        const key = store.sessionKey(AGENT_ID, 'sid-1', 'usr_1');
        expect(store.sessionKey(AGENT_ID, 'sid-1', 'usr_1')).toBe(key);
        expect(store.sessionKey('https://other.example/agent.json', 'sid-1', 'usr_1')).not.toBe(key);
        expect(store.sessionKey(AGENT_ID, 'sid-2', 'usr_1')).not.toBe(key);
        expect(store.sessionKey(AGENT_ID, 'sid-1', 'usr_2')).not.toBe(key);
        // The parts cannot be shifted between one another to collide.
        expect(store.sessionKey(AGENT_ID, 'sid-1"', ',"usr_1')).not.toBe(store.sessionKey(AGENT_ID, 'sid-1', 'usr_1'));
    });

    it('binds a Session to the first account it uses, for as long as the Session lasts', async () => {
        const key = store.sessionKey(AGENT_ID, 'sid-1', 'usr_1');
        expect(await store.bindSessionAccount(key, ALICE, 60)).toBe(true);
        expect(await store.bindSessionAccount(key, ALICE, 60)).toBe(true);
        expect(await store.bindSessionAccount(key, 'did:cid:bob', 60)).toBe(false);

        clock += 61_000;
        expect(await store.bindSessionAccount(key, 'did:cid:bob', 60)).toBe(true);
    });

    it('keeps an access token until it expires', async () => {
        const record = { clientId: AGENT_ID, did: ALICE, scope: ['profile:read'], grantId: 'grt_a', jkt: 'thumb', expiresAt: clock + 60_000 };
        await store.putAccessToken('pat_token', record);
        expect(await store.getAccessToken('pat_token')).toEqual(record);
        expect(await store.getAccessToken('pat_other')).toBeNull();

        clock += 61_000;
        expect(await store.getAccessToken('pat_token')).toBeNull();
    });

    it('reads a grant stored under the draft 0.2 scope names as the scopes that replace them', async () => {
        await store.putGrant({ ...grant('grt_old', 60_000), scope: ['poppy:read', 'poppy:write'] });
        expect((await store.getGrant('grt_old'))!.scope).toEqual(['profile:read', 'name:write']);
    });

    it('drops expired grants from an account’s index as it lists them', async () => {
        await store.putGrant(grant('grt_short', 60_000));
        await store.putGrant(grant('grt_long', 600_000));
        expect((await store.listGrantsForDid(ALICE)).map(g => g.id).sort()).toEqual(['grt_long', 'grt_short']);

        clock += 61_000;
        expect((await store.listGrantsForDid(ALICE)).map(g => g.id)).toEqual(['grt_long']);
        expect(await kv.members(`grants-by-did:${ALICE}`)).toEqual(['grt_long']);
    });
});

describe('RateLimiter', () => {
    it('allows the limit per window and then names the seconds to wait', () => {
        const limiter = new RateLimiter(2, 60_000, () => clock);
        expect(limiter.take('a')).toBe(0);
        expect(limiter.take('a')).toBe(0);
        clock += 15_000;
        expect(limiter.take('a')).toBe(45);
        // Other keys have their own allowance.
        expect(limiter.take('b')).toBe(0);
        clock += 45_000;
        expect(limiter.take('a')).toBe(0);
    });

    it('peeks at a key without counting against it', () => {
        const limiter = new RateLimiter(2, 60_000, () => clock);
        expect(limiter.peek('a')).toBe(0);
        limiter.take('a');
        expect(limiter.peek('a')).toBe(0);
        expect(limiter.peek('a')).toBe(0);
        limiter.take('a');
        clock += 30_000;
        expect(limiter.peek('a')).toBe(30);
        clock += 30_000;
        expect(limiter.peek('a')).toBe(0);
    });

    it('forgets finished windows once it tracks more than 10,000 keys', () => {
        const limiter = new RateLimiter(1, 60_000, () => clock);
        for (let i = 0; i < 10_001; i++) {
            limiter.take(`key-${i}`);
        }
        clock += 60_000;
        limiter.take('late');
        // The private map is the memory an attacker rotating keys would grow.
        expect((limiter as unknown as { windows: Map<string, unknown> }).windows.size).toBe(1);
    });
});
