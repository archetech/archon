import { jest } from '@jest/globals';
import request from 'supertest';
import sharp from 'sharp';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { parseGrantLink, readGrantRequest } from '@didcid/memeplex';
import { MemeplexClient } from '@didcid/memeplex/client';
import { AVATAR_LIMIT, BODY_LIMIT, FILE_LIMIT, IMAGE_LIMIT, createMemepoolApp } from '../../services/memepool/src/api.ts';

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

// What a wallet reads from the grant link the service shows: the request it
// names, as the wallet's node resolves it.
async function asked(link: string, wallet: Keymaster = alice) {
    const read = readGrantRequest(await wallet.resolveDID(parseGrantLink(link)!) as never);

    if ('error' in read) {
        throw new Error(read.error);
    }

    return read;
}

// What a wallet does with it.
async function grant(wallet: Keymaster, link: string, more: Record<string, unknown> = {}) {
    const { did, client: named } = await asked(link, wallet);

    return wallet.createAsset({ memeplexGrant: { v: 1, client: named, request: did, ...more } }, { registry: REGISTRY });
}

async function granted(wallet: Keymaster) {
    const agent = await signIn(wallet);
    const grantDid = await grant(wallet, (await agent.get('/api/v1/me')).body.link);

    await anchor();

    return { agent, grantDid };
}

// Where the service keeps a body: its node's IPFS, as the service wires it.
// How many bodies the service has stored.
let stored = 0;
const content = {
    add: (text: string) => { stored += 1; return gatekeeper.addText(text); },
};
// Where the service keeps a paper's files: its node's IPFS, as the service wires it.
const files = { add: (data: Buffer) => gatekeeper.addData(data) };
let limits: number[] = [];
const images = {
    get: async (cid: string, limit: number) => {
        limits.push(limit);

        // The node holds to the limit it is asked for, as the service asks it.
        return gatekeeper.getData(cid, limit).catch(() => null);
    },
};
// Whose each address is, as its domain would say, and what was asked.
let owners: Record<string, string | null | 'unreachable' | 'silent'> = {};
let lookups: string[] = [];
let signals: AbortSignal[] = [];
const addresses = {
    owner: async (address: string, signal: AbortSignal) => {
        lookups.push(address);
        signals.push(signal);
        const owner = owners[address] ?? null;

        if (owner === 'unreachable') {
            throw new Error('the domain cannot be reached');
        }
        if (owner === 'silent') {
            return new Promise<null>(() => undefined);
        }

        return owner;
    },
};
const objectOf = async (did: string) => ((await gatekeeper.resolveDID(did)).didDocumentData as { memeplex: Record<string, any> }).memeplex;

beforeEach(async () => {
    stored = 0;
    limits = [];
    owners = {};
    lookups = [];
    signals = [];
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
        client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, registries: [REGISTRY],
        sessionLifetime: 60_000, challengeLifetime: 60_000, now: () => clock, content, images, addresses, files,
    });
});

describe('signing in', () => {
    it('says what it is without a session, and nothing else', async () => {
        expect((await request(app).get('/api/v1/ready')).body).toBe(true);
        expect((await request(app).get('/api/v1/config')).body).toStrictEqual({ name: 'Memepool', did: serviceDid });

        // What is read without one is what a publication is shown with, and no more.
        for (const [method, path] of [
            ['get', '/api/v1/me'], ['post', '/api/v1/objects'], ['delete', '/api/v1/objects/did:cid:any'],
            ['post', '/api/v1/images'], ['get', '/api/v1/images'], ['get', '/api/v1/objects/did:cid:any/state'],
            ['post', '/api/v1/identities/did:cid:any'], ['get', '/api/v1/avatars/did:cid:any/more'],
        ] as const) {
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
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, registries: [REGISTRY], now: () => clock, challengesPerMinute: 2,
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
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, registries: [REGISTRY],
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
        expect(await asked(before.link)).toMatchObject({ client: serviceDid, request: { name: 'Memepool' } });
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
        expect((await agent.get('/api/v1/me')).body.link).toMatch(/^archon:\/\/auth\?grant=/);
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
        const grantDid = await grant(alice, (await agent.get('/api/v1/me')).body.link, { actions });

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

describe('the registries the service can publish on', () => {
    const on = (registries: string[]) => createMemepoolApp({
        client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, now: () => clock, registries,
    });

    it('lists them in the grant request it shows', async () => {
        app = on(['BTC:mainnet', 'ZEC:mainnet']);
        const agent = await signIn(alice);

        expect(await asked((await agent.get('/api/v1/me')).body.link)).toMatchObject({
            client: serviceDid, request: { registries: ['BTC:mainnet', 'ZEC:mainnet'] },
        });
    });

    it('shows a session one request, and makes another when that one nears its end', async () => {
        app = on(['BTC:mainnet']);
        const agent = await signIn(alice);
        const other = await signIn(bob);
        const first = (await agent.get('/api/v1/me')).body.link;

        expect((await agent.get('/api/v1/me')).body.link).toBe(first);
        expect((await other.get('/api/v1/me')).body.link).not.toBe(first);

        // Two reads at once share the request being made.
        const third = await signIn((await keymasterFor('carol')).keymaster);
        const [one, two] = await Promise.all([third.get('/api/v1/me'), third.get('/api/v1/me')]);
        expect(one.body.link).toBe(two.body.link);

        clock += 49 * 60_000;
        expect((await agent.get('/api/v1/me')).body.link).toBe(first);
        clock += 2 * 60_000;
        expect((await agent.get('/api/v1/me')).body.link).not.toBe(first);
    });

    it('asks for no grant on a node with no registry a grant may be on, and says so', async () => {
        app = on([]);
        const agent = await signIn(alice);

        expect((await agent.get('/api/v1/me')).body).toStrictEqual({
            did: aliceDid, pending: [], unavailable: 'this node supports no registry a grant may be made on',
        });
    });

    it('does not wait on a grant that is on a registry its node lacks', async () => {
        app = on(['ZEC:mainnet']);
        const agent = await signIn(alice);
        const before = (await agent.get('/api/v1/me')).body;

        // On a registry the service cannot publish on, and not anchored yet.
        await alice.createAsset({ memeplexGrant: { v: 1, client: serviceDid } }, { registry: REGISTRY });
        const after = (await agent.get('/api/v1/me')).body;

        expect(after.pending).toStrictEqual([]);
        expect(after.link).toMatch(/^archon:\/\/auth\?grant=/);
        expect(before.pending).toStrictEqual([]);
    }, 120_000);

    it('asks its node each time, and keeps a registry the node has dropped for a while', async () => {
        let supported = ['hyperswarm', 'BTC:mainnet'];
        app = createMemepoolApp({
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, now: () => clock,
            registries: async () => supported,
        });
        const { grantDid } = await granted(alice);
        const agent = await signIn(alice);

        expect((await agent.get('/api/v1/me')).body.grant).toBe(grantDid);

        // The node drops a registry while its queue is full.
        supported = ['hyperswarm'];
        expect((await agent.get('/api/v1/me')).body.grant).toBe(grantDid);

        // And one the node gains is one the service asks for.
        supported = ['hyperswarm', 'ZEC:mainnet'];
        await alice.revokeDID(grantDid);
        await anchor();
        expect(await asked((await agent.get('/api/v1/me')).body.link)).toMatchObject({ request: { registries: ['BTC:mainnet', 'ZEC:mainnet'] } });
    }, 120_000);

    it('does not take a grant on a registry its node lacks as one to publish under', async () => {
        const { grantDid } = await granted(alice);

        app = on(['ZEC:mainnet']);
        const elsewhere = await signIn(alice);
        const me = (await elsewhere.get('/api/v1/me')).body;

        expect(me.grant).toBeUndefined();
        expect(me.link).toMatch(/^archon:\/\/auth\?grant=/);
        expect((await elsewhere.post('/api/v1/objects').send({ kind: 'post', text: 'Unreachable.' })).status).toBe(403);

        app = on(['BTC:mainnet']);
        const here = await signIn(alice);
        expect((await here.get('/api/v1/me')).body.grant).toBe(grantDid);
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

    it('says where an object of the user\'s stands: waiting, published, withdrawn, or never to be', async () => {
        const { agent, grantDid } = await granted(alice);
        const stateOf = async (did: string, by = agent) => (await by.get(`/api/v1/objects/${encodeURIComponent(did)}/state`)).body;
        const { did } = (await agent.post('/api/v1/objects').send({ kind: 'post', text: 'A post.' })).body;

        expect(await stateOf(did)).toStrictEqual({ state: 'pending', registry: REGISTRY });
        await anchor();
        expect(await stateOf(did)).toStrictEqual({ state: 'published', registry: REGISTRY });

        await agent.delete(`/api/v1/objects/${did}`);
        await anchor();
        expect(await stateOf(did)).toStrictEqual({ state: 'withdrawn', registry: REGISTRY });

        // An object made under a grant that is revoked before it is anchored is never published.
        const late = (await agent.post('/api/v1/objects').send({ kind: 'post', text: 'Too late.' })).body.did;
        await alice.revokeDID(grantDid);
        await anchor();
        expect(await stateOf(late)).toStrictEqual({ state: 'none', registry: REGISTRY });

        // Saying so reads the object and its grant, and no other user's grants.
        const every = jest.spyOn(client, 'grantsFrom');
        await stateOf(late);
        expect(every).not.toHaveBeenCalled();
        every.mockRestore();
    }, 120_000);

    it('says nothing of an object that is another user\'s, that it did not publish, or to nobody signed in', async () => {
        const { agent } = await granted(alice);
        const { did } = (await agent.post('/api/v1/objects').send({ kind: 'post', text: 'A post.' })).body;
        const other = await signIn(bob);
        const stateOf = (of: string, by: { get: (path: string) => request.Test }) => by.get(`/api/v1/objects/${encodeURIComponent(of)}/state`);

        expect((await stateOf(did, other)).status).toBe(404);
        expect((await stateOf(did, request(app))).status).toBe(401);
        // An asset of the user's own that the service did not make, an identity, and what is no DID.
        expect((await stateOf(await alice.createAsset({ memeplex: { v: 1, kind: 'post', author: aliceDid, grant: 'did:cid:any', text: 'x' } }, { registry: 'hyperswarm' }), agent)).status).toBe(404);
        expect((await stateOf(aliceDid, agent)).status).toBe(404);
        expect((await stateOf('memepool', agent)).status).toBe(404);
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

describe('an article', () => {
    const BODY = '# Why every post should be a DID\n\nPermalinks, edit history and provable timestamps, for free.\n';
    const article = { kind: 'post', title: 'Why every post should be a DID', summary: 'Permalinks for free.', body: BODY };

    it('stores the body on its node and publishes the reference to it, with no body in the entry', async () => {
        const { agent, grantDid } = await granted(alice);
        const { did } = (await agent.post('/api/v1/objects').send(article)).body;
        const published = await objectOf(did);

        expect(published).toStrictEqual({
            v: 1, kind: 'post', author: aliceDid, grant: grantDid, title: article.title, summary: article.summary,
            content: { cid: expect.stringMatching(/^b[a-z2-7]+$/), type: 'text/markdown', bytes: Buffer.byteLength(BODY) },
        });
        // The node's IPFS has it, which is where it is pinned.
        expect(await gatekeeper.getText(published.content.cid)).toBe(BODY);
    }, 120_000);

    it('publishes an article with the subtitle a writer gives it', async () => {
        const { agent } = await granted(alice);
        const { did } = (await agent.post('/api/v1/objects').send({ kind: 'post', title: 'On DIDs', subtitle: 'What they are for.', body: BODY })).body;

        expect(await objectOf(did)).toMatchObject({ kind: 'post', title: 'On DIDs', subtitle: 'What they are for.' });
        // A subtitle is of a title: with none, there is nothing for it to be under.
        expect((await agent.post('/api/v1/objects').send({ kind: 'post', subtitle: 'Of nothing.', text: 'A post.' })).status).toBe(400);
    }, 120_000);

    it('takes no reference to content it has not stored', async () => {
        const { agent } = await granted(alice);
        const elsewhere = { cid: await gatekeeper.addText('kept by someone else'), type: 'text/markdown', bytes: 20 };

        for (const reference of ['content', 'pdf', 'source']) {
            const refused = await agent.post('/api/v1/objects').send({ kind: 'post', title: 'Borrowed', [reference]: elsewhere });

            expect(refused.status).toBe(400);
            expect(refused.body.error).toMatch(/has not stored/);
        }
        expect(await service.listAssets()).toHaveLength(0);
    }, 120_000);

    it('refuses a body that is none, too large, or on a kind that has none', async () => {
        const { agent } = await granted(alice);
        const post = (await agent.post('/api/v1/objects').send({ kind: 'post', text: 'A post.' })).body.did;

        await anchor();
        for (const [object, why] of [
            [{ ...article, body: '' }, /text of the article/],
            [{ ...article, body: 7 }, /text of the article/],
            [{ ...article, body: 'x'.repeat(BODY_LIMIT + 1) }, /may be 200000 bytes/],
            [{ kind: 'reply', target: post, targetVersion: 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', body: BODY }, /a reply has no body/],
        ] as const) {
            const refused = await agent.post('/api/v1/objects').send(object);

            expect(refused.status).toBe(400);
            expect(refused.body.error).toMatch(why);
        }
        // A body at the limit, counted in bytes and not in characters.
        expect((await agent.post('/api/v1/objects').send({ ...article, body: 'é'.repeat(BODY_LIMIT / 2) })).status).toBe(200);
        expect((await agent.post('/api/v1/objects').send({ ...article, body: `${'é'.repeat(BODY_LIMIT / 2)}x` })).status).toBe(400);
    }, 120_000);

    it('keeps the body when an edit leaves it alone, and stores another when it changes', async () => {
        const { agent, grantDid } = await granted(alice);
        const { did } = (await agent.post('/api/v1/objects').send(article)).body;
        const first = await objectOf(did);

        await anchor();
        expect((await agent.put(`/api/v1/objects/${did}`).send({ kind: 'post', title: 'Retitled', content: first.content })).status).toBe(200);
        expect(await objectOf(did)).toStrictEqual({ v: 1, kind: 'post', author: aliceDid, grant: grantDid, title: 'Retitled', content: first.content });

        // The same reference, however its members are ordered.
        await anchor();
        const { cid, type, bytes } = first.content;
        expect((await agent.put(`/api/v1/objects/${did}`).send({ kind: 'post', title: 'Retitled twice', content: { bytes, type, cid } })).status).toBe(200);
        expect((await agent.put(`/api/v1/objects/${did}`).send({ kind: 'post', title: 'Retitled', content: { cid, type, bytes, more: 1 } })).status).toBe(400);

        await anchor();
        expect((await agent.put(`/api/v1/objects/${did}`).send({ kind: 'post', title: 'Retitled', body: `${BODY}More.\n` })).status).toBe(200);
        const revised = await objectOf(did);

        expect(revised.content.cid).not.toBe(first.content.cid);
        expect(await gatekeeper.getText(revised.content.cid)).toBe(`${BODY}More.\n`);
        // The earlier body is still on the node, for the versions that refer to it.
        expect(await gatekeeper.getText(first.content.cid)).toBe(BODY);

        // An edit cannot bring in a reference the entry does not already have.
        const other = { cid: await gatekeeper.addText('another'), type: 'text/markdown', bytes: 7 };
        expect((await agent.put(`/api/v1/objects/${did}`).send({ kind: 'post', title: 'Retitled', content: other })).status).toBe(400);
    }, 120_000);

    it('stores no body for an object it would not publish', async () => {
        const { agent } = await granted(alice);
        const { did } = (await agent.post('/api/v1/objects').send(article)).body;

        await anchor();
        expect(stored).toBe(1);
        for (const refused of [
            await agent.post('/api/v1/objects').send({ ...article, text: 'A post has a text or a body.' }),
            await agent.post('/api/v1/objects').send({ ...article, title: 'x'.repeat(301) }),
            await agent.post('/api/v1/objects').send({ kind: 'nonsense', body: BODY }),
            // An edit that would change what the object is.
            await agent.put(`/api/v1/objects/${did}`).send({ kind: 'paper', title: article.title, authors: [aliceDid], body: BODY }),
        ]) {
            expect(refused.status).toBe(400);
        }
        expect(stored).toBe(1);
    }, 120_000);

    it('takes a body at the limit however it is written in the request', async () => {
        const { agent } = await granted(alice);
        const lines = '\n'.repeat(BODY_LIMIT);
        const sent = JSON.stringify({ ...article, body: lines }).replace(/\\n/g, '\\u000a');

        // Six bytes of request for each byte of body.
        expect(sent.length).toBeGreaterThan(BODY_LIMIT * 6);
        const published = await agent.post('/api/v1/objects').set('Content-Type', 'application/json').send(sent);

        expect(published.status).toBe(200);
        expect((await objectOf(published.body.did)).content.bytes).toBe(BODY_LIMIT);
        // A request that is no object's is not given that room.
        expect((await agent.post('/api/v1/login').send({ response: 'x'.repeat(300_000) })).status).toBe(413);
    }, 120_000);

    it('publishes no body when it has nowhere to store one', async () => {
        app = createMemepoolApp({
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, registries: [REGISTRY], now: () => clock,
        });
        const { agent } = await granted(alice);
        const refused = await agent.post('/api/v1/objects').send(article);

        expect(refused.status).toBe(400);
        expect(refused.body.error).toMatch(/stores no content/);
        expect((await agent.post('/api/v1/objects').send({ kind: 'post', text: 'A post.' })).status).toBe(200);
    }, 120_000);
});

// An identity's avatar is the image asset its document names as `avatar`. It
// is whatever the identity's owner chose.
describe('an author\'s avatar', () => {
    const picture = () => sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
    const name = async (keymaster: Keymaster, did: string, avatar: unknown) => {
        const doc = await keymaster.resolveDID(did);

        await keymaster.updateDID(did, { ...doc, didDocumentData: { ...doc.didDocumentData as object, avatar } });
    };
    let reader: Awaited<ReturnType<typeof signIn>>;
    const avatarOf = (did: string, by: { get: (path: string) => request.Test } = reader) => by.get(`/api/v1/avatars/${encodeURIComponent(did)}`).buffer(true).parse((res, done) => {
        const parts: Buffer[] = [];

        res.on('data', (part: Buffer) => parts.push(part));
        res.on('end', () => done(null, Buffer.concat(parts)));
    });
    // An asset that says it is an image, of bytes that are whatever is given.
    const claimed = async (data: Buffer, file: Record<string, unknown> = {}) => alice.createAsset({
        file: { cid: await gatekeeper.addData(data), type: 'image/png', bytes: data.length, ...file },
        image: { width: 8, height: 8 },
    }, { registry: 'hyperswarm' });

    beforeEach(async () => {
        reader = await signIn(bob);
    }, 120_000);

    it('is served as the image it is, to anyone, for the browser to keep a while and take for nothing else', async () => {
        const image = await picture();

        await name(alice, aliceDid, await alice.createImage(image, { registry: 'hyperswarm' }));
        const served = await avatarOf(aliceDid);

        expect(served.status).toBe(200);
        expect(served.headers['content-type']).toBe('image/png');
        expect(served.headers['x-content-type-options']).toBe('nosniff');
        expect(served.headers['cache-control']).toBe('private, max-age=300');
        expect(Buffer.compare(served.body, image)).toBe(0);
        expect(limits).toStrictEqual([AVATAR_LIMIT]);

        // It is read by anyone, as a publication is, under the same limit.
        expect(Buffer.compare((await avatarOf(aliceDid, request(app))).body, image)).toBe(0);
        expect(new Set(limits)).toStrictEqual(new Set([AVATAR_LIMIT]));
    }, 120_000);

    it('is not found for an identity that names none, for one that does not exist, and for what is no DID', async () => {
        expect((await avatarOf(aliceDid)).status).toBe(404);
        expect((await avatarOf('did:cid:bagaaieranosuchidentityaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
        expect((await avatarOf('alice')).status).toBe(404);

        // What is no DID is resolved by nobody: a name would be looked up in the
        // service's wallet, and an address asked of its domain.
        const resolved = jest.spyOn(service, 'resolveDID');
        expect((await avatarOf('memepool')).status).toBe(404);
        expect((await avatarOf('reader@example.org')).status).toBe(404);
        expect(resolved).not.toHaveBeenCalled();
        resolved.mockRestore();
        expect(limits).toStrictEqual([]);
    }, 120_000);

    it('is not found when what is named is not an image the service serves', async () => {
        const image = await picture();
        const refused = async (avatar: unknown) => {
            await name(alice, aliceDid, avatar);
            expect((await avatarOf(aliceDid)).status).toBe(404);
        };

        // Not a DID, and a DID that is no image asset: an identity, and an asset with no file.
        await refused('https://tracker.example/me.png');
        await refused({ did: aliceDid });
        await refused(aliceDid);
        await refused(await alice.createAsset({ note: 'no file' }, { registry: 'hyperswarm' }));
        // A file that is not said to be an image.
        await refused(await alice.createAsset({ file: { cid: await gatekeeper.addData(image), type: 'image/png', bytes: image.length } }, { registry: 'hyperswarm' }));
        // A document that can hold a script, and bytes of no kind.
        await refused(await claimed(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { type: 'image/svg+xml' }));
        await refused(await claimed(image, { type: 'text/html' }));
        await refused(await claimed(image, { type: undefined }));
        // None of them was read from the node.
        expect(limits).toStrictEqual([]);

        // A deleted image.
        const deleted = await alice.createImage(image, { registry: 'hyperswarm' });
        await alice.revokeDID(deleted);
        await refused(deleted);
        expect(limits).toStrictEqual([]);
    }, 120_000);

    it('is not found when it is larger than the service serves, whatever size it says it is', async () => {
        const large = Buffer.alloc(AVATAR_LIMIT + 1, 1);

        // One that says so is not read.
        await name(alice, aliceDid, await claimed(large));
        expect((await avatarOf(aliceDid)).status).toBe(404);
        expect(limits).toStrictEqual([]);

        // One that says it is small is read no further than the limit.
        await name(alice, aliceDid, await claimed(large, { bytes: 10 }));
        expect((await avatarOf(aliceDid)).status).toBe(404);
        expect(limits).toStrictEqual([AVATAR_LIMIT]);

        await name(alice, aliceDid, await claimed(large, { bytes: undefined }));
        expect((await avatarOf(aliceDid)).status).toBe(404);
    }, 120_000);

    it('serves a JPEG named the short way as a JPEG, and none when the service reads no images', async () => {
        const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 255 } } }).jpeg().toBuffer();

        await name(alice, aliceDid, await claimed(image, { type: ' Image/JPG ' }));
        expect((await avatarOf(aliceDid)).headers['content-type']).toBe('image/jpeg');

        app = createMemepoolApp({
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, registries: [REGISTRY], now: () => clock,
            sessionLifetime: 60_000, challengeLifetime: 60_000,
        });
        reader = await signIn(bob);
        expect((await avatarOf(aliceDid)).status).toBe(404);
    }, 120_000);
});

// An image a user means to embed is stored by the service, as an image asset.
describe('storing an image', () => {
    const picture = (width = 8, height = 8) => sharp({ create: { width, height, channels: 3, background: { r: 0, g: 128, b: 0 } } });
    const send = (by: { post: (path: string) => request.Test }, bytes: Buffer, type = 'application/octet-stream') =>
        by.post('/api/v1/images').set('Content-Type', type).send(bytes);

    it('makes an image asset of what a user who has granted it sends, which is then embedded and served', async () => {
        const { agent } = await granted(alice);
        const image = await picture().png().toBuffer();
        const made = await send(agent, image);

        expect(made.status).toBe(200);
        expect(made.body).toMatchObject({ type: 'image/png', bytes: image.length, width: 8, height: 8 });

        // The asset is the service's own, pinned on its node, and at the version given.
        const asset = await gatekeeper.resolveDID(made.body.did);
        expect(asset.didDocument?.controller).toBe(serviceDid);
        expect(asset.didDocumentRegistration?.registry).toBe('hyperswarm');
        expect(asset.didDocumentMetadata?.versionId).toBe(made.body.versionId);
        expect((asset.didDocumentData as { file: { cid: string } }).file.cid).toBe(await gatekeeper.addData(image));

        const served = await agent.get(`/api/v1/images/${encodeURIComponent(made.body.did)}`).query({ versionId: made.body.versionId }).buffer(true).parse((res, done) => {
            const parts: Buffer[] = [];

            res.on('data', (part: Buffer) => parts.push(part));
            res.on('end', () => done(null, Buffer.concat(parts)));
        });
        expect(served.headers['content-type']).toBe('image/png');
        expect(Buffer.compare(served.body, image)).toBe(0);
    }, 120_000);

    it('takes each kind of image that text may embed, and says what it is from the bytes', async () => {
        const { agent } = await granted(alice);

        expect((await send(agent, await picture().jpeg().toBuffer())).body.type).toBe('image/jpeg');
        expect((await send(agent, await picture().webp().toBuffer())).body.type).toBe('image/webp');
        expect((await send(agent, await picture().gif().toBuffer())).body.type).toBe('image/gif');
    }, 120_000);

    it('stores nothing that is not such an image', async () => {
        const { agent } = await granted(alice);
        const added = jest.spyOn(gatekeeper, 'addData');
        const refused = async (bytes: Buffer, status = 400, type?: string) => expect((await send(agent, bytes, type)).status).toBe(status);

        await refused(Buffer.from('not an image at all'));
        await refused(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>'));
        await refused(await picture().avif().toBuffer());
        await refused(await picture().tiff().toBuffer());
        // More pixels than text may embed, in few bytes.
        await refused(await picture(8000, 5001).png({ compressionLevel: 9 }).toBuffer());
        // Nothing sent, and bytes sent as something else, which the service does not read.
        await refused(Buffer.alloc(0));
        await refused(await picture().png().toBuffer(), 400, 'image/png');
        // More bytes than an image may have.
        await refused(Buffer.alloc(IMAGE_LIMIT + 1, 1), 413);

        expect(added).not.toHaveBeenCalled();
        added.mockRestore();
    }, 120_000);

    it('stores an image only for a user who has granted the service, and only so many in an hour', async () => {
        const image = await picture().png().toBuffer();
        const stranger = await signIn(bob);

        expect((await send(request(app), image)).status).toBe(401);
        expect((await send(stranger, image)).status).toBe(403);

        app = createMemepoolApp({
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, registries: [REGISTRY],
            sessionLifetime: 60 * 60_000 * 3, challengeLifetime: 60_000, now: () => clock, content, images, imagesPerHour: 2,
        });
        const { agent } = await granted(alice);

        expect((await send(agent, image)).status).toBe(200);
        expect((await send(agent, image)).status).toBe(200);
        const third = await send(agent, image);
        expect(third.status).toBe(429);
        expect(third.body.error).toMatch(/within the hour/);

        // An hour on, there is room again.
        clock += 61 * 60_000;
        expect((await send(agent, image)).status).toBe(200);
    }, 120_000);

    it('takes none when it has nowhere to serve them from', async () => {
        app = createMemepoolApp({
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, registries: [REGISTRY], now: () => clock,
            sessionLifetime: 60_000, challengeLifetime: 60_000,
        });
        const { agent } = await granted(alice);

        expect((await send(agent, await picture().png().toBuffer())).status).toBe(501);
    }, 120_000);
});

// A paper's PDF and its source are stored by the service, for the paper that will refer to them.
describe('a paper\'s files', () => {
    // As a PDF is: its opening, and bytes after it that are no text.
    const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 0xff)]);
    const TEX = Buffer.from('\\documentclass{article}\n\\begin{document}Ünïcode.\\end{document}\n');
    const GZIP = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(40, 3)]);
    const BODY = '# A paper\n\nIts text.\n';
    const send = (by: { post: (path: string) => request.Test }, kind: string | undefined, bytes: Buffer, type = 'application/octet-stream') =>
        by.post('/api/v1/files').query(kind === undefined ? {} : { kind }).set('Content-Type', type).send(bytes);
    const paper = (more: Record<string, unknown>) => ({ kind: 'paper', title: 'A paper', summary: 'About it.', authors: [aliceDid], body: BODY, ...more });

    it('stores a PDF and a source for a user who has granted it, and publishes a paper that refers to them', async () => {
        const { agent } = await granted(alice);
        const pdf = await send(agent, 'pdf', PDF);
        const source = await send(agent, 'source', TEX);

        expect(pdf.status).toBe(200);
        expect(pdf.body).toStrictEqual({ cid: expect.any(String), type: 'application/pdf', bytes: PDF.length });
        expect(source.body).toStrictEqual({ cid: expect.any(String), type: 'application/x-tex', bytes: TEX.length });
        // They are on the node, pinned, as they were sent.
        expect(Buffer.compare((await gatekeeper.getData(pdf.body.cid))!, PDF)).toBe(0);

        const made = await agent.post('/api/v1/objects').send(paper({ pdf: pdf.body, source: source.body }));

        expect(made.status).toBe(200);
        const published = (await gatekeeper.resolveDID(made.body.did)).didDocumentData as { memeplex: Record<string, unknown> };

        expect(published.memeplex).toMatchObject({ kind: 'paper', pdf: pdf.body, source: source.body });

        // An edit keeps the files the paper has, and may leave one off.
        await anchor();
        expect((await agent.put(`/api/v1/objects/${made.body.did}`).send({ kind: 'paper', title: 'A paper, revised', summary: 'About it.', authors: [aliceDid], content: published.memeplex.content, pdf: pdf.body })).status).toBe(200);
    }, 120_000);

    it('names a source that is an archive as one, by its bytes', async () => {
        const { agent } = await granted(alice);

        expect((await send(agent, 'source', GZIP)).body).toMatchObject({ type: 'application/gzip', bytes: GZIP.length });
    }, 120_000);

    it('stores nothing that is not what it is said to be', async () => {
        const { agent } = await granted(alice);
        const added = jest.spyOn(files, 'add');

        for (const [kind, bytes, error] of [
            ['pdf', TEX, /not a PDF/],
            ['pdf', Buffer.from('<html>%PDF-'), /not a PDF/],
            ['source', Buffer.concat([Buffer.from('text'), Buffer.from([0])]), /LaTeX, or a gzip archive/],
            ['source', PDF, /LaTeX, or a gzip archive/],
            ['source', Buffer.from([0xff, 0xfe, 0xfd]), /LaTeX, or a gzip archive/],
            ['image', PDF, /say which with `kind`/],
            [undefined, PDF, /say which with `kind`/],
            ['pdf', Buffer.alloc(0), /expected the bytes/],
        ] as const) {
            const refused = await send(agent, kind, bytes);

            expect([kind, refused.status]).toStrictEqual([kind, 400]);
            expect(refused.body.error).toMatch(error);
        }
        // Bytes sent as another type do not arrive as bytes.
        expect((await send(agent, 'pdf', PDF, 'application/pdf')).status).toBe(400);
        // More than a file may be.
        expect((await send(agent, 'pdf', Buffer.concat([PDF, Buffer.alloc(FILE_LIMIT)]))).status).toBe(413);
        expect(added).not.toHaveBeenCalled();
        added.mockRestore();
    }, 120_000);

    it('is for a user who has granted it, and counts a file with their images in the hour', async () => {
        expect((await send(request(app), 'pdf', PDF)).status).toBe(401);
        expect((await send(await signIn(bob), 'pdf', PDF)).status).toBe(403);

        app = createMemepoolApp({
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, registries: [REGISTRY],
            sessionLifetime: 60 * 60_000 * 3, challengeLifetime: 60_000, now: () => clock, content, images, files, imagesPerHour: 2,
        });
        const { agent } = await granted(alice);
        const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 128, b: 0 } } }).png().toBuffer();

        expect((await agent.post('/api/v1/images').set('Content-Type', 'application/octet-stream').send(image)).status).toBe(200);
        expect((await send(agent, 'pdf', PDF)).status).toBe(200);
        const third = await send(agent, 'source', TEX);

        expect(third.status).toBe(429);
        expect(third.body.error).toMatch(/within the hour/);
    }, 120_000);

    it('publishes no paper that refers to a file it did not store for its publisher, or stored as another thing', async () => {
        // A session that outlasts the hour a file is kept for.
        app = createMemepoolApp({
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, registries: [REGISTRY],
            sessionLifetime: 60 * 60_000 * 3, challengeLifetime: 60_000, now: () => clock, content, images, files,
        });
        const { agent } = await granted(alice);
        const pdf = (await send(agent, 'pdf', PDF)).body;
        const source = (await send(agent, 'source', TEX)).body;
        const elsewhere = { cid: await gatekeeper.addData(PDF.subarray(0, 100)), type: 'application/pdf', bytes: 100 };
        const refused = async (more: Record<string, unknown>) => {
            const answer = await agent.post('/api/v1/objects').send(paper(more));

            expect([more, answer.status]).toStrictEqual([more, 400]);
            expect(answer.body.error).toMatch(/has not stored what/);
        };

        // Bytes on the node that the service did not store.
        await refused({ pdf: elsewhere });
        // What it stored, said to be of another size or kind, or in the other's place.
        await refused({ pdf: { ...pdf, bytes: pdf.bytes + 1 } });
        await refused({ source: { ...source, type: 'application/gzip' } });
        await refused({ source: { ...pdf } });

        // What is no reference at all is refused as one, and breaks nothing.
        for (const odd of [{ cid: { toString: null }, type: 'application/pdf', bytes: 1 }, { cid: 7, type: 'application/pdf', bytes: 1 }, null, 'bafy', []]) {
            expect([odd, (await agent.post('/api/v1/objects').send(paper({ pdf: odd }))).status]).toStrictEqual([odd, 400]);
        }

        // What another user had it store is not this one's to publish.
        const other = await granted(bob);
        const bobDid = (await bob.resolveDID('bob')).didDocument!.id!;
        const theirs = await other.agent.post('/api/v1/objects').send({ kind: 'paper', title: 'Bob\'s', summary: 'His.', authors: [bobDid], body: BODY, pdf });

        expect(theirs.status).toBe(400);

        // Nor is it the publisher's once the hour it is kept for has gone.
        clock += 61 * 60_000;
        await refused({ pdf });
    }, 180_000);

    it('stores no more than it can hold for their papers, and forgets none it has answered for', async () => {
        app = createMemepoolApp({
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, registries: [REGISTRY],
            sessionLifetime: 60 * 60_000 * 3, challengeLifetime: 60_000, now: () => clock, content, images, files, filesHeld: 2,
        });
        const { agent } = await granted(alice);
        const added = jest.spyOn(files, 'add');
        const first = (await send(agent, 'pdf', PDF)).body;

        expect((await send(agent, 'source', TEX)).status).toBe(200);
        // A third would put out one of the two, so it is not stored at all.
        const third = await send(agent, 'source', GZIP);

        expect(third.status).toBe(503);
        expect(added).toHaveBeenCalledTimes(2);
        // The first is still the user's to publish.
        expect((await agent.post('/api/v1/objects').send(paper({ pdf: first }))).status).toBe(200);

        // Once those it holds are past their hour there is room.
        clock += 61 * 60_000;
        expect((await send(agent, 'source', GZIP)).status).toBe(200);
        added.mockRestore();
    }, 120_000);

    it('gives the last place it has to one of two files sent at once', async () => {
        app = createMemepoolApp({
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, registries: [REGISTRY],
            sessionLifetime: 60 * 60_000 * 3, challengeLifetime: 60_000, now: () => clock, content, images, files, filesHeld: 2,
        });
        const { agent } = await granted(alice);
        const first = (await send(agent, 'pdf', PDF)).body;
        const both = await Promise.all([send(agent, 'source', TEX), send(agent, 'source', GZIP)]);

        expect(both.map(each => each.status).sort()).toStrictEqual([200, 503]);
        // The one answered for before them is still the user's to publish.
        expect((await agent.post('/api/v1/objects').send(paper({ pdf: first }))).status).toBe(200);

        // A file that could not be stored gives its place back.
        clock += 61 * 60_000;
        const failing = jest.spyOn(files, 'add').mockRejectedValueOnce(new Error('no node'));

        expect((await send(agent, 'pdf', PDF)).status).toBe(502);
        failing.mockRestore();
        expect((await send(agent, 'pdf', PDF)).status).toBe(200);
        expect((await send(agent, 'source', TEX)).status).toBe(200);
    }, 120_000);

    it('stores none when it has nowhere to keep them', async () => {
        app = createMemepoolApp({
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, registries: [REGISTRY], now: () => clock,
            sessionLifetime: 60_000, challengeLifetime: 60_000, content,
        });
        const { agent } = await granted(alice);

        expect((await send(agent, 'pdf', PDF)).status).toBe(501);
    }, 120_000);
});

// An image embedded in text is an image asset at one version.
describe('an embedded image', () => {
    let reader: Awaited<ReturnType<typeof signIn>>;
    const picture = (colour: number) => sharp({ create: { width: 8, height: 8, channels: 3, background: { r: colour, g: 0, b: 0 } } }).png().toBuffer();
    const versionOf = async (did: string) => (await gatekeeper.resolveDID(did)).didDocumentMetadata!.versionId!;
    const imageAt = (did: string, versionId?: string, by: { get: (path: string) => request.Test } = reader) =>
        by.get(`/api/v1/images/${encodeURIComponent(did)}`).query(versionId ? { versionId } : {}).buffer(true).parse((res, done) => {
            const parts: Buffer[] = [];

            res.on('data', (part: Buffer) => parts.push(part));
            res.on('end', () => done(null, Buffer.concat(parts)));
        });
    const claimed = async (data: Buffer, file: Record<string, unknown> = {}, image: Record<string, unknown> = { width: 8, height: 8 }) => alice.createAsset({
        file: { cid: await gatekeeper.addData(data), type: 'image/png', bytes: data.length, ...file }, image,
    }, { registry: 'hyperswarm' });

    beforeEach(async () => {
        reader = await signIn(bob);
    }, 120_000);

    it('is served at the version named, for a browser to keep, to anyone', async () => {
        const first = await picture(255);
        const did = await alice.createImage(first, { registry: 'hyperswarm' });
        const version = await versionOf(did);

        // The image is replaced since, which is another version.
        await alice.updateImage(did, await picture(10));
        expect(await versionOf(did)).not.toBe(version);

        const served = await imageAt(did, version);

        expect(served.status).toBe(200);
        expect(served.headers['content-type']).toBe('image/png');
        expect(served.headers['x-content-type-options']).toBe('nosniff');
        expect(served.headers['cache-control']).toBe('private, max-age=31536000, immutable');
        expect(Buffer.compare(served.body, first)).toBe(0);
        expect(limits).toStrictEqual([IMAGE_LIMIT]);

        expect((await imageAt(did, version, request(app))).status).toBe(200);
    }, 120_000);

    it('is not found without a version, at a version that is not the asset\'s, or for what is no DID', async () => {
        const did = await alice.createImage(await picture(255), { registry: 'hyperswarm' });

        expect((await imageAt(did)).status).toBe(404);
        expect((await imageAt(did, 'bafyreinotaversionofthisasset')).status).toBe(404);
        const version = await versionOf(did);
        const resolved = jest.spyOn(service, 'resolveDID');
        expect((await imageAt('alice', version)).status).toBe(404);
        expect((await imageAt('reader@example.org', version)).status).toBe(404);
        expect(resolved).not.toHaveBeenCalled();
        resolved.mockRestore();
        expect(limits).toStrictEqual([]);
    }, 120_000);

    it('is not found for what is not an image of a kind and size that text may embed', async () => {
        const image = await picture(255);
        const refused = async (did: string) => expect((await imageAt(did, await versionOf(did))).status).toBe(404);

        await refused(aliceDid);
        await refused(await alice.createAsset({ note: 'no file' }, { registry: 'hyperswarm' }));
        await refused(await claimed(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { type: 'image/svg+xml' }));
        // A kind an avatar may be and an embed may not.
        await refused(await claimed(image, { type: 'image/avif' }));
        await refused(await claimed(image, { type: 'text/html' }));
        // More bytes than an image may have, and more pixels, by its own account.
        await refused(await claimed(image, { bytes: IMAGE_LIMIT + 1 }));
        await refused(await claimed(image, {}, { width: 8000, height: 5001 }));
        expect(limits).toStrictEqual([]);

        // A deleted image has no version that is served.
        const deleted = await alice.createImage(image, { registry: 'hyperswarm' });
        await alice.revokeDID(deleted);
        await refused(deleted);
        expect(limits).toStrictEqual([]);
    }, 120_000);

    it('serves a JPEG named the short way, and one whose asset gives no size', async () => {
        const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 255 } } }).jpeg().toBuffer();
        const did = await claimed(image, { type: 'image/jpg', bytes: undefined }, { note: 'no size' });
        const served = await imageAt(did, await versionOf(did));

        expect(served.status).toBe(200);
        expect(served.headers['content-type']).toBe('image/jpeg');
    }, 120_000);
});

// What an identity says of itself in its document: a name, which is its own to
// choose, and an address, which is a domain's to give.
describe('an author\'s name and address', () => {
    let reader: Awaited<ReturnType<typeof signIn>>;
    const say = async (keymaster: Keymaster, did: string, more: Record<string, unknown>) => {
        const doc = await keymaster.resolveDID(did);

        await keymaster.updateDID(did, { ...doc, didDocumentData: { ...doc.didDocumentData as object, ...more } });
    };
    const identityOf = async (did: string) => (await reader.get(`/api/v1/identities/${encodeURIComponent(did)}`)).body;
    // What is found out is kept a while.
    const later = async () => {
        clock += 11 * 60_000;
        reader = await signIn(bob);
    };

    beforeEach(async () => {
        reader = await signIn(bob);
    }, 120_000);

    it('gives the name an identity gives itself, and the address its domain says is its own', async () => {
        await say(alice, aliceDid, { name: 'Alice A.', address: 'Alice@Example.org' });
        owners['alice@example.org'] = aliceDid;

        const answer = await reader.get(`/api/v1/identities/${encodeURIComponent(aliceDid)}`);

        expect(answer.status).toBe(200);
        expect(answer.headers['cache-control']).toBe('private, max-age=60');
        expect(answer.body).toStrictEqual({ did: aliceDid, name: 'Alice A.', address: 'alice@example.org' });
        expect(lookups).toStrictEqual(['alice@example.org']);

        // It is read by anyone, as a publication is.
        expect((await request(app).get(`/api/v1/identities/${encodeURIComponent(aliceDid)}`)).body).toStrictEqual({ did: aliceDid, name: 'Alice A.', address: 'alice@example.org' });
    }, 120_000);

    // The node's client puts a DID in the path of its request.
    it('asks the node for nothing that has not the shape of a DID, from a request or from a document', async () => {
        const cid = await gatekeeper.addJSON({ didDocument: { id: aliceDid }, didDocumentData: { name: 'Not Alice' } });
        const resolved = jest.spyOn(service, 'resolveDID');

        for (const path of ['identities', 'avatars', 'images']) {
            for (const did of [`did:cid:x/../../ipfs/json/${cid}`, 'did:cid:x/..', 'did:cid:x?y=1', 'did:cid:x#y', 'did:cid:', 'did::x', 'DID:cid:x']) {
                const answer = await request(app).get(`/api/v1/${path}/${encodeURIComponent(did)}`).query({ versionId: 'bafyversion' });

                expect([path, did, [400, 404].includes(answer.status)]).toStrictEqual([path, did, true]);
            }
        }
        expect(resolved).not.toHaveBeenCalled();

        // An avatar named by a document is a stranger's string as well.
        await say(alice, aliceDid, { avatar: `did:cid:x/../../ipfs/json/${cid}` });
        resolved.mockClear();
        expect((await request(app).get(`/api/v1/avatars/${encodeURIComponent(aliceDid)}`)).status).toBe(404);
        expect(resolved.mock.calls.map(call => call[0])).toStrictEqual([aliceDid]);
        resolved.mockRestore();
    }, 120_000);

    it('gives no address that its domain does not say is this identity\'s', async () => {
        const bobDid = (await bob.resolveDID('bob')).didDocument!.id!;

        await say(alice, aliceDid, { name: 'Alice', address: 'bob@example.org' });

        // The domain says it is another's.
        owners['bob@example.org'] = bobDid;
        expect(await identityOf(aliceDid)).toStrictEqual({ did: aliceDid, name: 'Alice' });

        // It says it is nobody's, cannot be reached, and does not answer.
        for (const owner of [null, 'unreachable', 'silent'] as const) {
            await later();
            owners['bob@example.org'] = owner;
            expect(await identityOf(aliceDid)).toStrictEqual({ did: aliceDid, name: 'Alice' });
        }
        expect(lookups).toHaveLength(4);
        // Every asking is ended, the one that had no answer among them.
        expect(signals.map(each => each.aborted)).toStrictEqual([true, true, true, true]);
    }, 120_000);

    it('asks no domain about what is not an address', async () => {
        const notOne = [
            'alice', 'alice@', '@example.org', 'a@b@c.org', 'alice @example.org', 'alice@example', `${'a'.repeat(250)}@example.org`, 7, { name: 'alice' },
            // What would be asked of somewhere other than the domain read.
            'alice@example.org/names', 'alice@example.org:8443', 'alice@user:pass@example.org', 'alice@example.org?x=1', 'alice@[::1]', 'a/../b@example.org',
            // What reads as another address than it is: text turned about, and letters that look like others.
            '\u202Emoc.knab@evil.example', 'alice@exam\u200Bple.org', 'alice@ex\u0430mple.org', '\u0430lice@example.org',
        ];

        for (const address of notOne) {
            await say(alice, aliceDid, { address });
            await later();
            expect(await identityOf(aliceDid)).toStrictEqual({ did: aliceDid });
        }
        expect(lookups).toStrictEqual([]);
    }, 120_000);

    it('passes a name on shortened, and with nothing in it that is not printed', async () => {
        await say(alice, aliceDid, { name: `  Alice\u202E\n\t the\u0000  First ${'x'.repeat(100)}` });
        const { name } = await identityOf(aliceDid);

        expect(name.startsWith('Alice the First xxx')).toBe(true);
        expect(name).toHaveLength(64);

        for (const empty of ['   ', '\u200B\u202E', 7, ['Alice'], null]) {
            await say(alice, aliceDid, { name: empty });
            await later();
            expect(await identityOf(aliceDid)).toStrictEqual({ did: aliceDid });
        }
    }, 120_000);

    it('asks a domain once in a while, however often it is asked itself', async () => {
        await say(alice, aliceDid, { address: 'alice@example.org' });
        owners['alice@example.org'] = aliceDid;

        await Promise.all([identityOf(aliceDid), identityOf(aliceDid), identityOf(aliceDid)]);
        expect(await identityOf(aliceDid)).toStrictEqual({ did: aliceDid, address: 'alice@example.org' });
        expect(lookups).toHaveLength(1);

        // The domain may give the name to another, and then it is not this identity's.
        owners['alice@example.org'] = null;
        await later();
        expect(await identityOf(aliceDid)).toStrictEqual({ did: aliceDid });
        expect(lookups).toHaveLength(2);
    }, 120_000);

    it('gives nothing for an identity that does not exist or is deleted, and confirms no address when it has nobody to ask', async () => {
        expect(await identityOf('did:cid:bagaaieranosuchidentityaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toStrictEqual({ did: 'did:cid:bagaaieranosuchidentityaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
        expect((await reader.get('/api/v1/identities/alice')).status).toBe(404);

        await say(alice, aliceDid, { name: 'Alice', address: 'alice@example.org' });
        owners['alice@example.org'] = aliceDid;
        app = createMemepoolApp({
            client, keymaster: service, name: 'Memepool', version: { version: 'test', commit: 'test' }, registries: [REGISTRY], now: () => clock,
            sessionLifetime: 60_000, challengeLifetime: 60_000,
        });
        reader = await signIn(bob);
        expect(await identityOf(aliceDid)).toStrictEqual({ did: aliceDid, name: 'Alice' });
        expect(lookups).toStrictEqual([]);
    }, 120_000);
});
