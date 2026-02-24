import {
    createMacaroon,
    verifyMacaroon,
    extractCaveats,
    verifyPreimage,
    generateMacaroonId,
} from '../../packages/l402/src/macaroon.js';
import { InvalidMacaroonError } from '../../packages/l402/src/errors.js';
import { TEST_ROOT_SECRET, TEST_LOCATION, TEST_DID, generateTestPreimage } from './helper.js';
import type { L402CaveatSet } from '../../packages/l402/src/types.js';

describe('L402 Macaroon', () => {

    describe('generateMacaroonId', () => {
        it('should generate a unique 32-character hex string', () => {
            const id = generateMacaroonId();
            expect(id).toHaveLength(32);
            expect(/^[0-9a-f]+$/.test(id)).toBe(true);
        });

        it('should generate unique IDs', () => {
            const id1 = generateMacaroonId();
            const id2 = generateMacaroonId();
            expect(id1).not.toBe(id2);
        });
    });

    describe('createMacaroon', () => {
        it('should create a macaroon with caveats', () => {
            const caveats: L402CaveatSet = {
                did: TEST_DID,
                scope: ['resolveDID', 'getDIDs'],
                expiry: Math.floor(Date.now() / 1000) + 3600,
                paymentHash: 'abc123',
            };

            const token = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, caveats);

            expect(token.id).toBeDefined();
            expect(token.id).toHaveLength(32);
            expect(token.macaroon).toBeDefined();
            expect(typeof token.macaroon).toBe('string');
            expect(token.macaroon.length).toBeGreaterThan(0);
        });

        it('should create different macaroons for different caveats', () => {
            const token1 = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, { did: 'did:cid:a' });
            const token2 = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, { did: 'did:cid:b' });

            expect(token1.macaroon).not.toBe(token2.macaroon);
        });
    });

    describe('extractCaveats', () => {
        it('should extract caveats from a macaroon', () => {
            const caveats: L402CaveatSet = {
                did: TEST_DID,
                scope: ['resolveDID'],
                expiry: 1700000000,
                paymentHash: 'hash123',
            };

            const token = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, caveats);
            const extracted = extractCaveats(token.macaroon);

            expect(extracted.did).toBe(TEST_DID);
            expect(extracted.scope).toEqual(['resolveDID']);
            expect(extracted.expiry).toBe(1700000000);
            expect(extracted.paymentHash).toBe('hash123');
        });
    });

    describe('verifyMacaroon', () => {
        it('should verify a valid macaroon', () => {
            const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
            const caveats: L402CaveatSet = {
                did: TEST_DID,
                scope: ['resolveDID'],
                expiry: futureExpiry,
                paymentHash: 'hash123',
            };

            const token = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, caveats);

            const result = verifyMacaroon(TEST_ROOT_SECRET, token.macaroon, {
                did: TEST_DID,
                scope: 'resolveDID',
                paymentHash: 'hash123',
            });

            expect(result.valid).toBe(true);
            expect(result.id).toBe(token.id);
            expect(result.caveats.did).toBe(TEST_DID);
        });

        it('should reject a macaroon with wrong secret', () => {
            const caveats: L402CaveatSet = {
                did: TEST_DID,
                expiry: Math.floor(Date.now() / 1000) + 3600,
            };

            const token = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, caveats);

            const result = verifyMacaroon('wrong-secret', token.macaroon, {
                did: TEST_DID,
            });

            expect(result.valid).toBe(false);
        });

        it('should reject an expired macaroon', () => {
            const pastExpiry = Math.floor(Date.now() / 1000) - 3600;
            const caveats: L402CaveatSet = {
                did: TEST_DID,
                expiry: pastExpiry,
            };

            const token = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, caveats);

            const result = verifyMacaroon(TEST_ROOT_SECRET, token.macaroon, {
                did: TEST_DID,
            });

            expect(result.valid).toBe(false);
        });

        it('should reject a macaroon with wrong DID', () => {
            const caveats: L402CaveatSet = {
                did: TEST_DID,
                expiry: Math.floor(Date.now() / 1000) + 3600,
            };

            const token = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, caveats);

            const result = verifyMacaroon(TEST_ROOT_SECRET, token.macaroon, {
                did: 'did:cid:wrong',
            });

            expect(result.valid).toBe(false);
        });

        it('should reject a macaroon with max_uses exceeded', () => {
            const caveats: L402CaveatSet = {
                did: TEST_DID,
                expiry: Math.floor(Date.now() / 1000) + 3600,
                maxUses: 5,
            };

            const token = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, caveats);

            const result = verifyMacaroon(TEST_ROOT_SECRET, token.macaroon, {
                did: TEST_DID,
                currentUses: 5,
            });

            expect(result.valid).toBe(false);
        });

        it('should verify a macaroon with max_uses not exceeded', () => {
            const caveats: L402CaveatSet = {
                did: TEST_DID,
                expiry: Math.floor(Date.now() / 1000) + 3600,
                maxUses: 5,
                paymentHash: 'hash123',
            };

            const token = createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, caveats);

            const result = verifyMacaroon(TEST_ROOT_SECRET, token.macaroon, {
                did: TEST_DID,
                currentUses: 4,
                paymentHash: 'hash123',
            });

            expect(result.valid).toBe(true);
        });
    });

    describe('verifyPreimage', () => {
        it('should return true for a valid preimage', () => {
            const { preimage, paymentHash } = generateTestPreimage();
            expect(verifyPreimage(preimage, paymentHash)).toBe(true);
        });

        it('should return false for an invalid preimage', () => {
            const { paymentHash } = generateTestPreimage();
            expect(verifyPreimage('0000000000000000000000000000000000000000000000000000000000000000', paymentHash)).toBe(false);
        });

        it('should return false for non-hex preimage', () => {
            const { paymentHash } = generateTestPreimage();
            expect(verifyPreimage('xyz-not-hex', paymentHash)).toBe(false);
        });

        it('should return false for empty preimage', () => {
            const { paymentHash } = generateTestPreimage();
            expect(verifyPreimage('', paymentHash)).toBe(false);
        });
    });

    describe('createMacaroon validation', () => {
        it('should throw for invalid caveat set (maxUses = 0)', () => {
            expect(() => createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, { maxUses: 0 }))
                .toThrow(InvalidMacaroonError);
        });

        it('should throw for invalid caveat set (expiry <= 0)', () => {
            expect(() => createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, { expiry: -1 }))
                .toThrow(InvalidMacaroonError);
        });

        it('should throw for invalid caveat set (empty scope)', () => {
            expect(() => createMacaroon(TEST_ROOT_SECRET, TEST_LOCATION, { scope: [] }))
                .toThrow(InvalidMacaroonError);
        });
    });
});
