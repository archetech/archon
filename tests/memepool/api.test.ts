import { jest } from '@jest/globals';
import request from 'supertest';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { decodeGrantLink } from '@didcid/memeplex';
import { MemeplexClient } from '@didcid/memeplex/client';
import { createMemepoolApp } from '../../services/memepool/src/api.ts';

// The Memepool service: a Memeplex client whose key the service holds. Users
// sign in with a wallet, grant the service, and publish through it. The
// Gatekeeper and the Keymasters are the real ones; the test anchors what is
// queued, as a mediator does.

const REGISTRY = 'BTC:mainnet';
const blockTime = (block: number) => new Date(Date.UTC(2026, 10, 2, 0, block)).toISOString();

let gatekeeper: Gatekeeper;
let service: Keymaster;
let serviceDid: string;
let client: MemeplexClient;
let alice: Keymaster;
let aliceDid: string;
let bob: Keymaster;
let app: ReturnType<typeof createMemepoolApp>;
let block: number;
let clock: number;

async function anchor() {
    const operations = await gatekeeper.getQueue(REGISTRY);

    block += 100;
    await gatekeeper.addBlock(REGISTRY, { height: block, hash: `block-${block}`, time: Date.parse(blockTime(block)) / 1000 });
    await gatekeeper.importBatch(operations.map((operation, position) => ({
        registry: REGISTRY,
        time: blockTime(block),
        ordinal: [block, 0, position],
        registration: { height: block, index: 0, txid: `tx-${block}`, batch: `did:cid:batch-${block}`, opidx: position },
        operation,
    })) as never);
    await gatekeeper.processEvents();
    await gatekeeper.clearQueue(REGISTRY, operations);
}

async function keymasterFor(name: string) {
    const made = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher: new CipherNode(), passphrase: name });

    await made.loadOrCreateWallet();

    return { keymaster: made, did: await made.createId(name, { registry: 'hyperswarm' }) };
}

// A browser session: it keeps the cookie the service sets.
const browser = () => request.agent(app);

// Signs a wallet's identity in, as a wallet does with the challenge link.
async function signIn(wallet: Keymaster, agent = browser()) {
    const { challenge } = (await agent.get('/api/v1/challenge')).body;
    const response = await wallet.createResponse(challenge);
    const answer = await agent.post('/api/v1/login').send({ response });

    expect(answer.status).toBe(200);

    return agent;
}

// What a wallet does with the grant link the service shows.
async function grant(wallet: Keymaster, link: string) {
    const decoded = decodeGrantLink(link);

    if ('error' in decoded) {
        throw new Error(decoded.error);
    }

    const { client: named, nonce } = decoded.request;

    return wallet.createAsset({ memeplexGrant: { v: 1, client: named, nonce } }, { registry: REGISTRY });
}

async function granted(wallet: Keymaster) {
    const agent = await signIn(wallet);
    const grantDid = await grant(wallet, (await agent.get('/api/v1/me')).body.link);

    await anchor();

    return { agent, grantDid };
}

beforeEach(async () => {
    block = 0;
    clock = Date.UTC(2026, 10, 2);
    gatekeeper = new Gatekeeper({
        db: new DbJsonMemory('memepool'), ipfs: new MemoryClient(), registries: ['hyperswarm', REGISTRY],
        console: { log: () => undefined, error: () => undefined, time: () => undefined, timeEnd: () => undefined } as never,
    });
    ({ keymaster: service, did: serviceDid } = await keymasterFor('memepool'));
    ({ keymaster: alice, did: aliceDid } = await keymasterFor('alice'));
    ({ keymaster: bob } = await keymasterFor('bob'));
    client = new MemeplexClient({ keymaster: service, gatekeeper, identity: 'memepool' });
    app = createMemepoolApp({
        client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' },
        sessionLifetime: 60_000, challengeLifetime: 60_000, now: () => clock,
    });
});

describe('signing in', () => {
    it('says what it is without a session, and nothing else', async () => {
        expect((await request(app).get('/api/v1/ready')).body).toBe(true);
        expect((await request(app).get('/api/v1/config')).body).toStrictEqual({ name: 'Memepool', did: serviceDid });

        for (const [method, path] of [['get', '/api/v1/me'], ['post', '/api/v1/objects'], ['delete', '/api/v1/objects/did:cid:any']] as const) {
            expect((await request(app)[method](path)).status).toBe(401);
        }
    });

    it('signs in the identity that answers its challenge, and keeps it in a cookie scripts cannot read', async () => {
        const agent = browser();
        const { challenge, link } = (await agent.get('/api/v1/challenge')).body;

        expect(link).toBe(`archon://auth?challenge=${encodeURIComponent(challenge)}`);

        const answer = await agent.post('/api/v1/login').send({ response: await alice.createResponse(challenge) });

        expect(answer.body).toStrictEqual({ did: aliceDid });
        expect(answer.headers['set-cookie']).toContainEqual(expect.stringMatching(/^memepool_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/));
        expect((await agent.get('/api/v1/me')).body.did).toBe(aliceDid);
    });

    it('takes an answer once, and only to a challenge of its own', async () => {
        const agent = browser();
        const { challenge } = (await agent.get('/api/v1/challenge')).body;
        const response = await alice.createResponse(challenge);

        expect((await agent.post('/api/v1/login').send({ response })).status).toBe(200);
        expect((await agent.post('/api/v1/login').send({ response })).status).toBe(401);

        const elsewhere = await alice.createResponse(await service.createChallenge());
        expect((await agent.post('/api/v1/login').send({ response: elsewhere })).status).toBe(401);
        expect((await agent.post('/api/v1/login').send({})).status).toBe(400);
    });

    // A wallet publishes its answer as an asset, whose DID anyone can see.
    it('signs in only the browser that asked for the challenge', async () => {
        const asking = browser();
        const { challenge } = (await asking.get('/api/v1/challenge')).body;
        const response = await alice.createResponse(challenge);

        expect((await request(app).post('/api/v1/login').send({ response })).status).toBe(401);
        const another = browser();
        await another.get('/api/v1/challenge');
        expect((await another.post('/api/v1/login').send({ response })).status).toBe(401);

        expect((await asking.post('/api/v1/login').send({ response })).body).toStrictEqual({ did: aliceDid });
    });

    // An asset's owner can hand it to anyone, without their consent.
    it('does not sign in the identity a response was transferred to', async () => {
        const agent = browser();
        const { challenge } = (await agent.get('/api/v1/challenge')).body;
        const response = await bob.createResponse(challenge);

        expect(await bob.transferAsset(response, aliceDid)).toBe(true);
        expect((await service.verifyResponse(response)).match).toBe(false);

        expect((await agent.post('/api/v1/login').send({ response })).status).toBe(401);
        expect((await agent.get('/api/v1/me')).status).toBe(401);
    });

    // An identity that was once handed an asset can put its own answer in it
    // and hand it back.
    it('does not sign in the creator of an asset that came back holding another identity\'s answer', async () => {
        const agent = browser();
        const { challenge } = (await agent.get('/api/v1/challenge')).body;
        const asset = await alice.createResponse(await service.createChallenge());
        const bobDid = (await bob.resolveDID('bob')).didDocument!.id!;

        expect(await alice.transferAsset(asset, bobDid)).toBe(true);
        const answer = (await bob.resolveDID(await bob.createResponse(challenge))).didDocumentData;
        await bob.updateDID(asset, { ...await bob.resolveDID(asset), didDocumentData: answer });
        expect(await bob.transferAsset(asset, aliceDid)).toBe(true);

        expect((await agent.post('/api/v1/login').send({ response: asset })).status).toBe(401);
        expect((await agent.get('/api/v1/me')).status).toBe(401);
    });

    it('takes a DID as an answer, and not a name', async () => {
        const agent = browser();
        const { challenge } = (await agent.get('/api/v1/challenge')).body;

        await service.addAlias('answer', await alice.createResponse(challenge));
        expect((await agent.post('/api/v1/login').send({ response: 'answer' })).status).toBe(400);
    });

    it('does not take an answer to a challenge that has lapsed', async () => {
        const agent = browser();
        const { challenge } = (await agent.get('/api/v1/challenge')).body;
        const response = await alice.createResponse(challenge);

        clock += 60_000;
        expect((await agent.post('/api/v1/login').send({ response })).status).toBe(401);
    });

    it('asks the node nothing about an answer from a browser with no challenge of its own', async () => {
        const verify = jest.spyOn(service, 'verifyResponse');

        expect((await request(app).post('/api/v1/login').send({ response: 'did:cid:bagaaieranothing' })).status).toBe(401);
        expect((await request(app).post('/api/v1/login').set('Cookie', 'memepool_challenge=made-up').send({ response: 'did:cid:bagaaieranothing' })).status).toBe(401);
        expect(verify).not.toHaveBeenCalled();
    });

    it('refuses an answer that is not one, and a request it cannot read, without failing', async () => {
        const agent = browser();
        await agent.get('/api/v1/challenge');

        expect((await agent.post('/api/v1/login').send({ response: serviceDid })).status).toBe(401);
        expect((await agent.post('/api/v1/login').set('Content-Type', 'application/json').send('{"response":')).status).toBe(400);
        expect((await agent.post('/api/v1/login').send({ response: 'x'.repeat(300_000) })).status).toBe(413);
    });

    it('does not hand one challenge to two browsers', async () => {
        const first = browser();
        const { challenge } = (await first.get('/api/v1/challenge')).body;
        const made = jest.spyOn(service, 'createChallenge').mockResolvedValue(challenge);
        const second = browser();

        expect((await second.get('/api/v1/challenge')).status).toBe(503);
        made.mockRestore();

        const response = await alice.createResponse(challenge);
        expect((await second.post('/api/v1/login').send({ response })).status).toBe(401);
        expect((await first.post('/api/v1/login').send({ response })).body).toStrictEqual({ did: aliceDid });
    });

    it('issues no more challenges in a minute than it is set to', async () => {
        app = createMemepoolApp({
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, now: () => clock, challengesPerMinute: 2,
        });

        expect((await request(app).get('/api/v1/challenge')).status).toBe(200);
        expect((await request(app).get('/api/v1/challenge')).status).toBe(200);
        expect((await request(app).get('/api/v1/challenge')).status).toBe(429);
        clock += 60_000;
        expect((await request(app).get('/api/v1/challenge')).status).toBe(200);
    });

    it('ends a session at its lifetime, and at sign-out', async () => {
        const agent = await signIn(alice);

        clock += 59_999;
        expect((await agent.get('/api/v1/me')).status).toBe(200);
        clock += 1;
        expect((await agent.get('/api/v1/me')).status).toBe(401);

        const again = await signIn(alice);
        expect((await again.post('/api/v1/logout')).body).toBe(true);
        expect((await again.get('/api/v1/me')).status).toBe(401);
    });
});

describe('the user\'s grant', () => {
    it('asks for a grant to the service\'s DID, sees it pending, then publishes under it', async () => {
        const agent = await signIn(alice);
        const before = (await agent.get('/api/v1/me')).body;

        expect(before).toMatchObject({ did: aliceDid, pending: [] });
        expect(decodeGrantLink(before.link)).toMatchObject({ request: { client: serviceDid, name: 'Memepool' } });
        expect((await agent.post('/api/v1/objects').send({ kind: 'post', text: 'Too soon.' })).status).toBe(403);

        const grantDid = await grant(alice, before.link);
        expect((await agent.get('/api/v1/me')).body).toMatchObject({ did: aliceDid, pending: [grantDid] });
        expect((await agent.post('/api/v1/objects').send({ kind: 'post', text: 'Still too soon.' })).status).toBe(403);

        await anchor();
        expect((await agent.get('/api/v1/me')).body).toStrictEqual({ did: aliceDid, grant: grantDid, registry: REGISTRY });
    }, 120_000);

    it('does not publish for one user under another\'s grant', async () => {
        await granted(alice);
        const other = await signIn(bob);

        expect((await other.get('/api/v1/me')).body.grant).toBeUndefined();
        expect((await other.post('/api/v1/objects').send({ kind: 'post', text: 'As Alice?' })).status).toBe(403);
    }, 120_000);

    it('stops publishing once the user revokes the grant', async () => {
        const { agent, grantDid } = await granted(alice);

        expect(await alice.revokeDID(grantDid)).toBe(true);
        await anchor();

        expect((await agent.post('/api/v1/objects').send({ kind: 'post', text: 'After.' })).status).toBe(403);
        expect((await agent.get('/api/v1/me')).body.link).toMatch(/^archon:\/\/grant\?request=/);
    }, 120_000);
});

describe('a user with more than one grant', () => {
    it('publishes under the earliest, and changes each object under the grant it was published under', async () => {
        const { agent, grantDid: first } = await granted(alice);
        const { did: early } = (await agent.post('/api/v1/objects').send({ kind: 'post', text: 'Under the first.' })).body;
        await anchor();

        const second = await alice.createAsset({ memeplexGrant: { v: 1, client: serviceDid } }, { registry: REGISTRY });
        await anchor();
        expect((await agent.get('/api/v1/me')).body).toStrictEqual({ did: aliceDid, grant: first, registry: REGISTRY, others: [second] });

        expect(await alice.revokeDID(first)).toBe(true);
        await anchor();
        expect((await agent.get('/api/v1/me')).body).toStrictEqual({ did: aliceDid, grant: second, registry: REGISTRY });

        const { did: late } = (await agent.post('/api/v1/objects').send({ kind: 'post', text: 'Under the second.' })).body;
        await anchor();
        expect(await client.publication(late, second)).toMatchObject({ state: 'published' });

        // A deletion under another grant than the object's would not be attributed.
        expect((await agent.delete(`/api/v1/objects/${early}`)).status).toBe(400);
        expect((await agent.put(`/api/v1/objects/${early}`).send({ kind: 'post', text: 'Edited.' })).status).toBe(400);
        expect((await agent.delete(`/api/v1/objects/${late}`)).status).toBe(200);
    }, 120_000);
});

describe('publishing', () => {
    it('publishes, edits and withdraws what the signed-in user writes, as that user', async () => {
        const { agent, grantDid } = await granted(alice);
        const created = await agent.post('/api/v1/objects').send({ kind: 'post', text: 'Every post is a DID.', author: 'did:cid:someoneelse' });

        expect(created.status).toBe(200);
        const { did } = created.body;
        await anchor();
        expect(await client.publication(did, grantDid)).toMatchObject({ state: 'published', memeplex: { author: aliceDid, grant: grantDid, text: 'Every post is a DID.' } });

        expect((await agent.put(`/api/v1/objects/${did}`).send({ kind: 'post', text: 'Edited.' })).body).toBe(true);
        await anchor();
        expect(await client.publication(did, grantDid)).toMatchObject({ state: 'published', current: 1, memeplex: { text: 'Edited.' } });

        expect((await agent.delete(`/api/v1/objects/${did}`)).body).toBe(true);
        await anchor();
        expect((await client.publication(did, grantDid)).state).toBe('withdrawn');
    }, 120_000);

    it('refuses what is not a valid object, and an edit that would change what an object is', async () => {
        const { agent } = await granted(alice);
        const { did } = (await agent.post('/api/v1/objects').send({ kind: 'post', text: 'A post.' })).body;

        expect((await agent.post('/api/v1/objects').send({ kind: 'post' })).status).toBe(400);
        expect((await agent.post('/api/v1/objects').send([1])).status).toBe(400);
        expect((await agent.post('/api/v1/objects').send({ kind: 'essay', text: 'x' })).body).toStrictEqual({ error: 'not a valid essay: kind' });
        expect((await agent.put(`/api/v1/objects/${did}`).send({ kind: 'paper', title: 'x' })).status).toBe(400);
    }, 120_000);

    it('answers 502 when the node refuses an operation', async () => {
        const { agent } = await granted(alice);

        expect((await agent.post('/api/v1/objects').send({ kind: 'post', text: 'A post.', extra: 'x'.repeat(100_000) })).status).toBe(502);
    }, 120_000);

    it('lets a user change or withdraw only what is theirs', async () => {
        const { agent } = await granted(alice);
        const { agent: other } = await granted(bob);
        const { did } = (await agent.post('/api/v1/objects').send({ kind: 'post', text: 'Alice\'s.' })).body;
        await anchor();

        expect((await other.delete(`/api/v1/objects/${did}`)).status).toBe(400);
        expect((await other.put(`/api/v1/objects/${did}`).send({ kind: 'post', text: 'Bob\'s now.' })).status).toBe(400);
        expect((await other.delete('/api/v1/objects/did:cid:bagaaieranothing')).status).toBe(400);
        expect((await agent.delete(`/api/v1/objects/${did}`)).status).toBe(200);
    }, 120_000);
});
