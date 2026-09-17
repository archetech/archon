import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import Db from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { Operation, GatekeeperEvent } from '@didcid/gatekeeper/types';

// Historical acceptance fixtures, not the proposed stricter registration policy.
const vector = JSON.parse(readFileSync('tests/gatekeeper/registration-transition-v1-vectors.json', 'utf8')) as {
    agent: Operation; did: string; unsupportedGenesis: Operation;
    cases: { name: string; operation: Operation; accepted: boolean; expectedRegistration: Record<string, unknown> }[];
};
const event = (operation: Operation): GatekeeperEvent => ({ operation, registry: 'hyperswarm', time: operation.proof!.created });

it.each(vector.cases)('preserves v1 $name across submission, import, and restart', async ({ operation, accepted, expectedRegistration }) => {
    for (const direct of [true, false]) {
        const db = new Db('registration-v1');
        const ipfs = new MemoryClient();
        let g = new Gatekeeper({ db, ipfs });
        if (direct) {
            await g.createDID(vector.agent);
            expect(await g.updateDID(operation)).toBe(accepted);
        } else {
            await g.importEvent(event(vector.agent));
            expect(await g.importEvent(event(operation))).toBe(accepted ? 'added' : 'rejected');
        }
        for (const restart of [false, true]) {
            if (restart) g = new Gatekeeper({ db, ipfs });
            for (const verify of [false, true]) {
                const doc = await g.resolveDID(vector.did, { verify });
                expect(doc.didDocument?.id).toBe(vector.did);
                expect(doc.didDocumentRegistration).toEqual(expectedRegistration);
                expect(doc.didDocumentMetadata?.versionSequence).toBe(accepted ? '2' : '1');
            }
        }
    }
});

it('does not activate version 2 genesis', async () => {
    const db = new Db('registration-v2-disabled');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    await expect(g.createDID(vector.unsupportedGenesis)).rejects.toThrow('registration.version=2');
    expect(await g.importEvent(event(vector.unsupportedGenesis))).toBe('rejected');
    expect(await db.getAllKeys()).toEqual([]);
});
