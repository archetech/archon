import express from 'express';
import request from 'supertest';
import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import HeliaClient from '@didcid/ipfs/helia';
import TestHelper from './helper.ts';
import { InvalidOperationError } from '@didcid/common/errors';
import { createIdentifiersRouter } from '../../services/gatekeeper/server/src/identifiers-router.ts';

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
        expect(res.body.didDocumentMetadata.confirmed).toBeUndefined();
        expect(res.body.didDocumentMetadata.timestamp).toBeUndefined();
        expect(res.body.didResolutionMetadata.contentType).toBe('application/did+ld+json');
        expect(res.body.didResolutionMetadata.retrieved).toBeUndefined();
        expect(res.headers.vary).toContain('Accept');
    });

    it('honors DID JSON and JSON-LD Accept headers in successful resolution metadata', async () => {
        const jsonLd = await request(app)
            .get(`/1.0/identifiers/${agentDid}`)
            .set('Accept', 'application/did+ld+json');

        expect(jsonLd.status).toBe(200);
        expect(jsonLd.headers['content-type']).toBe('application/did+ld+json');
        expect(jsonLd.headers.vary).toContain('Accept');
        expect(jsonLd.body.didResolutionMetadata.contentType).toBe('application/did+ld+json');
        expect(jsonLd.body.didResolutionMetadata.retrieved).toBeUndefined();

        const didJson = await request(app)
            .get(`/1.0/identifiers/${agentDid}`)
            .set('Accept', 'Application/DID+JSON;Q=1, application/did+ld+json;q=0.5');

        expect(didJson.status).toBe(200);
        expect(didJson.headers['content-type']).toBe('application/did+json');
        expect(didJson.headers.vary).toContain('Accept');
        expect(didJson.body.didResolutionMetadata.contentType).toBe('application/did+json');
        expect(didJson.body.didResolutionMetadata.retrieved).toBeUndefined();
    });

    it('serves application/did-resolution when the client asks for it', async () => {
        // #770: did+ld+json and did+json describe a DID *document*, and this
        // endpoint answers with the resolution triple. A client that names the
        // resolution media type gets it labelled correctly.
        const res = await request(app)
            .get(`/1.0/identifiers/${agentDid}`)
            .set('Accept', 'application/did-resolution');

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/did-resolution');
        expect(res.headers.vary).toContain('Accept');

        // Parsed by hand: application/did-resolution is not a media type generic
        // JSON clients auto-parse, which is part of why it stays opt-in.
        const body = JSON.parse(res.text);
        expect(Object.keys(body).sort()).toStrictEqual([
            'didDocument',
            'didDocumentMetadata',
            'didResolutionMetadata',
        ]);
        // The metadata field still reports the DOCUMENT representation: it
        // describes what was returned inside the envelope, not the envelope.
        expect(body.didResolutionMetadata.contentType).toBe('application/did+ld+json');
        expect(body.didDocument.id).toBe(agentDid);
    });

    it('leaves the document media types as the default', async () => {
        // Universal Resolver drivers expect these, so naming did-resolution has
        // to be opt-in rather than a change of default.
        const noAccept = await request(app).get(`/1.0/identifiers/${agentDid}`);
        expect(noAccept.headers['content-type']).toBe('application/did+ld+json');

        // A wildcard satisfies the document types but must not select the
        // resolution envelope.
        const wildcard = await request(app)
            .get(`/1.0/identifiers/${agentDid}`)
            .set('Accept', '*/*');
        expect(wildcard.headers['content-type']).toBe('application/did+ld+json');

        const applicationWildcard = await request(app)
            .get(`/1.0/identifiers/${agentDid}`)
            .set('Accept', 'application/*');
        expect(applicationWildcard.headers['content-type']).toBe('application/did+ld+json');

        // A wildcard alongside a lower-q explicit type: the wildcard gives every
        // document type q=1, which beats the named did+json at q=0.5. Pinned
        // because it is what a lenient UR driver sends.
        const outrankingWildcard = await request(app)
            .get(`/1.0/identifiers/${agentDid}`)
            .set('Accept', '*/*;q=1, application/did+json;q=0.5');
        expect(outrankingWildcard.headers['content-type']).toBe('application/did+ld+json');
    });

    it('honours q-values between the resolution envelope and the document types', async () => {
        const preferResolution = await request(app)
            .get(`/1.0/identifiers/${agentDid}`)
            .set('Accept', 'application/did+ld+json;q=0.5, application/did-resolution;q=1');
        expect(preferResolution.headers['content-type']).toBe('application/did-resolution');
        expect(JSON.parse(preferResolution.text).didDocument.id).toBe(agentDid);

        const preferDocument = await request(app)
            .get(`/1.0/identifiers/${agentDid}`)
            .set('Accept', 'application/did-resolution;q=0.4, application/did+json;q=0.9');
        expect(preferDocument.headers['content-type']).toBe('application/did+json');
        expect(preferDocument.body.didResolutionMetadata.contentType).toBe('application/did+json');
    });

    it('answers representationNotSupported when it can produce nothing the client accepts', async () => {
        // #770: any Accept used to be satisfied with JSON-LD and a 200, which
        // contradicted the supportedContentTypes published in the DID test suite
        // fixture. The result stays triple-shaped, as errors do on this surface.
        const res = await request(app)
            .get(`/1.0/identifiers/${agentDid}`)
            .set('Accept', 'application/xml');

        expect(res.status).toBe(406);
        expect(res.body.didResolutionMetadata.error).toBe('representationNotSupported');
        expect(res.body.didDocument).toBeNull();
        expect(res.body.didDocumentMetadata).toStrictEqual({});
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

    it('normalizes DID Core metadata datetimes on current and historical responses', async () => {
        const resolveDID = async (_did: string, options: any) => ({
            didDocument: { id: agentDid },
            didResolutionMetadata: {},
            didDocumentMetadata: options.versionSequence === 1
                ? {
                    created: '2026-01-28T21:29:32.495Z',
                    versionSequence: '1',
                }
                : {
                    created: '2026-01-28T21:29:32.495Z',
                    updated: '2026-05-28T16:47:27.000Z',
                    deleted: '2026-06-01T10:11:12.999Z',
                    versionSequence: '2',
                    confirmed: true,
                    timestamp: {
                        chain: 'BTC:mainnet',
                        opid: 'mock-opid',
                        lowerBound: null,
                        upperBound: { height: 101 },
                    },
                },
            didDocumentRegistration: {
                version: 1,
                type: 'agent',
                registry: 'BTC:mainnet',
            },
        });
        const stubApp = express();
        stubApp.use('/1.0/identifiers', createIdentifiersRouter({ resolveDID } as any, mockLogger));

        const current = await request(stubApp).get(`/1.0/identifiers/${agentDid}`);
        expect(current.status).toBe(200);
        expect(current.body.didDocumentMetadata.created).toBe('2026-01-28T21:29:32Z');
        expect(current.body.didDocumentMetadata.updated).toBe('2026-05-28T16:47:27Z');
        expect(current.body.didDocumentMetadata.deleted).toBe('2026-06-01T10:11:12Z');
        expect(current.body.didDocumentMetadata.confirmed).toBeUndefined();
        expect(current.body.didDocumentMetadata.timestamp).toBeUndefined();

        const historical = await request(stubApp).get(`/1.0/identifiers/${agentDid}?versionSequence=1`);
        expect(historical.status).toBe(200);
        expect(historical.body.didDocumentMetadata.created).toBe('2026-01-28T21:29:32Z');
        expect(historical.body.didDocumentMetadata.updated).toBeUndefined();
        expect(historical.body.didDocumentMetadata.deleted).toBeUndefined();

        const registration = await request(stubApp).get(`/1.0/identifiers/${agentDid}/registration`);
        expect(registration.status).toBe(200);
        expect(registration.body).toMatchObject({
            version: 1,
            type: 'agent',
            registry: 'BTC:mainnet',
            confirmed: true,
            timestamp: {
                chain: 'BTC:mainnet',
                opid: 'mock-opid',
                lowerBound: null,
                upperBound: { height: 101 },
            },
        });
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
        expect(res.body.confirmed).toBe(true);
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
