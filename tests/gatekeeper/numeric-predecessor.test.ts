import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import Db from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';

// Pin existing TS behavior: this Rust interoperability repair does not migrate IDs.
it('preserves TypeScript CIDs used by the Rust numeric-predecessor fixture', async () => {
    const vector = JSON.parse(readFileSync('tests/gatekeeper/numeric-predecessor-vectors.json', 'utf8'));
    const g = new Gatekeeper({ db: new Db('numeric-predecessor'), ipfs: new MemoryClient() });
    for (const name of ['agent', 'update', 'successor']) {
        expect(await g.generateCID(vector[name])).toBe(vector.cids[name].typescript);
        expect(await g.generateCID(vector[name], true)).toBe(vector.cids[name].typescript);
    }
    expect(await g.generateDID(vector.agent)).toBe(vector.did);
    expect(vector.cids.update.rust).not.toBe(vector.cids.update.typescript);
});
