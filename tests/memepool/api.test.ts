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

        const fresh = browser();
        await fresh.get('/api/v1/challenge');
        expect((await fresh.post('/api/v1/login').send({ response: 7 })).status).toBe(400);
        expect((await fresh.post('/api/v1/login').send({ response: 'answer' })).status).toBe(400);
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

describe('signing in with a wallet that sends its answer to the callback', () => {
    beforeEach(() => {
        app = createMemepoolApp({
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' },
            sessionLifetime: 60_000, challengeLifetime: 60_000, now: () => clock, publicURL: 'https://node.example/memepool/',
        });
    });

    it('names its callback in the challenge', async () => {
        const { challenge } = (await request(app).get('/api/v1/challenge')).body;
        const data = (await service.resolveDID(challenge)).didDocumentData as { challenge: { callback?: string } };

        expect(data.challenge.callback).toBe('https://node.example/memepool/api/v1/callback');
    });

    it('tells the browser that asked who answered, and signs it in when the user confirms', async () => {
        const agent = browser();
        const { challenge } = (await agent.get('/api/v1/challenge')).body;

        const waiting = await agent.post('/api/v1/login').send();
        expect(waiting.status).toBe(202);
        expect(waiting.body).toStrictEqual({ waiting: true });

        // The wallet, which is not the browser and has none of its cookies.
        const sent = await request(app).post('/api/v1/callback').send({ response: await alice.createResponse(challenge) });
        expect(sent.body).toBe(true);
        expect(sent.headers['set-cookie']).toBeUndefined();

        const told = await agent.post('/api/v1/login').send();
        expect(told.body).toStrictEqual({ answered: aliceDid });
        expect(told.headers['set-cookie']).toBeUndefined();
        expect((await agent.get('/api/v1/me')).status).toBe(401);

        expect((await agent.post('/api/v1/login').send({ confirm: 'did:cid:someoneelse' })).body).toStrictEqual({ answered: aliceDid });
        expect((await agent.post('/api/v1/login').send({ confirm: aliceDid })).body).toStrictEqual({ did: aliceDid });
        expect((await agent.get('/api/v1/me')).body.did).toBe(aliceDid);
        // Once.
        expect((await agent.post('/api/v1/login').send({ confirm: aliceDid })).status).toBe(401);
    });

    it('signs in no other browser with that answer', async () => {
        const asking = browser();
        const { challenge } = (await asking.get('/api/v1/challenge')).body;
        const another = browser();
        await another.get('/api/v1/challenge');

        await request(app).post('/api/v1/callback').send({ response: await alice.createResponse(challenge) });

        expect((await request(app).post('/api/v1/login').send({ confirm: aliceDid })).status).toBe(401);
        expect((await another.post('/api/v1/login').send({ confirm: aliceDid })).status).toBe(202);
        expect((await asking.post('/api/v1/login').send({ confirm: aliceDid })).body).toStrictEqual({ did: aliceDid });
    });

    // A challenge is an asset anyone on the network can see and answer.
    it('signs nobody in when someone else has answered the challenge too', async () => {
        const agent = browser();
        const { challenge } = (await agent.get('/api/v1/challenge')).body;

        await request(app).post('/api/v1/callback').send({ response: await bob.createResponse(challenge) });
        await request(app).post('/api/v1/callback').send({ response: await alice.createResponse(challenge) });

        const answer = await agent.post('/api/v1/login').send({ confirm: aliceDid });
        expect(answer.status).toBe(409);
        expect((await agent.get('/api/v1/me')).status).toBe(401);
        expect((await agent.post('/api/v1/login').send({ confirm: aliceDid })).status).toBe(401);
    });

    it('does not sign the user in as someone else who answered first, unless the user says that is them', async () => {
        const agent = browser();
        const { challenge } = (await agent.get('/api/v1/challenge')).body;
        const bobDid = (await bob.resolveDID('bob')).didDocument!.id!;

        await request(app).post('/api/v1/callback').send({ response: await bob.createResponse(challenge) });

        expect((await agent.post('/api/v1/login').send()).body).toStrictEqual({ answered: bobDid });
        expect((await agent.post('/api/v1/login').send({ confirm: aliceDid })).body).toStrictEqual({ answered: bobDid });
        expect((await agent.get('/api/v1/me')).status).toBe(401);
    });

    it('answers a wallet in a browser from another origin, at the callback and nowhere else', async () => {
        const preflight = await request(app).options('/api/v1/callback').set('Origin', 'https://wallet.example').set('Access-Control-Request-Method', 'POST');

        expect(preflight.status).toBe(204);
        expect(preflight.headers['access-control-allow-origin']).toBe('*');
        expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();

        const { challenge } = (await request(app).get('/api/v1/challenge')).body;
        const sent = await request(app).post('/api/v1/callback').set('Origin', 'https://wallet.example').send({ response: await alice.createResponse(challenge) });

        expect(sent.headers['access-control-allow-origin']).toBe('*');
        expect((await request(app).get('/api/v1/config').set('Origin', 'https://wallet.example')).headers['access-control-allow-origin']).toBeUndefined();
        expect((await request(app).options('/api/v1/login').set('Origin', 'https://wallet.example')).headers['access-control-allow-origin']).toBeUndefined();
    });

    it('signs in once when two requests carry the same answer together', async () => {
        const agent = browser();
        const { challenge } = (await agent.get('/api/v1/challenge')).body;
        const response = await alice.createResponse(challenge);
        const both = await Promise.all([agent.post('/api/v1/login').send({ response }), agent.post('/api/v1/login').send({ response })]);

        expect(both.map(each => each.status).sort()).toStrictEqual([200, 401]);
    });

    it('takes at the callback only an answer to a challenge of its own that is as its author made it', async () => {
        const agent = browser();
        const { challenge } = (await agent.get('/api/v1/challenge')).body;
        const callback = (response: unknown) => request(app).post('/api/v1/callback').send({ response });

        expect((await callback(undefined)).status).toBe(400);
        expect((await callback('answer')).status).toBe(400);
        expect((await callback(serviceDid)).status).toBe(401);
        expect((await callback(await alice.createResponse(await service.createChallenge()))).status).toBe(401);

        const transferred = await bob.createResponse(challenge);
        await bob.transferAsset(transferred, aliceDid);
        expect((await callback(transferred)).status).toBe(401);

        expect((await agent.post('/api/v1/login').send()).status).toBe(202);
    });

    it('verifies no more than eight answers at once, and frees a place when one is done or fails', async () => {
        const { challenge } = (await browser().get('/api/v1/challenge')).body;
        const response = await alice.createResponse(challenge);
        const held: { answer: (value: never) => void; fail: (error: Error) => void }[] = [];
        const verify = jest.spyOn(service, 'verifyResponse').mockImplementation(
            () => new Promise((answer, fail) => { held.push({ answer, fail }); }) as never,
        );
        const callback = () => request(app).post('/api/v1/callback').send({ response });

        const eight = Array.from({ length: 8 }, () => callback().then(sent => sent.status));
        await new Promise(wait => setTimeout(wait, 100));
        expect(verify).toHaveBeenCalledTimes(8);

        expect((await callback()).status).toBe(429);
        expect(verify).toHaveBeenCalledTimes(8);

        // One is refused by the verifier, and one fails outright.
        held[0].answer({ match: false, challenge } as never);
        held[1].fail(new Error('node unreachable'));
        await new Promise(wait => setTimeout(wait, 100));

        const two = [callback().then(sent => sent.status), callback().then(sent => sent.status)];
        await new Promise(wait => setTimeout(wait, 100));
        expect(verify).toHaveBeenCalledTimes(10);
        expect((await callback()).status).toBe(429);

        for (const each of held.slice(2)) {
            each.answer({ match: false, challenge } as never);
        }
        expect((await Promise.all([...eight, ...two])).sort()).toStrictEqual([401, 401, 401, 401, 401, 401, 401, 401, 401, 500]);

        verify.mockRestore();
        expect((await callback()).status).toBe(200);
    });

    it('does not keep an answer past the challenge\'s lifetime', async () => {
        const agent = browser();
        const { challenge } = (await agent.get('/api/v1/challenge')).body;

        await request(app).post('/api/v1/callback').send({ response: await alice.createResponse(challenge) });
        clock += 60_000;
        expect((await agent.post('/api/v1/login').send({ confirm: aliceDid })).status).toBe(401);
    });

    it('still takes an answer carried back by hand', async () => {
        const agent = browser();
        const { challenge } = (await agent.get('/api/v1/challenge')).body;

        expect((await agent.post('/api/v1/login').send({ response: await alice.createResponse(challenge) })).body).toStrictEqual({ did: aliceDid });
    });
});

describe('the pages', () => {
    it('serves none, and no route under the API as a page, when it has no pages', async () => {
        expect((await request(app).get('/')).status).toBe(404);
        // Under the API's own prefix, a route nobody has is not told from one that needs a session.
        expect((await request(app).get('/api/v1/no-such-route')).status).toBe(401);
        expect((await request(app).get('/api/v2/ready')).body).toStrictEqual({ error: 'no such route' });
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

describe('a grant that allows some kinds', () => {
    async function narrowed(actions: string[]) {
        const agent = await signIn(alice);
        const { request: asked } = decodeGrantLink((await agent.get('/api/v1/me')).body.link) as { request: { client: string; nonce: string } };
        const grantDid = await alice.createAsset({ memeplexGrant: { v: 1, client: asked.client, nonce: asked.nonce, actions } }, { registry: REGISTRY });

        await anchor();

        return { agent, grantDid };
    }

    it('says what the grant allows, publishes that, and refuses the rest before anything is created', async () => {
        const { agent, grantDid } = await narrowed(['memeplex:post', 'memeplex:tag']);

        expect((await agent.get('/api/v1/me')).body).toStrictEqual({
            did: aliceDid, grant: grantDid, registry: REGISTRY, actions: ['memeplex:post', 'memeplex:tag'],
        });

        const posted = await agent.post('/api/v1/objects').send({ kind: 'post', text: 'Allowed.' });
        expect(posted.status).toBe(200);
        await anchor();
        const targetVersion = (await client.publication(posted.body.did, grantDid)).versions[0].opid;

        const queued = (await gatekeeper.getQueue(REGISTRY)).length;
        const refused = await agent.post('/api/v1/objects').send({ kind: 'rating', target: posted.body.did, targetVersion, rating: 1, min: 0, max: 1 });

        expect(refused.status).toBe(403);
        expect(refused.body).toStrictEqual({ error: 'your grant does not allow a rating' });
        expect(await gatekeeper.getQueue(REGISTRY)).toHaveLength(queued);
        // A kind the rules do not know, or that is no string, is not a matter of scope.
        expect((await agent.post('/api/v1/objects').send({ kind: 'essay', text: 'x' })).status).toBe(400);
        expect((await agent.post('/api/v1/objects').send({ kind: ['rating'], target: posted.body.did, targetVersion, rating: 1, min: 0, max: 1 })).status).toBe(400);
    }, 120_000);

    it('publishes under whichever of the reader\'s grants allows the kind, and lists what they allow between them', async () => {
        const { agent, grantDid: posts } = await narrowed(['memeplex:post']);
        const ratings = await alice.createAsset({ memeplexGrant: { v: 1, client: serviceDid, actions: ['memeplex:rate'] } }, { registry: REGISTRY });
        await anchor();

        expect((await agent.get('/api/v1/me')).body).toMatchObject({ grant: posts, others: [ratings], actions: ['memeplex:post', 'memeplex:rate'] });

        const posted = await agent.post('/api/v1/objects').send({ kind: 'post', text: 'A post.' });
        await anchor();
        const targetVersion = (await client.publication(posted.body.did, posts)).versions[0].opid;
        const rated = await agent.post('/api/v1/objects').send({ kind: 'rating', target: posted.body.did, targetVersion, rating: 1, min: 0, max: 1 });
        await anchor();

        expect(await client.publication(rated.body.did, ratings)).toMatchObject({ state: 'published', memeplex: { grant: ratings } });
        expect((await agent.post('/api/v1/objects').send({ kind: 'tag', target: posted.body.did, targetVersion, tag: 'x' })).status).toBe(403);
    }, 120_000);

    it('lists no actions when one of the reader\'s grants allows every kind', async () => {
        const { agent } = await narrowed(['memeplex:post']);
        await alice.createAsset({ memeplexGrant: { v: 1, client: serviceDid } }, { registry: REGISTRY });
        await anchor();

        expect((await agent.get('/api/v1/me')).body.actions).toBeUndefined();
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
