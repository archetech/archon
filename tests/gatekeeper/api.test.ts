import express from 'express';
import request from 'supertest';
import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import HeliaClient from '@didcid/ipfs/helia';
import TestHelper from './helper.ts';
import { InvalidOperationError } from '@didcid/common/errors';
import { createIdentifiersRouter } from '../../services/gatekeeper/server/src/identifiers-router';

const mockConsole = {
    log: (): void => { },
    error: (): void => { },
    time: (): void => { },
    timeEnd: (): void => { },
} as unknown as typeof console;

const mockLogger = { error: (): void => { } };

const cipher = new CipherNode();
const db = new DbJsonMemory('test');
const ipfs = new HeliaClient();
const gatekeeper = new Gatekeeper({ db, ipfs, console: mockConsole, registries: ['local'] });
const helper = new TestHelper(gatekeeper, cipher);

// Mount only the conformant surface against an in-memory Gatekeeper — no server/DB bootstrap.
const app = express();
app.use('/1.0/identifiers', createIdentifiersRouter(gatekeeper, mockLogger));

// A syntactically valid CIDv1 DID that is never created here — resolves to notFound.
const MISSING_DID = 'did:cid:bafkreiawdmk6fmqc5p237vffyctazpzdgvgqfdj2i3hx2idtodxkwhyj5m';

let agentDid: string;
let assetDid: string;

beforeAll(async () => {
    await ipfs.start();
    await gatekeeper.resetDb();

    const keypair = cipher.generateRandomJwk();
    agentDid = await gatekeeper.createDID(await helper.createAgentOp(keypair));
    assetDid = await gatekeeper.createDID(
        await helper.createAssetOp(agentDid, keypair, { data: { hello: 'world' } })
    );
});

afterAll(async () => {
    await ipfs.stop();
});

describe('GET /1.0/identifiers/:did (conformant resolution)', () => {
    it('returns only the DID Resolution triple for an agent', async () => {
        const res = await request(app).get(`/1.0/identifiers/${agentDid}`);

        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual([
            'didDocument',
            'didDocumentMetadata',
            'didResolutionMetadata',
        ]);
        // The non-standard members MUST NOT appear in the resolution result.
        expect(res.body.didDocumentData).toBeUndefined();
        expect(res.body.didDocumentRegistration).toBeUndefined();
        expect(res.body.didDocument.id).toBe(agentDid);
        expect(res.body.didDocumentMetadata.confirmed).toBe(true);
        expect(res.body.didResolutionMetadata.contentType).toBe('application/did+ld+json');
        expect(res.body.didResolutionMetadata.retrieved).toBeUndefined();
    });

    it('honors DID JSON and JSON-LD Accept headers in successful resolution metadata', async () => {
        const jsonLd = await request(app)
            .get(`/1.0/identifiers/${agentDid}`)
            .set('Accept', 'application/did+ld+json');

        expect(jsonLd.status).toBe(200);
        expect(jsonLd.headers['content-type']).toBe('application/did+ld+json');
        expect(jsonLd.body.didResolutionMetadata.contentType).toBe('application/did+ld+json');
        expect(jsonLd.body.didResolutionMetadata.retrieved).toBeUndefined();

        const didJson = await request(app)
            .get(`/1.0/identifiers/${agentDid}`)
            .set('Accept', 'application/did+json');

        expect(didJson.status).toBe(200);
        expect(didJson.headers['content-type']).toBe('application/did+json');
        expect(didJson.body.didResolutionMetadata.contentType).toBe('application/did+json');
        expect(didJson.body.didResolutionMetadata.retrieved).toBeUndefined();
    });

    it('resolves an asset to the triple only (no inline data/registration)', async () => {
        const res = await request(app).get(`/1.0/identifiers/${assetDid}`);

        expect(res.status).toBe(200);
        expect(res.body.didDocument.controller).toBe(agentDid);
        expect(res.body.didDocumentData).toBeUndefined();
        expect(res.body.didDocumentRegistration).toBeUndefined();
    });

    it('honors the versionTime and versionSequence selectors', async () => {
        const versionTime = encodeURIComponent(new Date().toISOString());
        const res = await request(app)
            .get(`/1.0/identifiers/${agentDid}?versionSequence=1&versionTime=${versionTime}`);

        expect(res.status).toBe(200);
        expect(res.body.didDocumentMetadata.versionSequence).toBe('1');
    });

    it('returns 400 invalidDid in didResolutionMetadata for a malformed DID', async () => {
        const res = await request(app).get('/1.0/identifiers/notadid');

        expect(res.status).toBe(400);
        expect(res.body.didDocument).toBeNull();
        expect(res.body.didResolutionMetadata.error).toBe('invalidDid');
        expect(res.body.didDocumentMetadata).toEqual({});
    });

    it('returns 404 notFound in didResolutionMetadata for an unknown DID', async () => {
        const res = await request(app).get(`/1.0/identifiers/${MISSING_DID}`);

        expect(res.status).toBe(404);
        expect(res.body.didDocument).toBeNull();
        expect(res.body.didResolutionMetadata.error).toBe('notFound');
    });
});

describe('GET /1.0/identifiers/:did/data (dereference)', () => {
    it('returns an empty object for an agent DID', async () => {
        const res = await request(app).get(`/1.0/identifiers/${agentDid}/data`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({});
    });

    it('returns the attached payload for an asset DID', async () => {
        const res = await request(app).get(`/1.0/identifiers/${assetDid}/data`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ hello: 'world' });
    });

    it('returns 404 { error: notFound } for an unknown DID', async () => {
        const res = await request(app).get(`/1.0/identifiers/${MISSING_DID}/data`);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'notFound' });
    });

    it('returns 400 { error: invalidDid } for a malformed DID', async () => {
        const res = await request(app).get('/1.0/identifiers/notadid/data');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'invalidDid' });
    });
});

describe('GET /1.0/identifiers/:did/registration (dereference)', () => {
    it('returns the registration/provenance resource for an agent DID', async () => {
        const res = await request(app).get(`/1.0/identifiers/${agentDid}/registration`);

        expect(res.status).toBe(200);
        expect(res.body.type).toBe('agent');
        expect(res.body.registry).toBe('local');
        expect(res.body.version).toBe(1);
    });

    it('returns 404 { error: notFound } for an unknown DID', async () => {
        const res = await request(app).get(`/1.0/identifiers/${MISSING_DID}/registration`);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'notFound' });
    });
});

describe('unsupported /1.0/identifiers paths', () => {
    it('returns a structured 404 { error: notFound } (not framework HTML)', async () => {
        const res = await request(app).get(`/1.0/identifiers/${agentDid}/bogus`);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'notFound' });
    });
});

describe('thrown-error classification', () => {
    // resolveConformant() returns invalidDid/notFound in metadata; a *thrown* error only comes
    // from the resolver itself. Drive both classes with stub Gatekeepers.
    function mount(resolveDID: () => Promise<unknown>): express.Express {
        const stubApp = express();
        stubApp.use('/1.0/identifiers', createIdentifiersRouter({ resolveDID } as any, mockLogger));
        return stubApp;
    }

    it('maps an unexpected throw to 500 internalError on resolve (triple-shaped)', async () => {
        const res = await request(mount(async () => { throw new Error('boom'); }))
            .get(`/1.0/identifiers/${agentDid}`);

        expect(res.status).toBe(500);
        expect(res.body.didDocument).toBeNull();
        expect(res.body.didResolutionMetadata.error).toBe('internalError');
        expect(res.body.didDocumentMetadata).toEqual({});
    });

    it('maps an InvalidOperationError to 404 notFound on resolve', async () => {
        const res = await request(mount(async () => { throw new InvalidOperationError('proof'); }))
            .get(`/1.0/identifiers/${agentDid}`);

        expect(res.status).toBe(404);
        expect(res.body.didResolutionMetadata.error).toBe('notFound');
    });

    it('maps an unexpected throw to 500 internalError on /data', async () => {
        const res = await request(mount(async () => { throw new Error('boom'); }))
            .get(`/1.0/identifiers/${agentDid}/data`);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'internalError' });
    });

    it('maps an unexpected throw to 500 internalError on /registration', async () => {
        const res = await request(mount(async () => { throw new Error('boom'); }))
            .get(`/1.0/identifiers/${agentDid}/registration`);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'internalError' });
    });
});
