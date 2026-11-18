import { readFileSync } from 'node:fs';
import request from 'supertest';
import Gatekeeper from '@didcid/gatekeeper';
import Db from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { Operation } from '@didcid/gatekeeper/types';
import { createGatekeeperApp } from '../../services/gatekeeper/server/src/gatekeeper-api.ts';
import config from '../../services/gatekeeper/server/src/config.js';

// Shared vectors: what resolving a signed two-version history returns for each
// kind of version option, through the HTTP routes of both resolution surfaces.
const vector = JSON.parse(readFileSync('tests/gatekeeper/resolution-option-v1-vectors.json', 'utf8')) as {
    agent: Operation; update: Operation; did: string;
    cases: { name: string; query: string; error?: string; version?: string }[];
};

let app: ReturnType<typeof createGatekeeperApp>['app'];

beforeAll(async () => {
    const gatekeeper = new Gatekeeper({ db: new Db('resolution-options'), ipfs: new MemoryClient() });
    expect(await gatekeeper.createDID(vector.agent)).toBe(vector.did);
    expect(await gatekeeper.updateDID(vector.update)).toBe(true);
    ({ app } = createGatekeeperApp({ gatekeeper, config: { ...config, adminApiKey: '', fallbackURL: '', confirmFallbackURL: '' } }));
});

const surfaces = [
    { surface: 'conformant', path: (did: string) => `/1.0/identifiers/${did}` },
    { surface: 'v1', path: (did: string) => `/api/v1/did/${did}` },
];

describe.each(surfaces)('the $surface surface', ({ surface, path }) => {
    it.each(vector.cases)('resolves $name', async ({ query, error, version }) => {
        const response = await request(app).get(`${path(vector.did)}?${query}`);

        expect(response.body.didResolutionMetadata?.error).toBe(error);
        expect(response.body.didDocumentMetadata?.versionSequence).toBe(version);
        if (surface === 'conformant') {
            expect(response.status).toBe(error === 'invalidOptions' ? 400 : error === 'notFound' ? 404 : 200);
        }
    });

    it('reports an invalid DID before an invalid option', async () => {
        const response = await request(app).get(`${path('did:cid:not-a-cid')}?versionTime=garbage`);

        expect(response.body.didResolutionMetadata?.error).toBe('invalidDid');
    });
});
