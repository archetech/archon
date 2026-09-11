import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import vectors from './timestamp-vectors.json' with { type: 'json' };
import proofVectors from './proof-vectors.json' with { type: 'json' };

const db = new DbJsonMemory('test');
const ipfs = new MemoryClient();
const gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local'] });

// The Rust port checks the same file, so a change here has to be made in both
// ports or one of the two suites fails.
describe('verifyDateFormat', () => {

    it.each(vectors.vectors.map(vector => [vector.value, vector.valid, vector.note ?? '']))(
        'should %s be %s (%s)',
        (value, valid) => {
            expect(gatekeeper.verifyDateFormat(value as string)).toBe(valid);
        }
    );

    it('should reject a missing timestamp', () => {
        expect(gatekeeper.verifyDateFormat(undefined)).toBe(false);
    });
});

// registration.validUntil is checked before the signature is, so the signed
// vector can carry a bad value without being re-signed. Adding the member does
// invalidate the signature, so a value that passes the check returns false
// rather than true -- what is under test is which error is raised, not the
// verdict.
describe('registration.validUntil', () => {

    async function errorFor(validUntil: unknown): Promise<string | null> {
        const operation = JSON.parse(JSON.stringify(proofVectors.agentCreateValid.operation));
        operation.registration.validUntil = validUntil;

        try {
            await gatekeeper.verifyCreateOperation(operation);
            return null;
        }
        catch (error) {
            return (error as Error).message;
        }
    }

    it('should pass a valid timestamp through', async () => {
        expect(await errorFor('2026-12-31T00:00:00Z')).toBeNull();
    });

    it('should reject a bare date', async () => {
        expect(await errorFor('2026-12-31')).toContain('registration.validUntil');
    });

    // The Rust port reads this member with `as_str()`, so the empty string
    // reaches its parser and is rejected. A truthiness guard here would not.
    it('should reject an empty string', async () => {
        expect(await errorFor('')).toContain('registration.validUntil');
    });

    // `as_str()` yields None for a non-string, which the Rust port skips.
    it('should pass a value that is not a string through', async () => {
        expect(await errorFor(null)).toBeNull();
    });
});
