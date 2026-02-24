import { jest } from '@jest/globals';
import { routeToScope, getPriceForOperation, loadPricingFromEnv } from '../../packages/l402/src/pricing.js';
import type { OperationPricingConfig } from '../../packages/l402/src/types.js';

describe('L402 Pricing', () => {

    describe('routeToScope', () => {
        it('should map POST /api/v1/did to createDID', () => {
            expect(routeToScope('POST', '/api/v1/did')).toBe('createDID');
        });

        it('should map GET /api/v1/did/:did to resolveDID', () => {
            expect(routeToScope('GET', '/api/v1/did/did:cid:abc123')).toBe('resolveDID');
        });

        it('should map POST /api/v1/dids/ to getDIDs', () => {
            expect(routeToScope('POST', '/api/v1/dids/')).toBe('getDIDs');
        });

        it('should map POST /api/v1/dids/export to exportDIDs', () => {
            expect(routeToScope('POST', '/api/v1/dids/export')).toBe('exportDIDs');
        });

        it('should map POST /api/v1/dids/import to importDIDs', () => {
            expect(routeToScope('POST', '/api/v1/dids/import')).toBe('importDIDs');
        });

        it('should match getDIDs without trailing slash', () => {
            expect(routeToScope('POST', '/api/v1/dids')).toBe('getDIDs');
        });

        it('should return unknown for unrecognized routes', () => {
            expect(routeToScope('DELETE', '/api/v1/something')).toBe('unknown');
        });
    });

    describe('getPriceForOperation', () => {
        const pricingConfig: OperationPricingConfig = {
            operations: {
                'createDID': { amountSat: 1000, description: 'Register a new DID' },
                'resolveDID': { amountSat: 0, description: 'Resolve a DID' },
            },
        };

        it('should return price for a priced operation', () => {
            const price = getPriceForOperation(pricingConfig, 'POST', '/api/v1/did');
            expect(price).not.toBeNull();
            expect(price!.amountSat).toBe(1000);
            expect(price!.description).toBe('Register a new DID');
        });

        it('should return null for an unpriced operation', () => {
            const price = getPriceForOperation(pricingConfig, 'POST', '/api/v1/dids/');
            expect(price).toBeNull();
        });

        it('should return price for a parameterized route', () => {
            const price = getPriceForOperation(pricingConfig, 'GET', '/api/v1/did/did:cid:abc');
            expect(price).not.toBeNull();
            expect(price!.amountSat).toBe(0);
        });
    });

    describe('loadPricingFromEnv', () => {
        const originalEnv = process.env;

        beforeEach(() => {
            process.env = { ...originalEnv };
            delete process.env.ARCHON_L402_PRICE_CREATE_DID;
            delete process.env.ARCHON_L402_PRICE_ISSUE_CREDENTIAL;
            delete process.env.ARCHON_L402_PRICE_RESOLVE_DID;
            delete process.env.ARCHON_L402_PRICING;
        });

        afterAll(() => {
            process.env = originalEnv;
        });

        it('should return empty operations when no env vars set', () => {
            const config = loadPricingFromEnv();
            expect(Object.keys(config.operations)).toHaveLength(0);
        });

        it('should load createDID price from env', () => {
            process.env.ARCHON_L402_PRICE_CREATE_DID = '1000';
            const config = loadPricingFromEnv();
            expect(config.operations['createDID']).toBeDefined();
            expect(config.operations['createDID'].amountSat).toBe(1000);
        });

        it('should load issueCredential price from env', () => {
            process.env.ARCHON_L402_PRICE_ISSUE_CREDENTIAL = '500';
            const config = loadPricingFromEnv();
            expect(config.operations['issueCredential']).toBeDefined();
            expect(config.operations['issueCredential'].amountSat).toBe(500);
        });

        it('should skip resolveDID when price is 0', () => {
            process.env.ARCHON_L402_PRICE_RESOLVE_DID = '0';
            const config = loadPricingFromEnv();
            expect(config.operations['resolveDID']).toBeUndefined();
        });

        it('should load resolveDID when price is > 0', () => {
            process.env.ARCHON_L402_PRICE_RESOLVE_DID = '10';
            const config = loadPricingFromEnv();
            expect(config.operations['resolveDID']).toBeDefined();
            expect(config.operations['resolveDID'].amountSat).toBe(10);
        });

        it('should parse ARCHON_L402_PRICING JSON', () => {
            process.env.ARCHON_L402_PRICING = JSON.stringify({
                operations: {
                    customOp: { amountSat: 42, description: 'Custom' },
                },
            });
            const config = loadPricingFromEnv();
            expect(config.operations['customOp']).toBeDefined();
            expect(config.operations['customOp'].amountSat).toBe(42);
        });

        it('should handle invalid JSON gracefully', () => {
            process.env.ARCHON_L402_PRICING = 'not-valid-json{';
            const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const config = loadPricingFromEnv();
            expect(Object.keys(config.operations)).toHaveLength(0);
            expect(consoleWarn).toHaveBeenCalled();
            consoleWarn.mockRestore();
        });

        it('should ignore NaN values from non-numeric env vars', () => {
            process.env.ARCHON_L402_PRICE_CREATE_DID = 'not-a-number';
            const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const config = loadPricingFromEnv();
            expect(config.operations['createDID']).toBeUndefined();
            expect(consoleWarn).toHaveBeenCalled();
            consoleWarn.mockRestore();
        });

        it('should merge JSON pricing with env var pricing', () => {
            process.env.ARCHON_L402_PRICE_CREATE_DID = '1000';
            process.env.ARCHON_L402_PRICING = JSON.stringify({
                operations: {
                    customOp: { amountSat: 42, description: 'Custom' },
                },
            });
            const config = loadPricingFromEnv();
            expect(config.operations['createDID']).toBeDefined();
            expect(config.operations['customOp']).toBeDefined();
        });
    });
});
