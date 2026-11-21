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
import { memepoolProxy } from '../../services/drawbridge/server/src/memepool-proxy.ts';

// Drawbridge's public mount of the node's Memepool service, with the real
// service behind it: a user signs in and stays signed in through the mount.

let memepool: Server;
let memepoolURL: string;
let wallet: Keymaster;
let walletDid: string;
let serviceDid: string;

function listen(app: express.Express): Promise<Server> {
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

// The mount as drawbridge-api.ts makes it, after its body parser and without
// its rate limiter, beside another route of the node's.
const drawbridge = (url = memepoolURL) => express()
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
    memepool = await listen(createMemepoolApp({
        client: new MemeplexClient({ keymaster: service.keymaster, gatekeeper, identity: 'memepool' }),
        keymaster: service.keymaster,
        name: 'Memepool',
        version: { version: 'test', commit: 'test' },
    }));
    memepoolURL = `http://127.0.0.1:${(memepool.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise(resolve => memepool.close(resolve));
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

it.each([
    '/memepool/metrics',
    '/memepool',
    '/memepool/',
    '/memepool/api/v1/../../metrics',
    '/memepool/api/v1/%2e%2e/%2e%2e/metrics',
    '/memepool/api/v10/ready',
    '/memepool//attacker.example/api/v1/ready',
])('refuses %s, which is not under the service\'s API', async path => {
    expect((await request(drawbridge()).get(path)).status).toBe(400);
});

it.each(['patch', 'options'] as const)('refuses %s', async method => {
    expect((await request(drawbridge())[method]('/memepool/api/v1/me')).status).toBe(405);
});

it('says the service is not enabled on a node that runs none', async () => {
    const response = await request(drawbridge('')).get('/memepool/api/v1/config');

    expect(response.status).toBe(501);
    expect(response.body).toStrictEqual({ error: 'Memepool is not enabled on this node' });
});

it('answers 502 when the service does not', async () => {
    expect((await request(drawbridge('http://127.0.0.1:1')).get('/memepool/api/v1/config')).status).toBe(502);
});
