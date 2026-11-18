import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import { generateCID } from '@didcid/ipfs/utils';
import MemoryClient from '@didcid/ipfs/memory';
import type { Operation, GatekeeperEvent } from '@didcid/gatekeeper/types';

class Db extends DbMemory {
    snapshot() { return this.loadDb(); }
}

// Shared signed vectors hold both ports to one rule for an update's components,
// wherever the update arrives: it supplies at least one, and none is null.
const vector = JSON.parse(readFileSync('tests/gatekeeper/update-component-v1-vectors.json', 'utf8')) as {
    agent: Operation; did: string;
    cases: { name: string; operation: Operation; accepted: boolean; expectedData: unknown }[];
};
const { agent, did } = vector;
const event = (operation: Operation): GatekeeperEvent => ({ operation, registry: 'hyperswarm', time: operation.proof!.created });

it('covers accepted and rejected updates', () => {
    expect(vector.cases.filter(item => item.accepted).length).toBeGreaterThan(5);
    expect(vector.cases.filter(item => !item.accepted).length).toBeGreaterThan(5);
});

it.each(vector.cases)('applies one rule to $name on submission, import and restart', async ({ operation, accepted, expectedData }) => {
    for (const mode of ['direct', 'import', 'replay']) {
        const db = new Db('update-components');
        const ipfs = new MemoryClient();
        let g = new Gatekeeper({ db, ipfs, registries: ['hyperswarm'] });
        if (mode === 'direct') {
            await g.createDID(agent);
            const before = JSON.stringify(db.snapshot());
            const submitted = await g.updateDID(operation).catch(() => false);
            expect(submitted).toBe(accepted);
            if (!accepted) expect(JSON.stringify(db.snapshot())).toBe(before);
        } else if (mode === 'import') {
            await g.importEvent(event(agent));
            expect(await g.importEvent(event(operation))).toBe(accepted ? 'added' : 'rejected');
        } else {
            // A projection written before the rule applied on every path.
            const events = await Promise.all([agent, operation].map(async op => ({ ...event(op), opid: await generateCID(op) })));
            await db.setEvents(did, events);
            await db.setCandidates(did, events);
        }
        for (const restart of [false, true]) {
            if (restart) g = new Gatekeeper({ db, ipfs, registries: ['hyperswarm'] });
            for (const verify of [false, true]) {
                const doc = await g.resolveDID(did, { verify });
                expect(doc.didDocument?.id).toBe(did);
                expect(doc.didDocumentData).toStrictEqual(expectedData);
                expect(doc.didDocumentMetadata?.versionSequence).toBe(String(accepted ? 2 : 1));
            }
        }
    }
});
