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
    ])('labels %s as %s', (path, label) => {
        expect(normalizePath(path)).toBe(label);
    });
});
