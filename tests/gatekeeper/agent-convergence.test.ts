import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { Operation, GatekeeperEvent } from '@didcid/gatekeeper/types';

type Vector = { legacy: boolean; did: string; operations: Operation[]; ids: string[]; keys: unknown[];
    scenarios: { name: string; orders: number[][]; expected: number[]; finalState: number | 'deleted' }[] };
const vectors: Vector[] = JSON.parse(readFileSync('tests/convergence/agent-vectors.json', 'utf8'));
for (const vector of vectors) {
    it.each(vector.scenarios)(`agent authorization converges (legacy=${vector.legacy}): $name`, async scenario => {
        for (const order of scenario.orders) {
            const db = new DbMemory('agent-authorization');
            const ipfs = new MemoryClient();
            let gatekeeper = new Gatekeeper({ db, ipfs });
            const events = order.map((index, receipt): GatekeeperEvent => ({
                operation: vector.operations[index], registry: 'hyperswarm',
                time: vector.operations[index].proof!.created, ordinal: [receipt, 0],
            }));
            for (const event of events) {
                await gatekeeper.importBatch([event]);
                await gatekeeper.processEvents();
            }
            for (const phase of ['initial', 'repeat', 'restart']) {
                if (phase === 'repeat') {
                    await gatekeeper.importBatch(events.slice().reverse());
                    await gatekeeper.processEvents();
                }
                if (phase === 'restart') gatekeeper = new Gatekeeper({ db, ipfs });
                const doc = await gatekeeper.resolveDID(vector.did, { verify: true });
                const path = (await db.getEvents(vector.did)).map(event => vector.ids.indexOf(event.opid!));
                expect({ order, phase, path }).toEqual({ order, phase, path: scenario.expected });
                expect(doc.didDocumentMetadata?.versionId).toBe(vector.ids[scenario.expected.at(-1)!]);
                if (scenario.finalState === 'deleted') expect(doc.didDocumentMetadata?.deactivated).toBe(true);
                else expect(doc.didDocument?.verificationMethod?.[0].publicKeyJwk).toEqual(vector.keys[scenario.finalState]);
            }
        }
    }, 60000);
}
