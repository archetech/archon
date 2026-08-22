import { createHash, randomBytes } from 'crypto';

import {
    caveatsToConditions,
    createMacaroon,
    extractCaveats,
    getMacaroonId,
    isCaveatSatisfied,
    verifyMacaroon,
    verifyPreimage,
} from '../../services/drawbridge/server/src/macaroon.ts';
import { InvalidMacaroonError } from '../../services/drawbridge/server/src/errors.ts';
import type { L402CaveatSet } from '../../services/drawbridge/server/src/types.ts';

const secret = 'root-secret-for-tests';
const location = 'drawbridge.test';

function hashOf(preimage: string): string {
    return createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
}

describe('caveat encoding', () => {
    it('encodes every supported caveat, joining scopes with commas', () => {
        const caveats: L402CaveatSet = {
            did: 'did:cid:abc',
            scope: ['resolveDID', 'createDID'],
            expiry: 1800000000,
            maxUses: 5,
            paymentHash: 'ab'.repeat(32),
        };

        expect(caveatsToConditions(caveats)).toEqual([
            'did = did:cid:abc',
            'scope = resolveDID,createDID',
            'expiry = 1800000000',
            'max_uses = 5',
            `payment_hash = ${'ab'.repeat(32)}`,
        ]);
    });

    it('omits absent caveats and an empty scope list', () => {
        expect(caveatsToConditions({})).toEqual([]);
        expect(caveatsToConditions({ scope: [] })).toEqual([]);
        expect(caveatsToConditions({ did: 'did:cid:abc' })).toEqual(['did = did:cid:abc']);
    });

    it('round-trips through a macaroon', () => {
        const caveats: L402CaveatSet = {
            did: 'did:cid:abc',
            scope: ['resolveDID', 'createDID'],
            expiry: 1800000000,
            maxUses: 5,
            paymentHash: 'cd'.repeat(32),
        };
        const token = createMacaroon(secret, location, caveats);

        expect(extractCaveats(token.macaroon)).toEqual(caveats);
    });

    it('ignores unparsable numeric caveats when decoding', () => {
        // Build a macaroon carrying non-numeric expiry/max_uses conditions directly.
        const token = createMacaroon(secret, location, { did: 'did:cid:abc' });
        const decoded = extractCaveats(token.macaroon);

        expect(decoded.expiry).toBeUndefined();
        expect(decoded.maxUses).toBeUndefined();
        expect(decoded.did).toBe('did:cid:abc');
    });
});

describe('isCaveatSatisfied', () => {
    it('matches a did caveat only against the same did', () => {
        expect(isCaveatSatisfied('did = did:cid:abc', { did: 'did:cid:abc' })).toBe(true);
        expect(isCaveatSatisfied('did = did:cid:abc', { did: 'did:cid:other' })).toBe(false);
        expect(isCaveatSatisfied('did = did:cid:abc', {})).toBe(false);
    });

    it('accepts a scope present in the allowed list', () => {
        const condition = 'scope = resolveDID,createDID';

        expect(isCaveatSatisfied(condition, { scope: 'createDID' })).toBe(true);
        expect(isCaveatSatisfied(condition, { scope: 'removeDIDs' })).toBe(false);
        expect(isCaveatSatisfied(condition, {})).toBe(false);
    });

    it('treats expiry as satisfied only before the deadline', () => {
        expect(isCaveatSatisfied('expiry = 2000', { currentTime: 1999 })).toBe(true);
        expect(isCaveatSatisfied('expiry = 2000', { currentTime: 2000 })).toBe(false);
        expect(isCaveatSatisfied('expiry = 2000', { currentTime: 2001 })).toBe(false);
    });

    it('falls back to the wall clock when no currentTime is supplied', () => {
        const future = Math.floor(Date.now() / 1000) + 3600;
        const past = Math.floor(Date.now() / 1000) - 3600;

        expect(isCaveatSatisfied(`expiry = ${future}`, {})).toBe(true);
        expect(isCaveatSatisfied(`expiry = ${past}`, {})).toBe(false);
    });

    it('allows uses strictly below the max, defaulting to zero used', () => {
        expect(isCaveatSatisfied('max_uses = 3', { currentUses: 2 })).toBe(true);
        expect(isCaveatSatisfied('max_uses = 3', { currentUses: 3 })).toBe(false);
        expect(isCaveatSatisfied('max_uses = 3', { currentUses: 4 })).toBe(false);
        expect(isCaveatSatisfied('max_uses = 3', {})).toBe(true);
    });

    it('compares payment hashes without leaking length mismatches', () => {
        const hash = 'ab'.repeat(32);

        expect(isCaveatSatisfied(`payment_hash = ${hash}`, { paymentHash: hash })).toBe(true);
        expect(isCaveatSatisfied(`payment_hash = ${hash}`, { paymentHash: 'cd'.repeat(32) })).toBe(false);
        expect(isCaveatSatisfied(`payment_hash = ${hash}`, { paymentHash: 'abcd' })).toBe(false);
        expect(isCaveatSatisfied(`payment_hash = ${hash}`, {})).toBe(false);
    });

    it('rejects unknown caveat types and throws on a malformed condition', () => {
        expect(isCaveatSatisfied('unsupported = whatever', { did: 'did:cid:abc' })).toBe(false);
        expect(() => isCaveatSatisfied('no-equals-sign', {})).toThrow('Invalid caveat format');
    });
});

describe('createMacaroon', () => {
    it('issues a macaroon with a random id and the caveats attached', () => {
        const first = createMacaroon(secret, location, { did: 'did:cid:abc' });
        const second = createMacaroon(secret, location, { did: 'did:cid:abc' });

        expect(first.id).toMatch(/^[0-9a-f]{32}$/);
        expect(first.id).not.toBe(second.id);
        expect(getMacaroonId(first.macaroon)).toBe(first.id);
    });

    it('rejects caveat sets that could never be satisfied', () => {
        expect(() => createMacaroon(secret, location, { expiry: 0 })).toThrow(InvalidMacaroonError);
        expect(() => createMacaroon(secret, location, { expiry: -1 })).toThrow(InvalidMacaroonError);
        expect(() => createMacaroon(secret, location, { maxUses: 0 })).toThrow(InvalidMacaroonError);
        expect(() => createMacaroon(secret, location, { maxUses: -2 })).toThrow(InvalidMacaroonError);
        expect(() => createMacaroon(secret, location, { scope: [] })).toThrow(InvalidMacaroonError);
    });
});

describe('macaroon parsing failures', () => {
    it('reports a malformed macaroon as InvalidMacaroonError', () => {
        expect(() => extractCaveats('not-a-macaroon')).toThrow(InvalidMacaroonError);
        expect(() => getMacaroonId('not-a-macaroon')).toThrow(InvalidMacaroonError);
        expect(() => verifyMacaroon(secret, 'not-a-macaroon', {})).toThrow(InvalidMacaroonError);
    });
});

describe('verifyMacaroon', () => {
    it('verifies a macaroon whose caveats the context satisfies', () => {
        const token = createMacaroon(secret, location, {
            did: 'did:cid:abc',
            scope: ['resolveDID'],
            expiry: 2000,
        });

        const result = verifyMacaroon(secret, token.macaroon, {
            did: 'did:cid:abc',
            scope: 'resolveDID',
            currentTime: 1999,
        });

        expect(result.valid).toBe(true);
        expect(result.id).toBe(token.id);
        expect(result.caveats.did).toBe('did:cid:abc');
    });

    it('reports invalid when a caveat is unsatisfied', () => {
        const token = createMacaroon(secret, location, { did: 'did:cid:abc', expiry: 2000 });

        const wrongDid = verifyMacaroon(secret, token.macaroon, {
            did: 'did:cid:other',
            currentTime: 1999,
        });
        expect(wrongDid.valid).toBe(false);

        const expired = verifyMacaroon(secret, token.macaroon, {
            did: 'did:cid:abc',
            currentTime: 2001,
        });
        expect(expired.valid).toBe(false);
    });

    it('reports invalid when signed with a different root secret', () => {
        const token = createMacaroon(secret, location, { did: 'did:cid:abc' });

        const result = verifyMacaroon('a-different-secret', token.macaroon, { did: 'did:cid:abc' });

        expect(result.valid).toBe(false);
    });
});

describe('verifyPreimage', () => {
    it('accepts a preimage whose sha256 matches the payment hash', () => {
        const preimage = randomBytes(32).toString('hex');

        expect(verifyPreimage(preimage, hashOf(preimage))).toBe(true);
        expect(verifyPreimage(preimage.toUpperCase(), hashOf(preimage))).toBe(true);
    });

    it('rejects a preimage that hashes to something else', () => {
        const preimage = randomBytes(32).toString('hex');
        const other = randomBytes(32).toString('hex');

        expect(verifyPreimage(preimage, hashOf(other))).toBe(false);
    });

    it('rejects malformed preimages and hashes without hashing them', () => {
        const valid = randomBytes(32).toString('hex');

        expect(verifyPreimage('too-short', hashOf(valid))).toBe(false);
        expect(verifyPreimage('zz'.repeat(32), hashOf(valid))).toBe(false);
        expect(verifyPreimage(valid, 'too-short')).toBe(false);
        expect(verifyPreimage(valid, 'zz'.repeat(32))).toBe(false);
        expect(verifyPreimage('', '')).toBe(false);
    });
});
