import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import request from 'supertest';

import { memeplexProxy } from '../../services/drawbridge/server/src/memeplex-proxy.ts';

// Drawbridge's public mount of the node's Memeplex indexer.

let indexer: Server;
let indexerURL: string;
let asked: string[];

function listen(app: express.Express): Promise<Server> {
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

// The mount as drawbridge-api.ts makes it, without its rate limiter.
const drawbridge = (url: string) => express().use('/memeplex', memeplexProxy({ indexerURL: url }));

beforeAll(async () => {
    const app = express();

    app.use((req, res) => {
        asked.push(`${req.method} ${req.originalUrl}`);
        res.json({ served: req.originalUrl });
    });
    indexer = await listen(app);
    indexerURL = `http://127.0.0.1:${(indexer.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise(resolve => indexer.close(resolve));
});

beforeEach(() => {
    asked = [];
});

it('forwards a read to the indexer\'s API with the prefix stripped', async () => {
    const response = await request(drawbridge(indexerURL)).get('/memeplex/api/v1/timeline?author=did:cid:a&limit=5');

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ served: '/api/v1/timeline?author=did:cid:a&limit=5' });
    expect(asked).toStrictEqual(['GET /api/v1/timeline?author=did:cid:a&limit=5']);
});

it.each([
    '/memeplex/metrics',
    '/memeplex',
    '/memeplex/',
    '/memeplex/api/v1/../../metrics',
    '/memeplex/api/v1/%2e%2e/%2e%2e/metrics',
    '/memeplex/api/v10/ready',
    '/memeplex//attacker.example/api/v1/ready',
])('refuses %s, which is not under the indexer\'s API', async path => {
    const response = await request(drawbridge(indexerURL)).get(path);

    expect([path, response.status]).toStrictEqual([path, 400]);
    expect(asked).toStrictEqual([]);
});

it.each(['post', 'put', 'patch', 'delete'] as const)('refuses a %s: the index is read-only', async method => {
    const response = await request(drawbridge(indexerURL))[method]('/memeplex/api/v1/timeline').send({});

    expect(response.status).toBe(405);
    expect(asked).toStrictEqual([]);
});

it('answers 501 on a node that runs no indexer', async () => {
    const response = await request(drawbridge('')).get('/memeplex/api/v1/ready');

    expect(response.status).toBe(501);
    expect(response.body).toStrictEqual({ error: 'Memeplex is not enabled on this node' });
});

it('answers 502 when the indexer cannot be reached', async () => {
    const response = await request(drawbridge('http://127.0.0.1:1')).get('/memeplex/api/v1/ready');

    expect(response.status).toBe(502);
});
