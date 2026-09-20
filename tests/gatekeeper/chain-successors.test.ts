import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent, Operation } from '@didcid/gatekeeper/types';

type Block = { height: number; hash: string; time: number };
type Vector = { blocks?: { registry: string; block: Block }[]; expectedEvents?: number[]; expectedRegistry?: string; states?: (number | 'deleted' | null)[]; legacy: boolean; mode: string; did: string; operations: Operation[]; ids: string[]; expected: number[]; events: GatekeeperEvent[]; orders: number[][]; block: { height: number; hash: string; time: number } };
const vectors: Vector[] = ['chain-successor-vectors', 'chain-document-vectors', 'migration-vectors', 'tied-anchor-vectors'].flatMap(name => JSON.parse(readFileSync(`tests/convergence/${name}.json`, 'utf8')));
it.each(vectors)('settles competing branches ($mode, legacy=$legacy)', async vector => {
    for (const order of vector.orders) {
        const db = new DbMemory('chain-successors');
        const ipfs = new MemoryClient();
        let gatekeeper = new Gatekeeper({ db, ipfs });
        for (const { registry, block } of vector.blocks ?? [{ registry: 'BTC:signet', block: vector.block }]) {
            await gatekeeper.addBlock(registry, block);
        }
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
            if (vector.expectedEvents) {
                const expectedEvents = vector.expectedEvents.map((token, i) => ({ ...vector.events[token], did: vector.did, opid: vector.ids[vector.expected[i]] }));
                expect(JSON.parse(JSON.stringify(events))).toEqual(expectedEvents);
                expect(doc.didDocumentRegistration?.registry).toBe(vector.expectedRegistry);
            }
            const last = vector.expected.at(-1)!;
            if (vector.operations[last].type === 'delete') {
                expect(doc.didDocumentMetadata?.deactivated).toBe(true);
                expect(doc.didDocumentData).toEqual({});
            } else {
                expect(doc.didDocumentMetadata?.deactivated).not.toBe(true);
                expect(doc.didDocumentData).toEqual(vector.operations[last].doc!.didDocumentData);
                if (vector.states) {
                    const active = vector.states[last] as number;
                    const operation = vector.operations[vector.ids.indexOf([...vector.ids].sort()[active])];
                    expect(doc.didDocument?.verificationMethod).toEqual(operation.doc!.didDocument!.verificationMethod);
                }
            }
            expect((await db.getCandidates())[vector.did]).toHaveLength(vector.events.length);
        }
    }
}, 30000);
