import { jest } from '@jest/globals';
import request from 'supertest';
import { UNROUTED, createGatekeeperApp, routeLabel } from '../../services/gatekeeper/server/src/gatekeeper-api.ts';

// The `route` label of the Gatekeeper's request metrics. A path is a caller's to
// choose, so a label is the pattern of the route a request matched and never
// holds what was in the path (#1697).

function createApp() {
    const answer = jest.fn<any>().mockResolvedValue({ didResolutionMetadata: { error: 'notFound' }, didDocument: {}, didDocumentMetadata: {} });
    const { app } = createGatekeeperApp({
        gatekeeper: new Proxy({}, { get: () => answer }) as any,
        httpLogging: false,
    });
    return app;
}

// The distinct route labels the app has recorded.
async function labels(app: ReturnType<typeof createApp>): Promise<string[]> {
    const metrics = (await request(app).get('/metrics')).text;

    return [...new Set([...metrics.matchAll(/http_requests_total\{[^}]*route="([^"]*)"/g)].map(match => match[1]))].sort();
}

describe('routeLabel', () => {
    it.each([
        [{ baseUrl: '/api/v1', route: { path: '/did/:did' } }, '/api/v1/did/:did'],
        [{ baseUrl: '/API/V1', route: { path: '/did/:did' } }, '/api/v1/did/:did'],
        [{ baseUrl: '/1.0/identifiers', route: { path: '/:did/data' } }, '/1.0/identifiers/:did/data'],
        [{ baseUrl: '', route: { path: '/metrics' } }, '/metrics'],
        [{ baseUrl: '/api', route: undefined }, UNROUTED],
        [{}, UNROUTED],
    ])('labels %j as %s', (req, label) => {
        expect(routeLabel(req)).toBe(label);
    });
});

// The metrics registry is the process's, so the labels of every request made
// here accumulate: the tests look at what a set of requests adds.
describe('recorded route labels', () => {
    const app = createApp();

    async function added(paths: string[], method: 'get' | 'post' = 'get'): Promise<string[]> {
        const before = new Set(await labels(app));

        for (const path of paths) {
            await request(app)[method](path);
        }

        return (await labels(app)).filter(label => !before.has(label));
    }

    it('labels a request by the route it matched, whatever stands in its parameters', async () => {
        expect(await added([
            '/api/v1/ready',
            '/api/v1/did/did:cid:bagaaiera',
            '/api/v1/did/anything-a-caller-sends',
            '/api/v1/block/local/latest',
            '/api/v1/block/local/7',
            '/api/v1/block/local/8',
            '/API/V1/block/another/9',
        ])).toStrictEqual([
            '/api/v1/block/:registry/:blockId', '/api/v1/block/:registry/latest', '/api/v1/did/:did', '/api/v1/ready', '/metrics',
        ]);
    });

    // The labels the Rust Gatekeeper gives the same routes.
    it('gives the routes under /dids/ one label, and /events/process the label of a registry\'s events', async () => {
        const before = new Set(await labels(app));

        await request(app).post('/api/v1/dids/export').send({});
        await request(app).post('/api/v1/dids/versions').send({ dids: [] });
        await request(app).post('/api/v1/dids/').send({});
        await request(app).get('/api/v1/events');
        await request(app).post('/api/v1/events/process').set('X-Archon-Admin-Key', 'none').send({});

        expect((await labels(app)).filter(label => !before.has(label)))
            .toStrictEqual(['/api/v1/dids/', '/api/v1/dids/:prefix', '/api/v1/events', '/api/v1/events/:registry']);
    });

    it('labels the conformant surface by its routes, and not by the DID resolved', async () => {
        const paths = ['did:cid:bagaaiera', 'did:cid:bagaaierb', 'did%3Acid%3Abagaaierc', 'not-a-did']
            .flatMap(did => [`/1.0/identifiers/${did}`, `/1.0/identifiers/${did}/data`, `/1.0/identifiers/${did}/registration`]);

        expect(await added(paths)).toStrictEqual([
            '/1.0/identifiers/:did', '/1.0/identifiers/:did/data', '/1.0/identifiers/:did/registration',
        ]);
    });

    it('gives every path that is no route one label', async () => {
        const paths = ['/api/v1/made-up-1', '/api/made-up-2', '/1.0/identifiers/made-up-3/and/more', '/made-up-4', '/made-up-5/deeper'];

        for (const path of paths) {
            expect([path, (await request(app).get(path)).status]).toStrictEqual([path, 404]);
        }

        expect(await added([...paths, '/made-up-6'])).toStrictEqual([]);
        expect(await added(['/made-up-7'], 'post')).toStrictEqual([]);
        expect(await labels(app)).toContain(UNROUTED);
    });

    it('holds nothing a caller put in a path', async () => {
        const all = (await labels(app)).join(' ');

        expect(all).not.toMatch(/made-up|bagaaier|anything|not-a-did|local|another/);
    });
});
