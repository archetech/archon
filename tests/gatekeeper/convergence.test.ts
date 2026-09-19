import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent, Operation } from '@didcid/gatekeeper/types';
import { project, permutations } from '../convergence/model.mjs';

type Vector = { name: string; registry: string; receipts: string; did: string; operations: Operation[]; ids: string[];
    cases: { order: number[]; expected: number[] }[] };
const vectors: Vector[] = JSON.parse(readFileSync('tests/convergence/vectors.json', 'utf8'));

it.each(vectors)('convergence model and counterexamples: $name', async v => {
    const outcomes = new Set<string>();
    const inputs = v.cases[0].order;
    if (v.receipts !== 'tied') expect(v.cases.map(c => c.order)).toEqual(permutations(inputs));
    for (const { order, expected } of v.cases) {
        const graph = v.operations.map(op => ({ type: op.type, parent: op.previd ? v.ids.indexOf(op.previd) : undefined }));
        if (v.receipts !== 'tied') expect(expected).toEqual(project(graph, v.receipts === 'fixed' ? inputs : order));
        const db = new DbMemory('convergence');
        const ipfs = new MemoryClient();
        let g = new Gatekeeper({ db, ipfs });
        const events = order.map((index, receipt): GatekeeperEvent => ({
            operation: v.operations[index], registry: v.registry,
            time: v.registry === 'hyperswarm' ? '2026-09-10T00:00:00Z' : v.operations[index].proof!.created,
            ordinal: [1000 + (v.receipts === 'fresh' ? receipt : v.receipts === 'tied' ? 0 : index), 0],
            ...(v.registry === 'hyperswarm' ? {} : { registration: { height: 1000 + index, txid: `tx${index}`, batch: 'batch', opidx: 0 } }),
        }));
        // Ordinary batch/import processing, including deferred predecessors.
        for (const event of events) {
            await g.importBatch([event]);
            await g.processEvents();
        }
        for (const phase of ['initial', 'repeat', 'restart']) {
            if (phase === 'repeat') {
                await g.importBatch(events.slice().reverse());
                await g.processEvents();
            }
            if (phase === 'restart') g = new Gatekeeper({ db, ipfs });
            const doc = await g.resolveDID(v.did, { verify: true, confirm: true });
            const path = (await db.getEvents(v.did)).map(e => v.ids.indexOf(e.opid!));
            expect({ order, phase, path }).toEqual({ order, phase, path: expected });
            expect(doc.didDocumentMetadata?.versionId).toBe(v.ids[expected.at(-1)!]);
            expect(doc.didDocumentData).toEqual(v.operations[expected.at(-1)!].doc!.didDocumentData);
            expect((await db.getCandidates())[v.did]).toHaveLength(order.length);
            outcomes.add(path.join(','));
        }
    }
    expect([...outcomes].sort()).toEqual(v.name === 'hyperswarm/fresh/fork' || v.name === 'hyperswarm/tied/fork' ? ['0,1,3', '0,2'] : ['0,1,3']);
}, 30000);
