import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import cors from 'cors';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import request from 'supertest';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { MemeplexClient } from '@didcid/memeplex/client';
import { createMemepoolApp } from '../../services/memepool/src/api.ts';
import { DEFAULT_CORS_OPTIONS } from '../../services/drawbridge/server/src/cors-options.ts';
import { memepoolProxy } from '../../services/drawbridge/server/src/memepool-proxy.ts';

// Drawbridge's public mount of the node's Memepool service, with the real
// service behind it: a user signs in and stays signed in through the mount.

let memepool: Server;
let memepoolURL: string;
let wallet: Keymaster;
let walletDid: string;
let serviceDid: string;
let pages: string;

function listen(app: express.Express): Promise<Server> {
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

// The mount as drawbridge-api.ts makes it, after its CORS handling and body
// parser and without its rate limiter, beside another route of the node's.
const drawbridge = (url = memepoolURL) => express()
    .use(cors(DEFAULT_CORS_OPTIONS))
    .use(express.json({ limit: '10mb' }))
    .use('/memepool', memepoolProxy({ memepoolURL: url }))
    .get('/elsewhere', (req, res) => { res.json({ cookie: req.headers.cookie ?? null }); });

beforeAll(async () => {
    const gatekeeper = new Gatekeeper({
        db: new DbJsonMemory('memepool-proxy'), ipfs: new MemoryClient(), registries: ['hyperswarm', 'BTC:mainnet'],
        console: { log: () => undefined, error: () => undefined, time: () => undefined, timeEnd: () => undefined } as never,
    });
    const keymasterFor = async (name: string) => {
        const made = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher: new CipherNode(), passphrase: name });

        await made.loadOrCreateWallet();

        return { keymaster: made, did: await made.createId(name, { registry: 'hyperswarm' }) };
    };
    const service = await keymasterFor('memepool');

    serviceDid = service.did;
    ({ keymaster: wallet, did: walletDid } = await keymasterFor('alice'));
    pages = mkdtempSync(join(tmpdir(), 'memepool-pages-'));
    mkdirSync(join(pages, 'assets'));
    writeFileSync(join(pages, 'index.html'), '<!doctype html><title>Memepool</title><script src="./assets/app.js"></script>');
    writeFileSync(join(pages, 'assets', 'app.js'), 'console.log("memepool")');
    memepool = await listen(createMemepoolApp({
        client: new MemeplexClient({ keymaster: service.keymaster, gatekeeper, identity: 'memepool' }),
        keymaster: service.keymaster,
        name: 'Memepool',
        version: { version: 'test', commit: 'test' },
        registries: ['BTC:mainnet'],
        pagesDir: pages,
    }));
    memepoolURL = `http://127.0.0.1:${(memepool.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise(resolve => memepool.close(resolve));
    rmSync(pages, { recursive: true, force: true });
});

it('forwards the service\'s API with the prefix stripped', async () => {
    const response = await request(drawbridge()).get('/memepool/api/v1/config');

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ name: 'Memepool', did: serviceDid });
});

it('signs a user in through the mount, with cookies kept to the mount', async () => {
    const browser = request.agent(drawbridge());
    const asked = await browser.get('/memepool/api/v1/challenge');

    expect(asked.headers['set-cookie']).toStrictEqual([
        expect.stringMatching(/^memepool_challenge=[^;]+; Path=\/memepool; HttpOnly; SameSite=Strict$/),
    ]);

    const login = await browser.post('/memepool/api/v1/login').send({ response: await wallet.createResponse(asked.body.challenge) });

    expect(login.body).toStrictEqual({ did: walletDid });
    // Two cookies in one answer: the session set, and the challenge's mark cleared.
    expect(login.headers['set-cookie']).toHaveLength(2);
    expect(login.headers['set-cookie']).toContainEqual(expect.stringMatching(/^memepool_session=[^;]+; Path=\/memepool; HttpOnly; SameSite=Strict$/));
    expect(login.headers['set-cookie']).toContainEqual(expect.stringMatching(/^memepool_challenge=; Path=\/memepool; Expires=/));

    expect((await browser.get('/memepool/api/v1/me')).body).toMatchObject({ did: walletDid });
    // The session is Memepool's, and no other route on the host is sent it.
    expect((await browser.get('/elsewhere')).body).toStrictEqual({ cookie: null });

    expect((await browser.post('/memepool/api/v1/objects').send({ kind: 'post', text: 'No grant yet.' })).status).toBe(403);
    expect((await browser.post('/memepool/api/v1/logout')).body).toBe(true);
    expect((await browser.get('/memepool/api/v1/me')).status).toBe(401);
});

it('passes the service\'s own refusals through', async () => {
    expect((await request(drawbridge()).get('/memepool/api/v1/me')).status).toBe(401);
    expect((await request(drawbridge()).put('/memepool/api/v1/objects/did:cid:any').send({ kind: 'post', text: 'x' })).status).toBe(401);
    expect((await request(drawbridge()).delete('/memepool/api/v1/objects/did:cid:any')).status).toBe(401);
});

it('serves the pages at the mount, and their files beside them', async () => {
    const page = await request(drawbridge()).get('/memepool/');

    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.text).toContain('<title>Memepool</title>');
    expect(page.headers['cache-control']).toBe('no-cache');

    const file = await request(drawbridge()).get('/memepool/assets/app.js');

    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/javascript/);
    expect(file.headers['cache-control']).toBe('public, max-age=31536000, immutable');
});

it('sends a reader who leaves off the last slash to where the pages\' files are found', async () => {
    const response = await request(drawbridge()).get('/memepool');

    expect(response.status).toBe(308);
    expect(response.headers.location).toBe('/memepool/');
});

it('only reads what is not the API', async () => {
    for (const method of ['post', 'put', 'delete'] as const) {
        expect((await request(drawbridge())[method]('/memepool/')).status).toBe(405);
        expect((await request(drawbridge())[method]('/memepool/assets/app.js')).status).toBe(405);
    }
    expect((await request(drawbridge()).get('/memepool/no-such-page')).status).toBe(404);
});

it.each([
    ['/memepool/api/v10/ready', 400],
    ['/memepool/api', 400],
    ['/memepool/api/', 400],
    ['/memepool//attacker.example/api/v1/ready', 400],
    // What follows the mount is no path.
    ['/memepool//', 400],
    ['/memepool//[', 400],
    // A path written to look like a page, that is one under the API.
    ['/memepool/assets/../api/v2/me', 400],
    // And one written to look like the API, that is a page nobody has.
    ['/memepool/api/v1/../../metrics', 404],
    ['/memepool/api/v1/no-such-route', 401],
])('answers %s with %i', async (path, status) => {
    expect((await request(drawbridge()).get(path)).status).toBe(status);
});

it('lets no write through by a path that is written as a page and is the API', async () => {
    const response = await request(drawbridge()).post('/memepool/assets/../api/v1/logout');

    // The API's own route, by its own method: what the path is, not how it is written.
    expect(response.status).toBe(200);
    expect((await request(drawbridge()).patch('/memepool/assets/../api/v1/logout')).status).toBe(405);
});

it('refuses a method the service has no use for', async () => {
    expect((await request(drawbridge()).patch('/memepool/api/v1/me')).status).toBe(405);
});

// A preflight is answered by the node's CORS handling, as on every mount, and
// does not reach the service. Any origin may ask, and none with a user's
// cookies: the answer allows no credentials.
it('answers a preflight without the service, allowing no credentials', async () => {
    const response = await request(drawbridge())
        .options('/memepool/api/v1/objects')
        .set('Origin', 'https://elsewhere.example')
        .set('Access-Control-Request-Method', 'POST');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
});

it('says the service is not enabled on a node that runs none', async () => {
    const response = await request(drawbridge('')).get('/memepool/api/v1/config');

    expect(response.status).toBe(501);
    expect(response.body).toStrictEqual({ error: 'Memepool is not enabled on this node' });
});

it('answers 502 when the service does not', async () => {
    expect((await request(drawbridge('http://127.0.0.1:1')).get('/memepool/api/v1/config')).status).toBe(502);
});

// An image is sent as bytes of no stated kind, which is the one body the node
// reads whole and passes on as it came.
it('passes on the bytes of an image as they were sent', async () => {
    let received: { type?: string; bytes?: Buffer } = {};
    const upstream = await listen(express().post('/api/v1/images', express.raw({ type: 'application/octet-stream', limit: '10mb' }), (req, res) => {
        received = { type: req.headers['content-type'], bytes: req.body as Buffer };
        res.json({ did: 'did:cid:image' });
    }));
    const url = 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port;
    // Every byte there is, so that none is lost to being read as text.
    const image = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
    const node = express()
        .use(express.json({ limit: '10mb' }))
        .use(express.raw({ type: 'application/octet-stream', limit: '10mb' }))
        .use('/memepool', memepoolProxy({ memepoolURL: url }));

    try {
        const response = await request(node).post('/memepool/api/v1/images').set('Content-Type', 'application/octet-stream').send(image);

        expect(response.status).toBe(200);
        expect(response.body).toStrictEqual({ did: 'did:cid:image' });
        expect(received.type).toBe('application/octet-stream');
        expect(Buffer.compare(received.bytes!, image)).toBe(0);
    }
    finally {
        await new Promise(resolve => upstream.close(resolve));
    }
});
