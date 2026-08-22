import { jest } from '@jest/globals';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import HeliaClient from '@didcid/ipfs/helia';
import { packEncrypted } from '@didcid/cipher/didcomm';
import { MailboxFullError, MemoryMailboxStore, RedisMailboxStore } from '../../services/didcomm/server/src/store.ts';
import { recipientDidsFromEnvelope, verifyChallengeSignature } from '../../services/didcomm/server/src/mailbox.ts';
import { createApp, socksEgress } from '../../services/didcomm/server/src/didcomm-api.ts';
import type { Cipher } from '@didcid/cipher/types';
import express from 'express';
import request from 'supertest';

const enc = new TextEncoder();

describe('MemoryMailboxStore', () => {
    it('adds, lists, and removes messages per recipient', async () => {
        const store = new MemoryMailboxStore();
        await store.add('did:cid:bob', 'env-1', 'id-1');
        await store.add('did:cid:bob', 'env-2', 'id-2');
        await store.add('did:cid:carol', 'env-3', 'id-3');

        expect((await store.list('did:cid:bob')).map(m => m.id)).toEqual(['id-1', 'id-2']);
        expect(await store.list('did:cid:carol')).toHaveLength(1);

        expect(await store.remove('did:cid:bob', ['id-1'])).toBe(1);
        expect((await store.list('did:cid:bob')).map(m => m.id)).toEqual(['id-2']);
    });

    it('removes the recipient inbox after the last message is deleted', async () => {
        const store = new MemoryMailboxStore();
        await store.add('did:cid:bob', 'env-1', 'id-1');

        expect(await store.remove('did:cid:bob', ['id-1'])).toBe(1);
        expect(await store.list('did:cid:bob')).toStrictEqual([]);
        expect(await store.remove('did:cid:bob', ['missing'])).toBe(0);
    });

    it('prunes messages past the TTL', async () => {
        let now = 1_000_000;
        const store = new MemoryMailboxStore(1000, 1000, () => now);
        await store.add('did:cid:bob', 'env', 'id-1');
        now += 1500; // past the 1000ms TTL
        expect(await store.list('did:cid:bob')).toHaveLength(0);
    });

    it('consumes a challenge once and rejects replays / expiry / unknowns', async () => {
        let now = 1_000_000;
        const store = new MemoryMailboxStore(1000, 1000, () => now);
        await store.issueChallenge('c1');
        expect(await store.consumeChallenge('c1')).toBe(true);
        expect(await store.consumeChallenge('c1')).toBe(false); // single-use
        expect(await store.consumeChallenge('unknown')).toBe(false);

        await store.issueChallenge('c2');
        now += 1500; // expired
        expect(await store.consumeChallenge('c2')).toBe(false);
    });

    // The original defect: prune() ran only from list(), so a mailbox nobody
    // polled kept its envelopes forever, and an unconsumed challenge was never
    // collected at all. Both are checked here WITHOUT calling list().
    it('sheds expired messages and challenges without being read', async () => {
        let now = 1_000_000;
        const store = new MemoryMailboxStore(1000, 1000, () => now);

        await store.add('did:test:never-polled', 'envelope', 'm1');
        await store.issueChallenge('c1');

        now += 1500; // past both TTLs
        store.sweep();

        // Reading would prune on its own, so inspect the internals instead --
        // otherwise the assertion cannot distinguish a sweep from a lazy prune.
        expect((store as any).messages.size).toBe(0);
        expect((store as any).challenges.size).toBe(0);
    });

    it('sweeps on the unauthenticated write paths, without a timer', async () => {
        let now = 1_000_000;
        const store = new MemoryMailboxStore(1000, 1000, () => now);

        await store.add('did:test:never-polled', 'envelope', 'm1');
        await store.issueChallenge('stale');
        now += 1500;

        // A single later write is enough: the time-based trigger fires because
        // more than SWEEP_EVERY_MS of injected time has passed.
        now += 60 * 1000;
        await store.issueChallenge('fresh');

        expect((store as any).messages.size).toBe(0);
        expect((store as any).challenges.has('stale')).toBe(false);
        expect((store as any).challenges.has('fresh')).toBe(true);
    });

    it('rejects a deposit that would exceed the per-recipient cap', async () => {
        const store = new MemoryMailboxStore(1000, 1000, () => 1_000_000, { maxRecipientBytes: 20 });

        await store.add('did:test:bob', 'x'.repeat(15), 'm1');
        await expect(store.add('did:test:bob', 'x'.repeat(10), 'm2')).rejects.toThrow(MailboxFullError);

        // The rejected message is not stored, and the mailbox still works.
        expect(await store.list('did:test:bob')).toHaveLength(1);
        await expect(store.add('did:test:bob', 'x', 'm3')).resolves.toBeDefined();
    });

    // The depositor picks the recipient DID (routing is by JWE recipient kids),
    // so a per-recipient cap alone is no bound at all -- an attacker just uses a
    // fresh DID each time. This is the cap that actually stops that.
    it('rejects a deposit that would exceed the total cap, across distinct recipients', async () => {
        const store = new MemoryMailboxStore(1000, 1000, () => 1_000_000, { maxTotalBytes: 30 });

        await store.add('did:test:one', 'x'.repeat(15), 'm1');
        await store.add('did:test:two', 'x'.repeat(10), 'm2');
        await expect(store.add('did:test:three', 'x'.repeat(10), 'm3')).rejects.toThrow(MailboxFullError);
    });

    // TTL sweeping bounds how long a challenge lives, not how many can be live
    // at once -- and GET /challenge is unauthenticated, so without a ceiling an
    // anonymous caller can hold arbitrarily many valid entries.
    it('refuses to issue past the challenge ceiling', async () => {
        const store = new MemoryMailboxStore(1000, 1000, () => 1_000_000, { maxChallenges: 2 });

        await store.issueChallenge('c1');
        await store.issueChallenge('c2');
        await expect(store.issueChallenge('c3')).rejects.toThrow(MailboxFullError);
    });

    it('frees challenge capacity as entries expire or are consumed', async () => {
        let now = 1_000_000;
        const store = new MemoryMailboxStore(1000, 1000, () => now, { maxChallenges: 2 });

        await store.issueChallenge('c1');
        await store.issueChallenge('c2');
        await expect(store.issueChallenge('c3')).rejects.toThrow(MailboxFullError);

        // Consuming one frees a slot...
        await store.consumeChallenge('c1');
        await expect(store.issueChallenge('c3')).resolves.toBeUndefined();

        // ...and so does expiry, with nothing reading the map.
        now += 1500;
        await expect(store.issueChallenge('c4')).resolves.toBeUndefined();
    });

    it('frees capacity when messages are removed or expire', async () => {
        let now = 1_000_000;
        const store = new MemoryMailboxStore(1000, 1000, () => now, { maxTotalBytes: 20 });

        await store.add('did:test:bob', 'x'.repeat(20), 'm1');
        await expect(store.add('did:test:bob', 'x', 'm2')).rejects.toThrow(MailboxFullError);

        await store.remove('did:test:bob', ['m1']);
        await expect(store.add('did:test:bob', 'x'.repeat(20), 'm3')).resolves.toBeDefined();

        // Expiry frees capacity too, without anyone reading the mailbox.
        now += 1500;
        await expect(store.add('did:test:bob', 'x'.repeat(20), 'm4')).resolves.toBeDefined();
    });
});

describe('deposit route capacity', () => {
    // Packing a real envelope needs the whole keymaster stack, but the route
    // only needs recipientDidsFromEnvelope to succeed -- so a store that
    // reports full on any add isolates the status-mapping behaviour.
    function appWithStore(store: any) {
        const app = express();
        app.use('/didcomm', createApp({ store, resolver: {} as any, cipher: {} as any }));
        return app;
    }

    it('answers 429 when a mailbox is full, not 400', async () => {
        const store = new MemoryMailboxStore(1000, 1000, () => 1_000_000, { maxTotalBytes: 1 });
        const packed = JSON.stringify({
            protected: Buffer.from(JSON.stringify({ enc: 'A256GCM' })).toString('base64url'),
            recipients: [{ header: { kid: 'did:test:bob#key-agreement' } }],
            iv: 'x', ciphertext: 'y', tag: 'z',
        });

        const response = await request(appWithStore(store))
            .post('/didcomm/api/v1/messages')
            .set('Content-Type', 'application/json')
            .send({ message: packed });

        // A full mailbox is a capacity condition; 400 would blame the sender.
        expect(response.status).toBe(429);
        expect(response.body.error).toMatch(/full/);
    });

    it('answers 429 when the challenge ceiling is reached', async () => {
        const store = new MemoryMailboxStore(1000, 1000, () => 1_000_000, { maxChallenges: 1 });
        const app = appWithStore(store);

        expect((await request(app).get('/didcomm/api/v1/challenge')).status).toBe(200);

        const second = await request(app).get('/didcomm/api/v1/challenge');
        expect(second.status).toBe(429);
        expect(second.body.error).toMatch(/challenges/);
    });

    // Egress checks sit behind challenge auth, so these need a relay that accepts
    // the signature -- otherwise every request 401s before reaching them.
    function appWithEgress(options: { allowInsecureEgress?: boolean; torProxy?: string } = {}) {
        const store = new MemoryMailboxStore(1000, 1000, () => 1_000_000);
        const resolver = {
            resolveDID: async () => ({
                didDocument: { verificationMethod: [{ publicKeyJwk: { kty: 'EC' } }] },
            }),
        };
        const cipher = { hashMessage: () => 'hash', verifySig: () => true };
        const app = express();
        app.use('/didcomm', createApp({ store, resolver: resolver as any, cipher: cipher as any, ...options }));
        return { app, store };
    }

    async function deliver(app: any, endpoint: string) {
        const { body } = await request(app).get('/didcomm/api/v1/challenge');
        return request(app)
            .post('/didcomm/api/v1/deliver')
            .send({ did: 'did:test:alice', challenge: body.challenge, signature: 's', endpoint, message: 'x' });
    }

    // The scheme check is the half of the old egress guard that held: a DNS name
    // cannot forge it, and it keeps plaintext internal services (the usual SSRF
    // target being http://redis:6379 with inline commands in the body) out of
    // reach. The address half was removed in #645 -- it matched hostnames with a
    // literal regex, so 127.0.0.1.nip.io passed while honest LAN delivery did not.
    it('refuses clearnet delivery over plain http', async () => {
        const { app } = appWithEgress();
        const response = await deliver(app, 'http://redis:6379');

        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/https/);
    });

    it('does not filter clearnet delivery by address', async () => {
        // A private https destination gets past the guard and is actually
        // attempted -- what an address filter would have refused outright.
        // fetch is mocked: a real connection to a LAN address would hang or, on
        // the wrong subnet, reach someone.
        const attempted: string[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (input: any) => {
            attempted.push(String(input));
            return new Response(JSON.stringify({ ids: ['x'] }), { status: 200 });
        }) as any;

        try {
            const { app } = appWithEgress();
            const response = await deliver(app, 'https://192.168.0.255');

            expect(response.status).toBe(200);
            expect(attempted).toEqual(['https://192.168.0.255/api/v1/messages']);
        }
        finally {
            globalThis.fetch = realFetch;
        }
    });

    it('does not follow a redirect off the https endpoint', async () => {
        // The scheme check is worthless if a redirect can undo it: 307/308
        // preserve method and body, so an https endpoint answering
        // `307 -> http://redis:6379` would deliver the caller's bytes there.
        const realFetch = globalThis.fetch;
        let passedRedirect: string | undefined;
        globalThis.fetch = (async (_input: any, init: any) => {
            passedRedirect = init?.redirect;
            return new Response(null, { status: 307, headers: { location: 'http://redis:6379/' } });
        }) as any;

        try {
            const { app } = appWithEgress();
            const response = await deliver(app, 'https://relay.example');

            expect(passedRedirect).toBe('manual');
            expect(response.status).toBe(502);
            expect(response.body.error).toMatch(/redirect/);
        }
        finally {
            globalThis.fetch = realFetch;
        }
    });

    // #916: a SOCKS dispatcher built on fetch-socks's undici is rejected by
    // Node's built-in fetch ("invalid onRequestStart method"), which surfaced as
    // an unreachable-looking `TypeError: fetch failed` and broke every onion
    // delivery. The onion path must therefore go through undici's fetch.
    it('sends onion deliveries through undici, never the global fetch', async () => {
        const socksFetchMock = jest.fn<any>().mockResolvedValue(
            new Response(JSON.stringify({ ids: ['onion-1'] }), { status: 200 }),
        );
        const realSocksFetch = socksEgress.fetch;
        socksEgress.fetch = socksFetchMock;

        // A trap, not a stub: the global fetch reaching this request is exactly
        // what the regression looks like.
        const realFetch = globalThis.fetch;
        const globalTrap = jest.fn<any>();
        globalThis.fetch = globalTrap as any;

        try {
            const { app } = appWithEgress({ torProxy: '127.0.0.1:1' });
            const response = await deliver(app, 'http://abcdefghijklmnop.onion:4222/didcomm');

            expect(response.status).toBe(200);
            expect(globalTrap).not.toHaveBeenCalled();
            expect(socksFetchMock).toHaveBeenCalledTimes(1);
            expect((socksFetchMock.mock.calls[0][1] as any).dispatcher).toBeDefined();
        }
        finally {
            socksEgress.fetch = realSocksFetch;
            globalThis.fetch = realFetch;
        }
    });

    it('allows plain http only when the host app opts in', async () => {
        // allowInsecureEgress exists for in-process tests and has no environment
        // binding, so a deployed relay cannot reach this branch.
        const attempted: string[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (input: any) => {
            attempted.push(String(input));
            return new Response(JSON.stringify({ ids: ['x'] }), { status: 200 });
        }) as any;

        try {
            const { app } = appWithEgress({ allowInsecureEgress: true });
            const response = await deliver(app, 'http://127.0.0.1:4236');

            expect(response.status).toBe(200);
            expect(attempted).toEqual(['http://127.0.0.1:4236/api/v1/messages']);
        }
        finally {
            globalThis.fetch = realFetch;
        }
    });

    // A 429 says the envelope was not stored. If an earlier recipient's copy
    // were left behind, a retry would deliver to them twice.
    it('rolls back earlier recipients when a later one is full', async () => {
        const store = new MemoryMailboxStore(1000, 1000, () => 1_000_000, { maxRecipientBytes: 400 });
        const packed = JSON.stringify({
            protected: Buffer.from(JSON.stringify({ enc: 'A256GCM' })).toString('base64url'),
            recipients: [
                { header: { kid: 'did:test:first#key-agreement' } },
                { header: { kid: 'did:test:second#key-agreement' } },
            ],
            iv: 'x', ciphertext: 'y', tag: 'z',
        });

        // Fill the second recipient's mailbox so the deposit fails part-way.
        await store.add('did:test:second', 'x'.repeat(399), 'filler');

        const response = await request(appWithStore(store))
            .post('/didcomm/api/v1/messages')
            .set('Content-Type', 'application/json')
            .send({ message: packed });

        expect(response.status).toBe(429);
        expect(await store.list('did:test:first')).toHaveLength(0);
        expect(await store.list('did:test:second')).toHaveLength(1); // only the filler
    });

    it('still answers 400 for a malformed envelope', async () => {
        const store = new MemoryMailboxStore(1000, 1000, () => 1_000_000, { maxTotalBytes: 1 });

        const response = await request(appWithStore(store))
            .post('/didcomm/api/v1/messages')
            .set('Content-Type', 'application/json')
            .send({ message: 'not an envelope' });

        expect(response.status).toBe(400);
    });
});

// Live-redis integration tests are opt-IN: they run only when ARCHON_REDIS_URL is
// set (pointing at a reachable redis). By default — and in the unit-test CI, which
// has no redis service — they are skipped. Running them against a dead redis would
// leave ioredis reconnecting forever, leaking a handle that hangs the jest process.
const describeRedis = process.env.ARCHON_REDIS_URL ? describe : describe.skip;

describeRedis('RedisMailboxStore (live redis)', () => {
    let store: RedisMailboxStore;

    beforeAll(async () => {
        store = new RedisMailboxStore(process.env.ARCHON_REDIS_URL!, `didcomm-test-${Date.now()}`);
        await store.connect();
    });

    afterAll(async () => {
        if (store) {
            await store.disconnect();
        }
    });

    it('adds, lists, and removes messages per recipient', async () => {
        await store.add('did:cid:bob', 'env-1', 'id-1');
        await store.add('did:cid:bob', 'env-2', 'id-2');
        await store.add('did:cid:carol', 'env-3', 'id-3');

        expect((await store.list('did:cid:bob')).map(m => m.id).sort()).toEqual(['id-1', 'id-2']);
        expect(await store.list('did:cid:carol')).toHaveLength(1);

        expect(await store.remove('did:cid:bob', ['id-1'])).toBe(1);
        expect((await store.list('did:cid:bob')).map(m => m.id)).toEqual(['id-2']);
    });

    it('consumes a challenge once (single-use) and rejects unknowns', async () => {
        await store.issueChallenge('rc1');
        expect(await store.consumeChallenge('rc1')).toBe(true);
        expect(await store.consumeChallenge('rc1')).toBe(false);
        expect(await store.consumeChallenge('never-issued')).toBe(false);
    });
});

describe('RedisMailboxStore connection guards', () => {
    it('throws a clear error when used before connecting', async () => {
        const store = new RedisMailboxStore('redis://localhost:6379');

        await expect(store.add('did:cid:bob', 'env', 'id-1')).rejects.toThrow('Redis is not connected');
        await expect(store.list('did:cid:bob')).rejects.toThrow('Redis is not connected');
        await expect(store.issueChallenge('challenge')).rejects.toThrow('Redis is not connected');
        await expect(store.consumeChallenge('challenge')).rejects.toThrow('Redis is not connected');
    });

    it('does not require a Redis connection to remove an empty id list', async () => {
        const store = new RedisMailboxStore('redis://localhost:6379');

        await expect(store.remove('did:cid:bob', [])).resolves.toBe(0);
    });
});

describe('RedisMailboxStore command mapping', () => {
    class FakeRedis {
        values = new Map<string, string>();
        sets = new Map<string, Set<string>>();
        calls: any[][] = [];

        multi() {
            const ops: (() => void)[] = [];
            const chain = {
                set: (key: string, value: string, mode: string, ttl: number) => {
                    this.calls.push(['set', key, value, mode, ttl]);
                    ops.push(() => this.values.set(key, value));
                    return chain;
                },
                sadd: (key: string, id: string) => {
                    this.calls.push(['sadd', key, id]);
                    ops.push(() => {
                        const set = this.sets.get(key) || new Set<string>();
                        set.add(id);
                        this.sets.set(key, set);
                    });
                    return chain;
                },
                expire: (key: string, ttl: number) => {
                    this.calls.push(['expire', key, ttl]);
                    return chain;
                },
                exec: async () => {
                    ops.forEach(op => op());
                    return [];
                },
            };
            return chain;
        }

        async smembers(key: string) {
            return [...(this.sets.get(key) || [])];
        }

        async mget(keys: string[]) {
            return keys.map(key => this.values.get(key) ?? null);
        }

        async srem(key: string, ...ids: string[]) {
            this.calls.push(['srem', key, ...ids]);
            const set = this.sets.get(key);
            ids.forEach(id => set?.delete(id));
            return ids.length;
        }

        async del(...keys: string[]) {
            this.calls.push(['del', ...keys]);
            let removed = 0;
            keys.forEach(key => {
                if (this.values.delete(key)) {
                    removed += 1;
                }
            });
            return removed;
        }

        async set(key: string, value: string, mode: string, ttl: number) {
            this.calls.push(['set', key, value, mode, ttl]);
            this.values.set(key, value);
        }

        async getdel(key: string) {
            const value = this.values.get(key) ?? null;
            this.values.delete(key);
            return value;
        }

        async quit() {
            this.calls.push(['quit']);
        }
    }

    function redisStore(prefix = 'unit', caps = {}) {
        const store = new RedisMailboxStore('redis://unused', prefix, 2000, 3000, caps);
        const redis = new FakeRedis();
        (store as any).redis = redis;
        return { store, redis };
    }

    it('enforces the per-recipient cap', async () => {
        const { store } = redisStore('unit', { maxRecipientBytes: 20 });

        await store.add('did:cid:bob', 'x'.repeat(15), 'id-1');
        await expect(store.add('did:cid:bob', 'x'.repeat(10), 'id-2')).rejects.toThrow(MailboxFullError);
    });

    it('drops ids whose bodies have expired while measuring, so the inbox set cannot grow forever', async () => {
        const { store, redis } = redisStore('unit', { maxRecipientBytes: 100 });

        await store.add('did:cid:bob', 'small', 'id-1');
        // Body expires via redis TTL; the id stays in the set until something
        // prunes it. add() refreshes the set's own TTL every time, so without
        // this pruning a mailbox under sustained delivery accumulates dead ids.
        redis.values.delete('unit:msg:did:cid:bob:id-1');

        await store.add('did:cid:bob', 'next', 'id-2');

        expect([...(redis.sets.get('unit:inbox:did:cid:bob') || [])]).toEqual(['id-2']);
        expect(redis.calls).toContainEqual(['srem', 'unit:inbox:did:cid:bob', 'id-1']);
    });

    it('stores messages with TTLs, prunes expired ids while listing, and removes by id', async () => {
        const { store, redis } = redisStore();

        const message = await store.add('did:cid:bob', 'env-1', 'id-1');
        expect(message).toMatchObject({ id: 'id-1', recipient: 'did:cid:bob', envelope: 'env-1' });
        expect(redis.calls).toContainEqual(['set', 'unit:msg:did:cid:bob:id-1', expect.any(String), 'EX', 2]);
        expect(redis.calls).toContainEqual(['sadd', 'unit:inbox:did:cid:bob', 'id-1']);
        expect(redis.calls).toContainEqual(['expire', 'unit:inbox:did:cid:bob', 2]);

        redis.sets.get('unit:inbox:did:cid:bob')!.add('expired');
        const listed = await store.list('did:cid:bob');
        expect(listed).toHaveLength(1);
        expect(listed[0].id).toBe('id-1');
        expect(redis.calls).toContainEqual(['srem', 'unit:inbox:did:cid:bob', 'expired']);

        expect(await store.remove('did:cid:bob', ['id-1', 'missing'])).toBe(1);
        expect(redis.calls).toContainEqual([
            'del',
            'unit:msg:did:cid:bob:id-1',
            'unit:msg:did:cid:bob:missing',
        ]);
        expect(redis.calls).toContainEqual(['srem', 'unit:inbox:did:cid:bob', 'id-1', 'missing']);
    });

    it('returns an empty inbox without mget, consumes challenges once, and disconnects cleanly', async () => {
        const { store, redis } = redisStore('challenge');

        expect(await store.list('did:cid:empty')).toEqual([]);

        await store.issueChallenge('c1');
        expect(redis.calls).toContainEqual(['set', 'challenge:challenge:c1', '1', 'PX', 3000]);
        expect(await store.consumeChallenge('c1')).toBe(true);
        expect(await store.consumeChallenge('c1')).toBe(false);

        await store.disconnect();
        expect(redis.calls).toContainEqual(['quit']);
        await expect(store.list('did:cid:empty')).rejects.toThrow('Redis is not connected');
    });
});

describe('recipientDidsFromEnvelope', () => {
    it('extracts the recipient DIDs from the JWE recipient kids', () => {
        const cipher = new CipherNode();
        const bob = cipher.generateX25519Jwk(new Uint8Array(32).fill(9));
        const packed = packEncrypted(enc.encode('hi'), [{ kid: 'did:cid:bob#key-agreement-1', publicJwk: bob.publicJwk }], null, 'XC20P');
        expect(recipientDidsFromEnvelope(packed)).toEqual(['did:cid:bob']);
    });

    it('throws on a non-encrypted payload', () => {
        expect(() => recipientDidsFromEnvelope('{"not":"a jwe"}')).toThrow();
    });
});

describe('verifyChallengeSignature', () => {
    let ipfs: HeliaClient;
    let gatekeeper: Gatekeeper;
    let cipher: CipherNode;
    let keymaster: Keymaster;

    beforeAll(async () => {
        ipfs = new HeliaClient();
        await ipfs.start();
    });

    afterAll(async () => {
        if (ipfs) {
            await ipfs.stop();
        }
    });

    beforeEach(() => {
        const db = new DbJsonMemory('test');
        gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm'] });
        cipher = new CipherNode();
        keymaster = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher, passphrase: 'pass' });
    });

    async function sign(name: string, challenge: string): Promise<string> {
        const keypair = await keymaster.fetchKeyPair(name);
        return cipher.signHash(cipher.hashMessage(challenge), keypair!.privateJwk);
    }

    it('accepts a valid signature over the challenge by the DID controller', async () => {
        const did = await keymaster.createId('Alice');
        const challenge = 'challenge-abc';
        const signature = await sign('Alice', challenge);

        const ok = await verifyChallengeSignature({ resolver: gatekeeper, cipher }, { did, challenge, signature });
        expect(ok).toBe(true);
    });

    it('rejects a signature over a different challenge', async () => {
        const did = await keymaster.createId('Alice');
        const signature = await sign('Alice', 'challenge-abc');

        const ok = await verifyChallengeSignature({ resolver: gatekeeper, cipher }, { did, challenge: 'different', signature });
        expect(ok).toBe(false);
    });

    it("rejects another identity's signature for the DID", async () => {
        const aliceDid = await keymaster.createId('Alice');
        await keymaster.createId('Mallory');
        const challenge = 'challenge-abc';
        const mallorySig = await sign('Mallory', challenge);

        const ok = await verifyChallengeSignature({ resolver: gatekeeper, cipher }, { did: aliceDid, challenge, signature: mallorySig });
        expect(ok).toBe(false);
    });

    it('rejects unresolved DIDs, non-signing keys, and verifier errors', async () => {
        await expect(verifyChallengeSignature(
            { resolver: { resolveDID: async () => { throw new Error('not found'); } }, cipher },
            { did: 'did:cid:missing', challenge: 'challenge', signature: 'sig' }
        )).resolves.toBe(false);

        await expect(verifyChallengeSignature(
            {
                resolver: {
                    resolveDID: async () => ({
                        didDocument: {
                            id: 'did:cid:x25519',
                            verificationMethod: [{ id: '#key-1', type: 'JsonWebKey2020', publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'x' } }],
                        },
                    }),
                },
                cipher,
            },
            { did: 'did:cid:x25519', challenge: 'challenge', signature: 'sig' }
        )).resolves.toBe(false);

        await expect(verifyChallengeSignature(
            {
                resolver: gatekeeper,
                // Spreading a class instance copies no prototype methods, so
                // this is not a whole Cipher -- but verifyChallengeSignature
                // reaches only for verifySig, which is the one made to throw.
                cipher: { ...cipher, verifySig: () => { throw new Error('bad signature'); } } as unknown as Cipher,
            },
            { did: await keymaster.createId('VerifierError'), challenge: 'challenge', signature: 'sig' }
        )).resolves.toBe(false);
    });
});
