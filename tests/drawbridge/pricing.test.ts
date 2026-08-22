import { jest } from '@jest/globals';

import {
    getPriceForOperation,
    loadPricingFromEnv,
    routeToScope,
} from '../../services/drawbridge/server/src/pricing.ts';
import type { OperationPricingConfig } from '../../services/drawbridge/server/src/types.ts';

describe('routeToScope', () => {
    it('maps exact routes to their scope', () => {
        expect(routeToScope('POST', '/api/v1/did')).toBe('createDID');
        expect(routeToScope('POST', '/api/v1/did/generate')).toBe('generateDID');
        expect(routeToScope('GET', '/api/v1/registries')).toBe('listRegistries');
        expect(routeToScope('POST', '/api/v1/batch/import/cids')).toBe('importBatchByCids');
    });

    it('matches parameterized routes by segment shape', () => {
        expect(routeToScope('GET', '/api/v1/did/did:cid:abc')).toBe('resolveDID');
        expect(routeToScope('GET', '/api/v1/queue/local')).toBe('getQueue');
        expect(routeToScope('POST', '/api/v1/queue/local/clear')).toBe('clearQueue');
        expect(routeToScope('GET', '/api/v1/ipfs/json/some-cid')).toBe('getJSON');
        expect(routeToScope('POST', '/api/v1/block/local')).toBe('addBlock');
    });

    it('prefers the literal segment when a parameterized route could also match', () => {
        expect(routeToScope('GET', '/api/v1/block/local/latest')).toBe('getBlock');
        expect(routeToScope('GET', '/api/v1/block/local/42')).toBe('getBlock');
    });

    it('ignores trailing slashes but keeps the root path intact', () => {
        expect(routeToScope('POST', '/api/v1/did/')).toBe('createDID');
        expect(routeToScope('GET', '/api/v1/registries///')).toBe('listRegistries');
        expect(routeToScope('GET', '/')).toBe('unknown');
    });

    it('does not match a known path under the wrong method', () => {
        expect(routeToScope('DELETE', '/api/v1/did')).toBe('unknown');
        expect(routeToScope('GET', '/api/v1/did')).toBe('unknown');
    });

    it('returns unknown for unmapped paths and mismatched segment counts', () => {
        expect(routeToScope('GET', '/api/v1/nope')).toBe('unknown');
        expect(routeToScope('GET', '/api/v1/did/abc/extra')).toBe('unknown');
        expect(routeToScope('POST', '')).toBe('unknown');
    });
});

describe('getPriceForOperation', () => {
    const config: OperationPricingConfig = {
        operations: {
            createDID: { amountSat: 100, description: 'Register a new DID' },
            resolveDID: { amountSat: 1, description: 'Resolve a DID document' },
        },
    };

    it('returns the price for a mapped route', () => {
        expect(getPriceForOperation(config, 'POST', '/api/v1/did')).toEqual({
            amountSat: 100,
            description: 'Register a new DID',
        });
        expect(getPriceForOperation(config, 'GET', '/api/v1/did/did:cid:abc')).toEqual({
            amountSat: 1,
            description: 'Resolve a DID document',
        });
    });

    it('returns null when the route is unmapped or unpriced', () => {
        expect(getPriceForOperation(config, 'GET', '/api/v1/nope')).toBeNull();
        expect(getPriceForOperation(config, 'GET', '/api/v1/registries')).toBeNull();
    });
});

describe('loadPricingFromEnv', () => {
    const vars = [
        'ARCHON_DRAWBRIDGE_PRICE_CREATE_DID',
        'ARCHON_DRAWBRIDGE_PRICE_RESOLVE_DID',
        'ARCHON_DRAWBRIDGE_PRICING',
    ];
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
        saved = Object.fromEntries(vars.map(v => [v, process.env[v]]));
        for (const v of vars) delete process.env[v];
    });

    afterEach(() => {
        for (const v of vars) {
            if (saved[v] === undefined) delete process.env[v];
            else process.env[v] = saved[v];
        }
    });

    it('returns no operations when nothing is configured', () => {
        expect(loadPricingFromEnv()).toEqual({ operations: {} });
    });

    it('reads the per-operation price variables', () => {
        process.env.ARCHON_DRAWBRIDGE_PRICE_CREATE_DID = '250';
        process.env.ARCHON_DRAWBRIDGE_PRICE_RESOLVE_DID = '2';

        expect(loadPricingFromEnv().operations).toEqual({
            createDID: { amountSat: 250, description: 'Register a new DID' },
            resolveDID: { amountSat: 2, description: 'Resolve a DID document' },
        });
    });

    it('accepts a free createDID but not a free resolveDID', () => {
        // createDID validates `>= 0`, resolveDID validates `> 0`.
        process.env.ARCHON_DRAWBRIDGE_PRICE_CREATE_DID = '0';
        process.env.ARCHON_DRAWBRIDGE_PRICE_RESOLVE_DID = '0';

        const operations = loadPricingFromEnv().operations;
        expect(operations.createDID).toEqual({ amountSat: 0, description: 'Register a new DID' });
        expect(operations.resolveDID).toBeUndefined();
    });

    it('ignores unparsable and negative amounts', () => {
        process.env.ARCHON_DRAWBRIDGE_PRICE_CREATE_DID = 'free';
        process.env.ARCHON_DRAWBRIDGE_PRICE_RESOLVE_DID = '-5';

        expect(loadPricingFromEnv()).toEqual({ operations: {} });
    });

    it('merges JSON pricing over the individual variables', () => {
        process.env.ARCHON_DRAWBRIDGE_PRICE_CREATE_DID = '250';
        process.env.ARCHON_DRAWBRIDGE_PRICING = JSON.stringify({
            operations: {
                createDID: { amountSat: 999, description: 'Override' },
                exportBatch: { amountSat: 10, description: 'Export a batch' },
            },
        });

        expect(loadPricingFromEnv().operations).toEqual({
            createDID: { amountSat: 999, description: 'Override' },
            exportBatch: { amountSat: 10, description: 'Export a batch' },
        });
    });

    it('warns and keeps the other prices when the JSON is invalid', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        process.env.ARCHON_DRAWBRIDGE_PRICE_CREATE_DID = '250';
        process.env.ARCHON_DRAWBRIDGE_PRICING = '{not valid json';

        try {
            expect(loadPricingFromEnv().operations).toEqual({
                createDID: { amountSat: 250, description: 'Register a new DID' },
            });
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it('ignores JSON without an operations key', () => {
        process.env.ARCHON_DRAWBRIDGE_PRICING = JSON.stringify({ somethingElse: true });

        expect(loadPricingFromEnv()).toEqual({ operations: {} });
    });
});
