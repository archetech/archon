import { normalizePath } from '../../services/drawbridge/server/src/metrics-path.ts';

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
    ])('labels %s as %s', (path, label) => {
        expect(normalizePath(path)).toBe(label);
    });
});
