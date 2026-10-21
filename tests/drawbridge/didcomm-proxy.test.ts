import { jest } from '@jest/globals';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

import { publicRateLimit } from '../../services/drawbridge/server/src/middleware/public-rate-limit.ts';
import { proxyRequest } from '../../services/drawbridge/server/src/proxy.ts';
import type { DrawbridgeStore, RateLimitResult } from '../../services/drawbridge/server/src/types.ts';
import { createApp } from '../../services/didcomm/server/src/didcomm-api.ts';
import { MemoryMailboxStore } from '../../services/didcomm/server/src/store.ts';

// Drawbridge's DIDComm passthrough as deployed: the public rate limit in front of
// the real proxy, forwarding to a real relay. The proxy rebuilds the URL, which
// resolves dot segments, so a path the limiter reads one way can reach the
// relay as another. These requests go out raw because HTTP clients normalize
// such paths before sending them.

const ENVELOPE = JSON.stringify({
    protected: Buffer.from(JSON.stringify({ enc: 'A256GCM' })).toString('base64url'),
    recipients: [{ header: { kid: 'did:test:bob#key-agreement' } }],
    iv: 'x', ciphertext: 'y', tag: 'z',
});

let relay: Server;
let drawbridge: Server;
let mailbox: MemoryMailboxStore;
let charged: string[];

function countingStore(): DrawbridgeStore {
    const allow = async (key: string): Promise<RateLimitResult> => {
        charged.push(key);
        return { allowed: true, remaining: 1, resetAt: Math.floor(Date.now() / 1000) + 60 };
    };
    return {
        checkAndRecordRequest: jest.fn(allow),
        checkAndRecordCost: jest.fn(allow),
    } as unknown as DrawbridgeStore;
}

async function listen(app: express.Express): Promise<Server> {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    return server;
}

function rawPost(path: string): Promise<number> {
    const { port } = drawbridge.address() as AddressInfo;
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            method: 'POST',
            path,
            headers: { 'Content-Type': 'application/didcomm-encrypted+json' },
        }, res => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end(ENVELOPE);
    });
}

beforeAll(async () => {
    mailbox = new MemoryMailboxStore();
    const relayApp = express();
    relayApp.use(createApp({ store: mailbox, resolver: {} as any, cipher: {} as any }));
    relay = await listen(relayApp);
    const relayURL = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;

    // Drawbridge's parsers and DIDComm mount, as in drawbridge-api.ts.
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(express.text({ type: 'application/didcomm-encrypted+json', limit: '10mb' }));
    app.use('/didcomm', publicRateLimit({
        store: countingStore(),
        name: 'didcomm',
        readPerSourceMax: 300,
        readGlobalMax: 3000,
        depositPerSourceBytes: 16_000_000,
        depositGlobalBytes: 64_000_000,
        windowSeconds: 60,
    }), (req, res) => { void proxyRequest(req, res, relayURL, '/didcomm'); });
    drawbridge = await listen(app);
});

afterAll(async () => {
    await new Promise(resolve => drawbridge.close(resolve));
    await new Promise(resolve => relay.close(resolve));
});

beforeEach(async () => {
    charged = [];
    await mailbox.remove('did:test:bob', (await mailbox.list('did:test:bob')).map(m => m.id));
});

describe('DIDComm passthrough deposit budget', () => {
    it.each([
        '/didcomm',
        '/didcomm/%2e',
        '/didcomm/x/%2e%2e/',
        '/didcomm/api/v1/messages',
        '/didcomm/api/v1/messages/%2e',
        '/didcomm/api/v1/messages/x/%2E%2E',
    ])('charges a stored envelope at %s to the deposit budget', async (path) => {
        expect(await rawPost(path)).toBe(200);

        expect(await mailbox.list('did:test:bob')).toHaveLength(1);
        expect(charged).toEqual(['didcomm:deposit:global']);
    });
});
