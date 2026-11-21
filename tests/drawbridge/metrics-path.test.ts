import express from 'express';
import request from 'supertest';

import { normalizePath, routeLabel } from '../../services/drawbridge/server/src/metrics-path.ts';

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
