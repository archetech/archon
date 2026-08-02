import { jest } from '@jest/globals';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

// config.ts reads the environment at module-evaluation time, so these must be set
// before the dynamic import below. They live in their own file because the main
// routes suite needs them UNSET — a webhook secret would otherwise have to be
// threaded through every inbound-email test, and TOR_PROXY would change the
// LNURLp fetch path for all of them.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-env-'));
process.env.ARCHON_HERALD_JWT_KEY_PATH = path.join(tmpDir, 'oauth-signing-key.json');
process.env.ARCHON_HERALD_DOMAIN = 'archon.test';
process.env.ARCHON_HERALD_NAME = 'name-service';
process.env.ARCHON_HERALD_WEBHOOK_SECRET = 'hook-secret';
process.env.ARCHON_HERALD_TOR_PROXY = 'tor-host:9150';

let createHeraldRoutes: any;
let logSpy: any;
let warnSpy: any;
let errorSpy: any;

beforeAll(async () => {
    ({ createHeraldRoutes } = await import('../../services/herald/server/src/routes'));
});

beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    jest.restoreAllMocks();
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createDb(users: Record<string, any> = {}) {
    return {
        getUser: jest.fn<any>(async (did: string) => users[did] ?? null),
        setUser: jest.fn<any>(async () => {}),
        deleteUser: jest.fn<any>(async () => true),
        listUsers: jest.fn<any>(async () => users),
        findDidByName: jest.fn<any>(async (name: string) =>
            Object.entries(users).find(([, u]: any) => u.name === name)?.[0] ?? null),
        setReplyToken: jest.fn<any>(), getReplyToken: jest.fn<any>(),
        deleteExpiredReplyTokens: jest.fn<any>(async () => 0),
        setEmailMapping: jest.fn<any>(), getEmailMapping: jest.fn<any>(),
    };
}

function mount(overrides: { db?: any; keymaster?: any; emailBridge?: any } = {}) {
    const ctx: any = {
        keymaster: overrides.keymaster ?? {},
        db: overrides.db ?? createDb(),
        emailBridge: overrides.emailBridge ?? null,
        serviceDID: 'did:cid:service',
    };

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req: any, _res, next) => {
        req.session = { destroy: (cb: any) => cb?.() };
        next();
    });
    const { router } = createHeraldRoutes(ctx);
    app.use(router);

    return { app, ctx };
}

describe('inbound email webhook secret', () => {
    function bridge() {
        return {
            isConfigured: jest.fn<any>().mockReturnValue(true),
            parseInboundEmail: jest.fn<any>((body: any) =>
                body.from && body.to ? { ...body, subject: body.subject ?? '', text: body.text ?? '' } : null),
            extractReplyToken: jest.fn<any>().mockReturnValue(null),
            extractEmailAddress: jest.fn<any>((v: string) => v),
            extractRecipientName: jest.fn<any>().mockReturnValue(null),
            lookupToken: jest.fn<any>().mockResolvedValue(null),
            storeEmailMapping: jest.fn<any>().mockResolvedValue(undefined),
        };
    }

    it('rejects a request with no secret when one is configured', async () => {
        const { app } = mount({ emailBridge: bridge() });

        const response = await request(app)
            .post('/api/inbound-email')
            .send({ from: 'a@b.com', to: 'alice@archon.test' });

        expect(response.status).toBe(401);
        expect(response.body).toEqual({ error: 'Unauthorized' });
    });

    it('rejects a request whose secret does not match', async () => {
        const { app } = mount({ emailBridge: bridge() });

        const response = await request(app)
            .post('/api/inbound-email?secret=wrong')
            .send({ from: 'a@b.com', to: 'alice@archon.test' });

        expect(response.status).toBe(401);
    });

    it('accepts a request carrying the configured secret', async () => {
        const { app } = mount({ emailBridge: bridge() });

        const response = await request(app)
            .post('/api/inbound-email?secret=hook-secret')
            .send({ from: 'a@b.com', to: 'postmaster@archon.test' });

        // Past the gate: it reaches the recipient resolution and ignores the mail.
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true, action: 'no-recipient-ignored' });
    });

    it('checks the secret before parsing the body', async () => {
        const eb = bridge();
        const { app } = mount({ emailBridge: eb });

        await request(app).post('/api/inbound-email').send({ nonsense: true });

        // An unauthenticated caller must not reach the parser at all.
        expect(eb.parseInboundEmail).not.toHaveBeenCalled();
    });
});

describe('LNURLp callback over Tor', () => {
    const originalFetch = global.fetch;

    afterEach(() => { global.fetch = originalFetch; });

    function withEndpoint(endpoint: string) {
        const db = createDb({ 'did:cid:alice': { name: 'alice' } });
        return mount({
            db,
            keymaster: {
                resolveDID: jest.fn<any>().mockResolvedValue({
                    didDocument: { service: [{ type: 'Lightning', serviceEndpoint: endpoint }] },
                }),
            },
        });
    }

    it('routes an .onion endpoint through the configured SOCKS proxy', async () => {
        const { app } = withEndpoint('http://abcd.onion/invoice');
        const fetchMock = jest.fn<any>().mockResolvedValue({ ok: true, json: async () => ({ pr: 'lnbc1' }) });
        global.fetch = fetchMock as any;

        const response = await request(app).get('/api/lnurlp/alice/callback?amount=100000');

        expect(response.body).toMatchObject({ pr: 'lnbc1' });
        // A dispatcher is attached only for .onion destinations.
        expect(fetchMock.mock.calls[0][1].dispatcher).toBeDefined();
    });

    it('does not attach a proxy dispatcher for a clearnet endpoint', async () => {
        const { app } = withEndpoint('https://ln.test/invoice');
        const fetchMock = jest.fn<any>().mockResolvedValue({ ok: true, json: async () => ({ pr: 'lnbc2' }) });
        global.fetch = fetchMock as any;

        await request(app).get('/api/lnurlp/alice/callback?amount=100000');

        expect(fetchMock.mock.calls[0][1].dispatcher).toBeUndefined();
    });
});
