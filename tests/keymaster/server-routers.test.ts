import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { InvalidParameterError, UnknownIDError } from '@didcid/common/errors';

import { createAddressRouter } from '../../services/keymaster/server/src/keymaster-address-router.ts';
import { createAgentRouter } from '../../services/keymaster/server/src/keymaster-agent-router.ts';
import { createAssetRouter } from '../../services/keymaster/server/src/keymaster-asset-router.ts';
import { createChallengeRouter } from '../../services/keymaster/server/src/keymaster-challenge-router.ts';
import { createCoreRouter } from '../../services/keymaster/server/src/keymaster-core-router.ts';
import { createCredentialRouter } from '../../services/keymaster/server/src/keymaster-credential-router.ts';
import { createDidCommRouter } from '../../services/keymaster/server/src/keymaster-didcomm-router.ts';
import { createDmailRouter } from '../../services/keymaster/server/src/keymaster-dmail-router.ts';
import { createFileRouter } from '../../services/keymaster/server/src/keymaster-file-router.ts';
import { createGroupRouter } from '../../services/keymaster/server/src/keymaster-group-router.ts';
import { createIdentityRouter } from '../../services/keymaster/server/src/keymaster-identity-router.ts';
import { createImageRouter } from '../../services/keymaster/server/src/keymaster-image-router.ts';
import { createKeyRouter } from '../../services/keymaster/server/src/keymaster-key-router.ts';
import { createLightningRouter } from '../../services/keymaster/server/src/keymaster-lightning-router.ts';
import { createNostrRouter } from '../../services/keymaster/server/src/keymaster-nostr-router.ts';
import { createNoticeRouter } from '../../services/keymaster/server/src/keymaster-notice-router.ts';
import { createPollRouter } from '../../services/keymaster/server/src/keymaster-poll-router.ts';
import { createPublicRouter } from '../../services/keymaster/server/src/keymaster-public-router.ts';
import { createResponseRouter } from '../../services/keymaster/server/src/keymaster-response-router.ts';
import { createSchemaRouter } from '../../services/keymaster/server/src/keymaster-schema-router.ts';
import { createSchemaTemplateRouter } from '../../services/keymaster/server/src/keymaster-schema-template-router.ts';
import { createVaultRouter } from '../../services/keymaster/server/src/keymaster-vault-router.ts';
import { checkAdminApiKey, checkPassphrase, createRequireAdminKey, wrongPassphraseAdvice, MIN_ADMIN_API_KEY_LENGTH } from '../../services/keymaster/server/src/keymaster-admin.ts';
import defaultConfig from '../../services/keymaster/server/src/config.js';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const adminKey = 'test-admin-key';

const baseConfig = {
    ...defaultConfig,
    adminApiKey: adminKey,
    keymasterPassphrase: '',
};

// Every Keymaster method is a jest.fn created on first access, so the routers can
// call anything without the test having to enumerate ~150 method names. `mode`
// flips the whole surface between resolving and rejecting.
function createMockKeymaster(mode: { reject: boolean }) {
    const methods = new Map<string, any>();
    return new Proxy({} as any, {
        get(_target, prop: string) {
            if (!methods.has(prop)) {
                methods.set(prop, jest.fn(() => mode.reject
                    ? Promise.reject(new InvalidParameterError(`boom:${prop}`))
                    : Promise.resolve({ ok: true, name: prop })));
            }
            return methods.get(prop);
        },
        has: () => true,
    });
}

function mount(configOverrides: Record<string, unknown> = {}) {
    const mode = { reject: false };
    const keymaster = createMockKeymaster(mode);
    const gatekeeper = createMockKeymaster(mode);
    const config = { ...baseConfig, ...configOverrides };

    const options = {
        getKeymaster: () => keymaster,
        getGatekeeper: () => gatekeeper,
        config: config as any,
        walletOperationsTotal: { inc: jest.fn() } as any,
        didNotFound: { error: 'DID not found' },
        isReady: () => true,
        getServiceVersion: () => '9.9.9',
        serviceCommit: 'abc1234',
    };

    const app = express();
    app.use(express.json());
    for (const create of [
        createPublicRouter, createCoreRouter, createIdentityRouter, createAddressRouter,
        createDidCommRouter, createNostrRouter, createLightningRouter, createChallengeRouter,
        createResponseRouter, createGroupRouter, createSchemaRouter, createSchemaTemplateRouter,
        createAgentRouter, createCredentialRouter, createKeyRouter, createAssetRouter,
        createPollRouter, createImageRouter, createFileRouter, createVaultRouter,
        createDmailRouter, createNoticeRouter,
    ]) {
        app.use(create(options as any));
    }

    return { app, keymaster, gatekeeper, mode };
}

function send(app: express.Express, method: Method, path: string) {
    const agent = request(app);
    const call = method === 'GET' ? agent.get(path)
        : method === 'POST' ? agent.post(path)
            : method === 'PUT' ? agent.put(path)
                : agent.delete(path);
    // Express 5 leaves req.body undefined without a parsed body, which would make
    // handlers that destructure it throw before reaching the code under test.
    return method === 'GET' ? call : call.send({});
}

// [method, path, status the handler's catch block returns]
const ROUTES: Array<[Method, string, number]> = [
    // address
    ['GET', '/addresses', 400],
    ['GET', '/addresses/example.com', 400],
    ['POST', '/addresses/import', 400],
    ['GET', '/addresses/check/addr1', 400],
    ['POST', '/addresses', 400],
    ['POST', '/addresses/publish', 400],
    ['DELETE', '/addresses/publish', 400],
    ['DELETE', '/addresses/addr1', 400],
    // agent
    ['POST', '/agents/test-id/test', 400],
    // asset
    ['POST', '/assets', 400],
    ['GET', '/assets', 400],
    ['GET', '/assets/test-id', 404],
    ['PUT', '/assets/test-id', 400],
    ['POST', '/assets/test-id/transfer', 400],
    ['POST', '/assets/test-id/clone', 400],
    // challenge
    ['GET', '/challenge', 400],
    ['POST', '/challenge', 400],
    // core
    ['GET', '/registries', 400],
    ['GET', '/capabilities', 400],
    ['GET', '/wallet', 400],
    ['PUT', '/wallet', 400],
    ['POST', '/wallet/new', 400],
    ['POST', '/wallet/backup', 400],
    ['POST', '/wallet/recover', 400],
    ['POST', '/wallet/check', 400],
    ['POST', '/wallet/fix', 400],
    ['GET', '/wallet/mnemonic', 400],
    ['POST', '/wallet/passphrase', 400],
    ['GET', '/export/wallet/encrypted', 400],
    // credential
    ['POST', '/credentials/bind', 400],
    ['GET', '/credentials/held', 400],
    ['POST', '/credentials/held', 400],
    ['GET', '/credentials/held/didcid1:abc', 400],
    ['DELETE', '/credentials/held/didcid1:abc', 400],
    ['POST', '/credentials/held/didcid1:abc/publish', 400],
    ['POST', '/credentials/held/didcid1:abc/unpublish', 400],
    ['GET', '/credentials/issued', 400],
    ['POST', '/credentials/issued', 400],
    ['GET', '/credentials/issued/didcid1:abc', 400],
    ['POST', '/credentials/issued/didcid1:abc/send', 400],
    ['POST', '/credentials/issued/didcid1:abc', 400],
    ['DELETE', '/credentials/issued/didcid1:abc', 400],
    // didcomm
    ['POST', '/didcomm/publish', 400],
    ['DELETE', '/didcomm/publish', 400],
    ['POST', '/didcomm/pack', 400],
    ['POST', '/didcomm/unpack', 400],
    ['POST', '/didcomm/send', 400],
    ['POST', '/didcomm/receive', 400],
    ['POST', '/didcomm/ack', 400],
    ['POST', '/didcomm/mediate', 400],
    ['POST', '/didcomm/credential/send', 400],
    ['POST', '/didcomm/credential/accept', 400],
    // dmail
    ['GET', '/dmail', 400],
    ['POST', '/dmail', 400],
    ['POST', '/dmail/import', 400],
    ['GET', '/dmail/test-id', 404],
    ['PUT', '/dmail/test-id', 400],
    ['DELETE', '/dmail/test-id', 400],
    ['POST', '/dmail/test-id/send', 400],
    ['POST', '/dmail/test-id/file', 400],
    ['GET', '/dmail/test-id/attachments', 400],
    ['POST', '/dmail/test-id/attachments', 400],
    ['DELETE', '/dmail/test-id/attachments/item', 400],
    ['GET', '/dmail/test-id/attachments/item', 400],
    // file
    ['POST', '/files', 400],
    ['PUT', '/files/test-id', 400],
    ['GET', '/files/test-id', 400],
    ['POST', '/files/test-id/test', 400],
    ['GET', '/ipfs/data/cid1', 400],
    // group
    ['GET', '/groups', 400],
    ['POST', '/groups', 400],
    ['GET', '/groups/item', 404],
    ['POST', '/groups/item/add', 400],
    ['POST', '/groups/item/remove', 400],
    ['POST', '/groups/item/test', 400],
    // identity
    ['GET', '/did/test-id', 404],
    ['DELETE', '/did/test-id', 400],
    ['PUT', '/did/test-id', 400],
    ['GET', '/ids/current', 400],
    ['PUT', '/ids/current', 400],
    ['GET', '/ids', 400],
    ['POST', '/ids', 400],
    ['GET', '/ids/test-id', 404],
    ['DELETE', '/ids/test-id', 400],
    ['POST', '/ids/test-id/rename', 400],
    ['POST', '/ids/test-id/change-registry', 400],
    ['POST', '/ids/test-id/backup', 400],
    ['POST', '/ids/test-id/recover', 400],
    ['GET', '/aliases', 400],
    ['POST', '/aliases', 400],
    ['GET', '/aliases/ally', 404],
    ['DELETE', '/aliases/ally', 400],
    // image
    ['POST', '/images', 400],
    ['PUT', '/images/test-id', 400],
    ['GET', '/images/test-id', 400],
    ['POST', '/images/test-id/test', 400],
    // key
    ['POST', '/keys/rotate', 400],
    ['POST', '/keys/assertion', 400],
    ['DELETE', '/keys/assertion', 400],
    ['POST', '/keys/encrypt/message', 400],
    ['POST', '/keys/decrypt/message', 400],
    ['POST', '/keys/encrypt/json', 400],
    ['POST', '/keys/decrypt/json', 400],
    ['POST', '/keys/sign', 500],
    ['POST', '/keys/verify', 400],
    // lightning
    ['POST', '/lightning', 400],
    ['DELETE', '/lightning', 400],
    ['POST', '/lightning/balance', 400],
    ['POST', '/lightning/invoice', 400],
    ['POST', '/lightning/pay', 400],
    ['POST', '/lightning/payment', 400],
    ['POST', '/lightning/decode', 400],
    ['POST', '/lightning/publish', 400],
    ['POST', '/lightning/unpublish', 400],
    ['POST', '/lightning/zap', 400],
    ['POST', '/lightning/payments', 400],
    // nostr
    ['POST', '/nostr', 400],
    ['DELETE', '/nostr', 400],
    ['POST', '/nostr/import', 400],
    ['POST', '/nostr/nsec', 400],
    ['POST', '/nostr/sign', 400],
    // notice
    ['POST', '/notices', 400],
    ['PUT', '/notices/test-id', 400],
    ['POST', '/notices/refresh', 400],
    // poll
    ['GET', '/templates/poll', 400],
    ['GET', '/polls', 400],
    ['POST', '/polls', 400],
    ['POST', '/polls/ballot/send', 400],
    ['GET', '/polls/ballot/didcid1:abc', 400],
    ['GET', '/polls/poll-1', 400],
    ['GET', '/polls/poll-1/test', 400],
    ['GET', '/polls/poll-1/view', 400],
    ['POST', '/polls/poll-1/send', 400],
    ['POST', '/polls/poll-1/vote', 400],
    ['PUT', '/polls/update', 400],
    ['POST', '/polls/poll-1/publish', 400],
    ['POST', '/polls/poll-1/unpublish', 400],
    ['POST', '/polls/poll-1/voters', 400],
    ['DELETE', '/polls/poll-1/voters/did:cid:voter', 400],
    ['GET', '/polls/poll-1/voters', 400],
    // public — /ready and /version are covered separately; they never call Keymaster
    // response
    ['POST', '/response', 400],
    ['POST', '/response/verify', 400],
    // schema
    ['GET', '/schemas', 400],
    ['POST', '/schemas', 400],
    ['GET', '/schemas/test-id', 404],
    ['PUT', '/schemas/test-id', 400],
    ['POST', '/schemas/test-id/test', 400],
    // schema-template
    ['POST', '/schemas/test-id/template', 400],
    // vault
    ['POST', '/vaults', 400],
    ['GET', '/vaults/test-id', 400],
    ['POST', '/vaults/test-id/test', 400],
    ['POST', '/vaults/test-id/members', 400],
    ['DELETE', '/vaults/test-id/members/did:cid:member', 400],
    ['GET', '/vaults/test-id/members', 400],
    ['POST', '/vaults/test-id/items', 400],
    ['DELETE', '/vaults/test-id/items/item', 400],
    ['GET', '/vaults/test-id/items', 400],
    ['GET', '/vaults/test-id/items/item', 400],
];

describe('keymaster server routers', () => {
    it('mounts every route and reaches its handler', async () => {
        const { app } = mount();
        const notFound: string[] = [];

        for (const [method, path] of ROUTES) {
            const response = await send(app, method, path);
            if (response.status === 404 && typeof response.text === 'string'
                && response.text.includes('Cannot')) {
                notFound.push(`${method} ${path}`);
            }
        }

        expect(notFound).toEqual([]);
    });

    // The ROUTES table is hand-maintained, so a new endpoint is silently
    // untested if nobody remembers to add it. Walk what is actually mounted and
    // insist every route is represented.
    it('has a ROUTES entry for every mounted route', async () => {
        const { app } = mount();
        const root = (app as any).router ?? (app as any)._router;
        const mounted: string[] = [];

        for (const layer of root.stack) {
            for (const sub of layer.handle?.stack || []) {
                if (!sub.route) {
                    continue;
                }
                for (const method of Object.keys(sub.route.methods)) {
                    mounted.push(`${method.toUpperCase()} ${sub.route.path}`);
                }
            }
        }

        // The public router is not Keymaster-backed, so the "failing Keymaster
        // maps to this status" table does not apply to it. Those routes have
        // their own tests in the 'keymaster public router' block below.
        const publicRoutes = ['GET /ready', 'GET /version', 'POST /login'];

        const covered = (entry: string) => {
            if (publicRoutes.includes(entry)) {
                return true;
            }

            const [method, pattern] = entry.split(' ');
            const regex = new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`);
            return ROUTES.some(([m, p]) => m === method && regex.test(p));
        };

        expect(mounted.length).toBeGreaterThan(0);
        expect(mounted.filter(entry => !covered(entry))).toEqual([]);
    });

    it('maps a failing Keymaster to each route documented error status', async () => {
        const { app, mode } = mount();
        mode.reject = true;
        const mismatches: string[] = [];

        for (const [method, path, expected] of ROUTES) {
            const response = await send(app, method, path);
            if (response.status !== expected) {
                mismatches.push(`${method} ${path} -> ${response.status}, expected ${expected}`);
            }
        }

        expect(mismatches).toEqual([]);
    });

    // The documented-status test rejects everything with one type; this proves a
    // route passes the *actual* thrown error to the classifier rather than
    // hardcoding a status. POST /ids (createId) is an ordinary error-catch route.
    it('maps the thrown error type through the classifier, not a fixed status', async () => {
        const { app, keymaster } = mount();

        keymaster.createId.mockRejectedValueOnce(new UnknownIDError('nope'));
        expect((await send(app, 'POST', '/ids')).status).toBe(404);

        keymaster.createId.mockRejectedValueOnce(new InvalidParameterError('bad'));
        expect((await send(app, 'POST', '/ids')).status).toBe(400);

        keymaster.createId.mockRejectedValueOnce(new Error('boom'));
        expect((await send(app, 'POST', '/ids')).status).toBe(500);
    });
});

describe('keymaster binary asset downloads', () => {
    const octet = 'application/octet-stream';

    it('streams image bytes with metadata headers when octet-stream is requested', async () => {
        const { app, keymaster } = mount();
        keymaster.getImage.mockResolvedValue({
            file: { data: Buffer.from('png-bytes'), type: 'image/png', bytes: 9 },
            image: { width: 1, height: 2 },
        });

        const binary = await request(app).get('/images/test-id').set('Accept', octet);
        expect(binary.status).toBe(200);
        expect(binary.headers['content-type']).toContain(octet);
        expect(JSON.parse(binary.headers['x-metadata'])).toEqual({
            file: { type: 'image/png', bytes: 9 },
            image: { width: 1, height: 2 },
        });

        // The default (JSON) branch returns the whole asset instead.
        const json = await request(app).get('/images/test-id');
        expect(json.status).toBe(200);
        expect(json.body.image).toEqual({ width: 1, height: 2 });
    });

    it('answers 404 for an image with no byte payload', async () => {
        const { app, keymaster } = mount();
        keymaster.getImage.mockResolvedValue({ image: { width: 1 } });

        const response = await request(app).get('/images/test-id').set('Accept', octet);
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'Image not found' });
    });

    it('streams file bytes with metadata headers when octet-stream is requested', async () => {
        const { app, keymaster } = mount();
        keymaster.getFile.mockResolvedValue({
            data: Buffer.from('raw-bytes'),
            type: 'text/plain',
            bytes: 9,
        });

        const binary = await request(app).get('/files/test-id').set('Accept', octet);
        expect(binary.status).toBe(200);
        expect(JSON.parse(binary.headers['x-metadata'])).toEqual({ type: 'text/plain', bytes: 9 });

        const json = await request(app).get('/files/test-id');
        expect(json.status).toBe(200);
        expect(json.body.file.type).toBe('text/plain');
    });

    it('answers 404 for a file with no byte payload', async () => {
        const { app, keymaster } = mount();
        keymaster.getFile.mockResolvedValue({ type: 'text/plain' });

        const response = await request(app).get('/files/test-id').set('Accept', octet);
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'File not found' });
    });
});

describe('keymaster key signing', () => {
    it('parses the request contents before adding a proof', async () => {
        const { app, keymaster } = mount();
        keymaster.addProof.mockResolvedValue({ proof: 'sig' });

        const response = await request(app)
            .post('/keys/sign')
            .send({ contents: JSON.stringify({ hello: 'world' }) });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ signed: { proof: 'sig' } });
        expect(keymaster.addProof).toHaveBeenCalledWith({ hello: 'world' });
    });

    it('reports unparsable contents as 500', async () => {
        const { app } = mount();

        const response = await request(app).post('/keys/sign').send({ contents: 'not-json' });
        expect(response.status).toBe(500);
    });
});

describe('keymaster identity recovery', () => {
    it('answers 404 only when recovery fails with a DID-not-found error', async () => {
        const { app, keymaster } = mount();

        keymaster.recoverId.mockRejectedValue({ error: 'DID not found' });
        const missing = await request(app).post('/ids/test-id/recover').send({});
        expect(missing.status).toBe(404);

        keymaster.recoverId.mockRejectedValue(new Error('something else'));
        const other = await request(app).post('/ids/test-id/recover').send({});
        expect(other.status).toBe(500);

        keymaster.recoverId.mockResolvedValue('did:cid:recovered');
        const ok = await request(app).post('/ids/test-id/recover').send({});
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ recovered: 'did:cid:recovered' });
    });
});

describe('keymaster public router', () => {
    it('reports the service version and commit', async () => {
        const { app } = mount();

        const response = await request(app).get('/version');
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ version: '9.9.9', commit: 'abc1234' });
    });

    // #1018: this used to return the admin key to any unauthenticated caller.
    // /login is mounted ahead of the admin guard because it is how a client
    // obtains the key, so a blank passphrase disclosed it to anyone.
    it('refuses to return the admin key when no passphrase is configured', async () => {
        const { app } = mount();

        const response = await request(app).post('/login').send({});
        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: 'Passphrase not configured' });
    });

    it('requires a matching passphrase when one is configured', async () => {
        const { app } = mount({ keymasterPassphrase: 's3cret' });

        const wrong = await request(app).post('/login').send({ passphrase: 'nope' });
        expect(wrong.status).toBe(401);
        expect(wrong.body).toEqual({ error: 'Incorrect passphrase' });

        const right = await request(app).post('/login').send({ passphrase: 's3cret' });
        expect(right.status).toBe(200);
        expect(right.body).toEqual({ adminApiKey: adminKey });
    });

    it('reports readiness from the injected probe', async () => {
        const { app } = mount();

        const response = await request(app).get('/ready');
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ready: true });
    });

    it('reports a failing readiness probe as 500', async () => {
        const app = express();
        app.use(express.json());
        app.use(createPublicRouter({
            config: baseConfig as any,
            isReady: () => { throw new Error('probe failed'); },
            getServiceVersion: () => '9.9.9',
            serviceCommit: 'abc1234',
        } as any));

        const response = await request(app).get('/ready');
        expect(response.status).toBe(500);
    });
});

describe('keymaster admin key middleware', () => {
    function run(config: Record<string, unknown>, header?: string | string[]) {
        const app = express();
        app.use(express.json());
        app.get('/protected', createRequireAdminKey({ ...baseConfig, ...config } as any), (_req, res) => {
            res.json({ ok: true });
        });
        const call = request(app).get('/protected');
        return header === undefined ? call : call.set('X-Archon-Admin-Key', header as string);
    }

    // #1018: this used to call next(). The guard covers the entire v1 router,
    // so passing through left wallet, identity, credential and Lightning
    // operations open to anyone who could reach the port.
    it('refuses when no admin key is configured', async () => {
        await expect(run({ adminApiKey: '' })).resolves.toMatchObject({ status: 403 });
        await expect(run({ adminApiKey: '' }, adminKey)).resolves.toMatchObject({ status: 403 });
    });

    it('rejects a missing or wrong key', async () => {
        await expect(run({})).resolves.toMatchObject({ status: 401 });
        await expect(run({}, 'wrong')).resolves.toMatchObject({ status: 401 });
    });

    it('accepts the configured key', async () => {
        await expect(run({}, adminKey)).resolves.toMatchObject({ status: 200 });
    });

    // A prefix of the configured key must not be accepted: timingSafeEqual
    // throws on a length mismatch, so the comparison has to check length first.
    it('rejects a key that is a prefix of the configured one', async () => {
        await expect(run({}, adminKey.slice(0, -1))).resolves.toMatchObject({ status: 401 });
    });
});

// Mirrors gatekeeper's checkAdminApiKey, so the two services refuse and warn on
// the same configurations.
describe('keymaster admin key startup check', () => {
    it('is fatal when the key is unset', () => {
        const result = checkAdminApiKey('');

        expect(result.fatal).toContain('ARCHON_ADMIN_API_KEY must be set');
        expect(result.fatal).toContain('openssl rand -hex 32');
        expect(result.warning).toBeUndefined();
    });

    it('warns but does not block startup for a short key', () => {
        const result = checkAdminApiKey('short-key');

        expect(result.fatal).toBeUndefined();
        expect(result.warning).toContain(`shorter than ${MIN_ADMIN_API_KEY_LENGTH}`);
    });

    it('accepts a key at the minimum length with no warning', () => {
        const result = checkAdminApiKey('a'.repeat(MIN_ADMIN_API_KEY_LENGTH));

        expect(result.fatal).toBeUndefined();
        expect(result.warning).toBeUndefined();
    });

    // A blank passphrase made POST /login return the admin key to any caller,
    // and /login is public by design because it is how a client obtains the key.
    it('is fatal when the passphrase is unset', () => {
        const { fatal } = checkPassphrase('');

        expect(fatal).toContain('ARCHON_PASSPHRASE must be set');
        // Someone reading this may have the value under the older name.
        expect(fatal).toContain('ARCHON_ENCRYPTED_PASSPHRASE');
    });

    it('accepts any non-empty passphrase', () => {
        expect(checkPassphrase('correct horse battery staple').fatal).toBeUndefined();
    });

    // Compose resolves ${ARCHON_PASSPHRASE} from an exported shell variable in
    // preference to the same name in .env, so a leftover export displaces a
    // correct file with nothing in either file changed. The wallet then refuses
    // to decrypt and the operator has no trace to follow (#1121).
    it('flags two names holding different values', () => {
        const { fatal, warning } = checkPassphrase('from the shell', false, true);

        expect(fatal).toBeUndefined();
        expect(warning).toContain('different values');
        expect(warning).toContain("env | grep -c '^ARCHON_PASSPHRASE='");
        // The obvious diagnostic prints the secret into scrollback, so it is
        // not what the service tells an operator to run.
        expect(warning).not.toContain('docker compose config');
        expect(warning).toContain('env -u ARCHON_PASSPHRASE');
    });

    it('says nothing when the two names agree', () => {
        expect(checkPassphrase('correct horse battery staple', false, false).warning).toBeUndefined();
    });

    describe('wrongPassphraseAdvice', () => {

        it('names the variable that failed', () => {
            expect(wrongPassphraseAdvice(false, false).join('\n')).toContain('ARCHON_PASSPHRASE');
        });

        it('names the older variable when that is the one in use', () => {
            expect(wrongPassphraseAdvice(false, true)[0]).toContain('ARCHON_ENCRYPTED_PASSPHRASE');
        });

        it('points at the other value when both are set', () => {
            const advice = wrongPassphraseAdvice(true, false).join('\n');

            expect(advice).toContain('ARCHON_ENCRYPTED_PASSPHRASE holds a different value');
        });

        it('always gives the operator a command to run', () => {
            for (const advice of [wrongPassphraseAdvice(true, false), wrongPassphraseAdvice(false, false)]) {
                expect(advice.join('\n')).toContain("env | grep -c '^ARCHON_PASSPHRASE='");
                expect(advice.join('\n')).not.toContain('docker compose config');
            }
        });
    });

    // The old name still works, so the only thing to say is which name to
    // move to -- and it has to start, not stop the service (#1020).
    it('says which name supersedes the old one, without refusing to start', () => {
        const { fatal, warning } = checkPassphrase('correct horse battery staple', true);

        expect(fatal).toBeUndefined();
        expect(warning).toContain('ARCHON_ENCRYPTED_PASSPHRASE');
        expect(warning).toContain('ARCHON_PASSPHRASE');
    });

    it('says nothing when the passphrase came from the current name', () => {
        expect(checkPassphrase('correct horse battery staple', false).warning).toBeUndefined();
    });
});

