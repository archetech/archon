import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent, Operation } from '@didcid/gatekeeper/types';

type Vector = { legacy: boolean; mode: string; did: string; operations: Operation[]; ids: string[]; expected: number[]; events: GatekeeperEvent[]; orders: number[][]; block: { height: number; hash: string; time: number } };
const vectors: Vector[] = JSON.parse(readFileSync('tests/convergence/chain-successor-vectors.json', 'utf8'));
it.each(vectors)('settles competing branches ($mode, legacy=$legacy)', async vector => {
    for (const order of vector.orders) {
        const db = new DbMemory('chain-successors');
        const ipfs = new MemoryClient();
        let gatekeeper = new Gatekeeper({ db, ipfs });
        await gatekeeper.addBlock('BTC:signet', vector.block);
        for (const token of order) {
            await gatekeeper.importBatch([structuredClone(vector.events[token])]);
            await gatekeeper.processEvents();
        }
        for (const phase of ['initial', 'repeat', 'restart']) {
            if (phase === 'repeat') {
                await gatekeeper.importBatch(structuredClone(vector.events.slice().reverse()));
                await gatekeeper.processEvents();
            }
            if (phase === 'restart') gatekeeper = new Gatekeeper({ db, ipfs });
            const doc = await gatekeeper.resolveDID(vector.did, { verify: true });
            const events = await db.getEvents(vector.did);
            expect({ order, phase, ids: events.map(e => e.opid) }).toEqual({ order, phase, ids: vector.expected.map(i => vector.ids[i]) });
            expect(doc.didDocumentData).toEqual(vector.operations[vector.expected.at(-1)!].doc!.didDocumentData);
            expect((await db.getCandidates())[vector.did]).toHaveLength(vector.events.length);
        }
    }
}, 30000);
