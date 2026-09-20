import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';
type Vector = { legacy: boolean; middle: string; did: string; ids: string[]; events: GatekeeperEvent[];
    scenarios: { name: string; expected: number[]; orders: number[][]; components: object; receiptView: object[]; deactivated: boolean }[];
    blocks: { registry: string; block: { height: number; hash: string; time: number } }[] };
const vectors: Vector[] = JSON.parse(readFileSync('tests/convergence/integrated-agent-vectors.json', 'utf8'));
for (const vector of vectors) it.each(vector.scenarios)(`integrates agent transitions ($name, ${vector.middle}, legacy=${vector.legacy})`, async scenario => {
    const results = [];
    for (const order of scenario.orders) {
        const db = new DbMemory('integrated-agent');
        const ipfs = new MemoryClient();
        let gatekeeper = new Gatekeeper({ db, ipfs });
        for (const { registry, block } of vector.blocks) await gatekeeper.addBlock(registry, block);
        for (const index of order) {
            await gatekeeper.importBatch([structuredClone(vector.events[index])]);
            await gatekeeper.processEvents();
        }
        for (const phase of ['initial', 'repeat', 'restart']) {
            if (phase === 'repeat') {
                await gatekeeper.importBatch(order.slice().reverse().map(index => structuredClone(vector.events[index])));
                await gatekeeper.processEvents();
            }
            if (phase === 'restart') gatekeeper = new Gatekeeper({ db, ipfs });
            const resolved = await gatekeeper.resolveDID(vector.did, { verify: true });
            const history = await db.getEvents(vector.did);
            let expected = history[0].operation.registration!.registry;
            const receiptView = [];
            for (const [index, event] of history.entries()) {
                const matching = event.registry === expected;
                if (index && !matching) break;
                const chain = !['local', 'hyperswarm', 'pin'].includes(event.registry);
                receiptView.push({ operation: event.opid, matching, cutoff: !matching
                    ? { kind: 'unconfirmed' } : chain
                        ? { kind: 'chain', registry: event.registry, ordinal: event.ordinal,
                            time: Date.parse(event.time), registration: !!event.registration }
                        : { kind: 'unanchored', registry: event.registry, time: Date.parse(event.time) } });
                expected = event.operation.doc?.didDocumentRegistration?.registry ?? expected;
            }
            expect(receiptView).toEqual(scenario.receiptView);
            expect(history.map(event => event.opid)).toEqual(scenario.expected.map(index => vector.ids[index]));
            expect({ didDocument: resolved.didDocument, didDocumentData: resolved.didDocumentData,
                didDocumentRegistration: resolved.didDocumentRegistration }).toEqual(scenario.components);
            expect(!!resolved.didDocumentMetadata?.deactivated).toBe(scenario.deactivated);
            results.push({ doc: resolved.didDocument, data: resolved.didDocumentData,
                registration: resolved.didDocumentRegistration, deactivated: resolved.didDocumentMetadata?.deactivated });
        }
    }
    for (const result of results) expect(result).toEqual(results[0]);
}, 60000);
