import express from 'express';
import request from 'supertest';

import {
    MAX_ROUTE_LABELS, OVERFLOW, UNROUTED, labelLimiter, markUnrouted, normalizePath, requestLabel, routeLabel,
} from '../../services/drawbridge/server/src/metrics-path.ts';

describe('metrics route labels', () => {
    it.each([
        ['/names/poppy/signin/sgn_AbC123/status', '/names/poppy/signin/:id/status'],
        ['/names/poppy/signin/sgn_AbC123/decide', '/names/poppy/signin/:id/decide'],
        ['/names/poppy/signin/response', '/names/poppy/signin/response'],
        ['/names/poppy/api/names/alice', '/names/poppy/api/names/:name'],
        ['/names/poppy/api/members/alice', '/names/poppy/api/members/:name'],
        ['/names/poppy/api/dids/did:cid:bagaaiera', '/names/poppy/api/dids/:did'],
        ['/names/api/poppy/connections/agt_xyz', '/names/api/poppy/connections/:id'],
        ['/names/poppy/token', '/names/poppy/token'],
        ['/api/v1/did/did:cid:bagaaiera', '/api/v1/did/:did'],
        ['/cashu/v1/info', '/cashu/v1/info'],
        ['/cashu/v1/keys/01df97b6fb8a572a', '/cashu/v1/keys/:keyset'],
        ['/cashu/v1/mint/quote/bolt11', '/cashu/v1/mint/quote/:method'],
        ['/cashu/v1/mint/quote/bolt11/01a1a73f-321e-7422', '/cashu/v1/mint/quote/:method/:quote'],
        ['/cashu/v1/melt/quote/bolt11/abc', '/cashu/v1/melt/quote/:method/:quote'],
        ['/cashu/v1/mint/bolt11', '/cashu/v1/mint/:method'],
        ['/cashu/v1/melt/anything-a-caller-sends', '/cashu/v1/melt/:method'],
        ['/cashu/v1/swap', '/cashu/v1/swap'],
        ['/memeplex/api/v1/publications/did:cid:bagaaiera', '/memeplex/api/v1/publications/:did'],
        ['/memeplex/api/v1/publications/did%3Acid%3Abagaaiera', '/memeplex/api/v1/publications/:did'],
        ['/memeplex/api/v1/publications/anything-a-caller-sends', '/memeplex/api/v1/publications/:did'],
        ['/memeplex/api/v1/threads/did:cid:bagaaiera', '/memeplex/api/v1/threads/:did'],
        ['/memeplex/api/v1/boosts/did:cid:bagaaiera', '/memeplex/api/v1/boosts/:did'],
        ['/memeplex/api/v1/ratings/did:cid:bagaaiera', '/memeplex/api/v1/ratings/:did'],
        ['/memeplex/api/v1/tags/did%3acid%3abagaaiera', '/memeplex/api/v1/tags/:did'],
        ['/memeplex/api/v1/coauthors/did:cid:bagaaiera', '/memeplex/api/v1/coauthors/:did'],
        ['/memepool/api/v1/objects/did:cid:bagaaiera', '/memepool/api/v1/objects/:did'],
        ['/memepool/api/v1/objects', '/memepool/api/v1/objects'],
        ['/memepool/api/v1/me', '/memepool/api/v1/me'],
        ['/memepool/api/v1/callback', '/memepool/api/v1/callback'],
        ['/memepool/api/v1/anything-a-caller-sends', '/memepool/:other'],
        ['/memepool/metrics', '/memepool/:other'],
        ['/memeplex/api/v1/timeline', '/memeplex/api/v1/timeline'],
        ['/memeplex/api/v1/ready', '/memeplex/api/v1/ready'],
        ['/memeplex/api/v1/version', '/memeplex/api/v1/version'],
        ['/memeplex/api/v1/status', '/memeplex/api/v1/status'],
        ['/memeplex/api/v1/publications/example/nonce1', '/memeplex/:other'],
        ['/memeplex/api/v1/publications', '/memeplex/:other'],
        ['/memeplex/api/v1/unknown-1', '/memeplex/:other'],
        ['/memeplex/api/v1/timeline/extra', '/memeplex/:other'],
        ['/memeplex/metrics', '/memeplex/:other'],
        ['/memeplex', '/memeplex/:other'],
        ['/memeplexity', '/memeplexity'],
    ])('labels %s as %s', (path, label) => {
        expect(normalizePath(path)).toBe(label);
    });
});

describe('route labels of mounted handlers', () => {
    // As the server records them: in a `finish` listener, by which point a
    // handler mounted with app.use() has req.path without its mount prefix.
    async function labelOf(mount: string, path: string): Promise<string> {
        let label = '';
        const app = express();
        app.use((req, res, next) => {
            res.on('finish', () => { label = routeLabel(req); });
            next();
        });
        app.use(mount, (_req, res) => { res.send('ok'); });
        await request(app).get(path);
        return label;
    }

    it.each([
        ['/cashu', '/cashu/v1/mint/quote/bolt11/01a1a73f-321e-7422', '/cashu/v1/mint/quote/:method/:quote'],
        ['/cashu', '/cashu/v1/keys/01df97b6fb8a572a?x=1', '/cashu/v1/keys/:keyset'],
        ['/names', '/names/poppy/signin/sgn_AbC123/status', '/names/poppy/signin/:id/status'],
        ['/api/v1', '/api/v1/did/did:cid:bagaaiera', '/api/v1/did/:did'],
        ['/memeplex', '/memeplex/api/v1/threads/did:cid:bagaaiera?x=1', '/memeplex/api/v1/threads/:did'],
    ])('labels %s%s by its full path', async (mount, path, label) => {
        await expect(labelOf(mount, path)).resolves.toBe(label);
    });
});

// A path is a caller's to choose, so what a caller can make of it is bounded (#1697).
describe('bounds on route labels', () => {
    // An app as the server mounts it: the recorder first, a route, a proxy mount
    // that takes anything under its prefix, and the marker last.
    function server(limit = MAX_ROUTE_LABELS) {
        const labels: string[] = [];
        const bounded = labelLimiter(limit);
        const app = express();

        app.use((req, res, next) => {
            res.on('finish', () => { labels.push(requestLabel(req, res, bounded)); });
            next();
        });
        const v1 = express.Router();
        v1.get('/ready', (_req, res) => { res.json(true); });
        v1.get('/did/:did', (_req, res) => { res.json({}); });
        app.use('/api/v1', v1);
        app.get('/invoice/:did', (_req, res) => { res.json({}); });
        app.use('/names', (_req, res) => { res.status(404).json({ error: 'unknown name' }); });
        app.use(markUnrouted);

        return { app, labels };
    }

    it('gives every request that nothing took one label, and still answers 404', async () => {
        const { app, labels } = server();

        for (const path of ['/anything-1', '/anything-2', '/api/v1/nothing-3', '/Anything-4/deeper?x=1']) {
            expect((await request(app).get(path)).status).toBe(404);
        }
        await request(app).post('/anything-5').send({});

        expect(labels).toStrictEqual([UNROUTED, UNROUTED, UNROUTED, UNROUTED, UNROUTED]);
    });

    it('labels a request that matched a declared route by the route\'s pattern', async () => {
        const { app, labels } = server();

        await request(app).get('/api/v1/ready');
        await request(app).get('/api/v1/did/did:cid:bagaaiera');
        // Whatever stands in the parameter's place, and in whatever case.
        await request(app).get('/api/v1/did/anything-a-caller-sends');
        await request(app).get('/API/V1/DID/another?x=1');
        await request(app).get('/invoice/did:cid:bagaaiera');

        expect(labels).toStrictEqual([
            '/api/v1/ready', '/api/v1/did/:did', '/api/v1/did/:did', '/api/v1/did/:did', '/invoice/:did',
        ]);
    });

    it('labels a request that a mount forwarded by its path', async () => {
        const { app, labels } = server();

        await request(app).get('/names/alice');

        expect(labels).toStrictEqual(['/names/alice']);
    });

    // Filling the limit with made-up paths under a mount takes nothing from the
    // node's own routes, seen before or not.
    it('labels a declared route as itself after the limit is reached', async () => {
        const { app, labels } = server(2);

        for (let n = 1; n <= 4; n++) {
            await request(app).get(`/names/made-up-${n}`);
        }
        await request(app).get('/api/v1/ready');
        await request(app).get('/api/v1/did/did:cid:bagaaiera');

        expect(labels).toStrictEqual([
            '/names/made-up-1', '/names/made-up-2', OVERFLOW, OVERFLOW, '/api/v1/ready', '/api/v1/did/:did',
        ]);
    });

    it('keeps no more labels than its limit, whatever is asked for under a mount', async () => {
        const { app, labels } = server(3);

        for (let n = 1; n <= 6; n++) {
            await request(app).get(`/names/made-up-${n}`);
        }
        // In another case too, which Express routes to the same mount.
        await request(app).get('/NAMES/made-up-7');
        await request(app).get('/names/made-up-2');

        expect(labels).toStrictEqual([
            '/names/made-up-1', '/names/made-up-2', '/names/made-up-3',
            OVERFLOW, OVERFLOW, OVERFLOW, OVERFLOW,
            '/names/made-up-2',
        ]);
        expect(new Set(labels).size).toBe(4);
    });

    it('does not count unrouted requests against the limit', async () => {
        const { app, labels } = server(1);

        await request(app).get('/anything-1');
        await request(app).get('/anything-2');
        await request(app).get('/api/v1/ready');

        expect(labels).toStrictEqual([UNROUTED, UNROUTED, '/api/v1/ready']);
    });
});
