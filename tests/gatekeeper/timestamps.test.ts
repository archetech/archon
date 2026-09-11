import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import vectors from './timestamp-vectors.json' with { type: 'json' };

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
