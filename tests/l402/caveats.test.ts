import {
    encodeCaveat,
    decodeCaveat,
    caveatsToConditions,
    conditionsToCaveats,
    validateCaveatSet,
    isCaveatSatisfied,
} from '../../packages/l402/src/caveats.js';
import type { L402CaveatSet } from '../../packages/l402/src/types.js';

describe('L402 Caveats', () => {

    describe('encodeCaveat', () => {
        it('should encode a string caveat', () => {
            const result = encodeCaveat('did', 'did:cid:abc123');
            expect(result).toBe('did = did:cid:abc123');
        });

        it('should encode a number caveat', () => {
            const result = encodeCaveat('expiry', 1700000000);
            expect(result).toBe('expiry = 1700000000');
        });

        it('should encode an array caveat', () => {
            const result = encodeCaveat('scope', ['resolveDID', 'getDIDs']);
            expect(result).toBe('scope = resolveDID,getDIDs');
        });
    });

    describe('decodeCaveat', () => {
        it('should decode a caveat string', () => {
            const result = decodeCaveat('did = did:cid:abc123');
            expect(result.type).toBe('did');
            expect(result.value).toBe('did:cid:abc123');
        });

        it('should handle whitespace around equals', () => {
            const result = decodeCaveat('scope = resolveDID,getDIDs');
            expect(result.type).toBe('scope');
            expect(result.value).toBe('resolveDID,getDIDs');
        });

        it('should throw on invalid format', () => {
            expect(() => decodeCaveat('invalidcaveat')).toThrow('Invalid caveat format');
        });
    });

    describe('caveatsToConditions', () => {
        it('should convert a full caveat set to conditions', () => {
            const caveats: L402CaveatSet = {
                did: 'did:cid:abc123',
                scope: ['resolveDID', 'getDIDs'],
                expiry: 1700000000,
                maxUses: 10,
                paymentHash: 'abc123def456',
            };

            const conditions = caveatsToConditions(caveats);
            expect(conditions).toContain('did = did:cid:abc123');
            expect(conditions).toContain('scope = resolveDID,getDIDs');
            expect(conditions).toContain('expiry = 1700000000');
            expect(conditions).toContain('max_uses = 10');
            expect(conditions).toContain('payment_hash = abc123def456');
        });

        it('should skip undefined fields', () => {
            const caveats: L402CaveatSet = {
                did: 'did:cid:abc123',
            };

            const conditions = caveatsToConditions(caveats);
            expect(conditions).toHaveLength(1);
            expect(conditions[0]).toBe('did = did:cid:abc123');
        });
    });

    describe('conditionsToCaveats', () => {
        it('should convert conditions back to caveat set', () => {
            const conditions = [
                'did = did:cid:abc123',
                'scope = resolveDID,getDIDs',
                'expiry = 1700000000',
                'max_uses = 10',
                'payment_hash = abc123def456',
            ];

            const caveats = conditionsToCaveats(conditions);
            expect(caveats.did).toBe('did:cid:abc123');
            expect(caveats.scope).toEqual(['resolveDID', 'getDIDs']);
            expect(caveats.expiry).toBe(1700000000);
            expect(caveats.maxUses).toBe(10);
            expect(caveats.paymentHash).toBe('abc123def456');
        });

        it('should handle empty conditions', () => {
            const caveats = conditionsToCaveats([]);
            expect(caveats.did).toBeUndefined();
            expect(caveats.scope).toBeUndefined();
        });

        it('should skip NaN expiry values', () => {
            const caveats = conditionsToCaveats(['expiry = not-a-number']);
            expect(caveats.expiry).toBeUndefined();
        });

        it('should skip NaN max_uses values', () => {
            const caveats = conditionsToCaveats(['max_uses = abc']);
            expect(caveats.maxUses).toBeUndefined();
        });
    });

    describe('validateCaveatSet', () => {
        it('should return true for a valid caveat set', () => {
            const caveats: L402CaveatSet = {
                did: 'did:cid:abc123',
                scope: ['resolveDID'],
                expiry: 1700000000,
                maxUses: 10,
            };
            expect(validateCaveatSet(caveats)).toBe(true);
        });

        it('should return false for zero expiry', () => {
            expect(validateCaveatSet({ expiry: 0 })).toBe(false);
        });

        it('should return false for negative expiry', () => {
            expect(validateCaveatSet({ expiry: -1 })).toBe(false);
        });

        it('should return false for zero maxUses', () => {
            expect(validateCaveatSet({ maxUses: 0 })).toBe(false);
        });

        it('should return false for empty scope array', () => {
            expect(validateCaveatSet({ scope: [] })).toBe(false);
        });

        it('should return true for empty caveat set', () => {
            expect(validateCaveatSet({})).toBe(true);
        });
    });

    describe('isCaveatSatisfied', () => {
        it('should satisfy DID caveat with matching DID', () => {
            expect(isCaveatSatisfied('did = did:cid:abc123', { did: 'did:cid:abc123' })).toBe(true);
        });

        it('should not satisfy DID caveat with non-matching DID', () => {
            expect(isCaveatSatisfied('did = did:cid:abc123', { did: 'did:cid:xyz789' })).toBe(false);
        });

        it('should satisfy scope caveat when scope is in the allowed list', () => {
            expect(isCaveatSatisfied('scope = resolveDID,getDIDs', { scope: 'resolveDID' })).toBe(true);
        });

        it('should not satisfy scope caveat when scope is not in the allowed list', () => {
            expect(isCaveatSatisfied('scope = resolveDID,getDIDs', { scope: 'deleteDID' })).toBe(false);
        });

        it('should satisfy expiry caveat when not expired', () => {
            const futureTime = Math.floor(Date.now() / 1000) + 3600;
            expect(isCaveatSatisfied(`expiry = ${futureTime}`, {})).toBe(true);
        });

        it('should not satisfy expiry caveat when expired', () => {
            const pastTime = Math.floor(Date.now() / 1000) - 3600;
            expect(isCaveatSatisfied(`expiry = ${pastTime}`, {})).toBe(false);
        });

        it('should satisfy max_uses caveat when under limit', () => {
            expect(isCaveatSatisfied('max_uses = 10', { currentUses: 5 })).toBe(true);
        });

        it('should not satisfy max_uses caveat when at limit', () => {
            expect(isCaveatSatisfied('max_uses = 10', { currentUses: 10 })).toBe(false);
        });

        it('should satisfy payment_hash caveat with matching hash', () => {
            expect(isCaveatSatisfied('payment_hash = abc123', { paymentHash: 'abc123' })).toBe(true);
        });

        it('should not satisfy unknown caveat type', () => {
            expect(isCaveatSatisfied('unknown = value', {})).toBe(false);
        });
    });
});
