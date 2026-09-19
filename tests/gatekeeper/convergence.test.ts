import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import Cipher from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent, Operation } from '@didcid/gatekeeper/types';
import { project, permutations } from '../convergence/model.mjs';

type Vector = { name: string; registry: string; transport: string; receipts: string; did: string; operations: Operation[]; ids: string[];
    cases: { order: number[]; expected: number[] }[] };
type ControllerFork = { legacy: boolean; controller: string; asset: string; operations: Operation[]; ids: string[]; orders: number[][]; controllerPath: number[]; assetPath: number[] };
const fixture: { histories: Vector[]; scenarios: Vector[]; controllerForks: ControllerFork[] } = JSON.parse(readFileSync('tests/convergence/vectors.json', 'utf8'));
const vectors: Vector[] = fixture.scenarios.map((scenario: Vector) => ({
    ...fixture.histories.find((history: Vector) => history.registry === scenario.registry), ...scenario,
}));

it.each(vectors)('converges to the canonical projection: $name', async v => {
    const outcomes = new Set<string>();
    const inputs = v.cases[0].order;
    expect(v.cases.map(c => c.order)).toEqual(permutations(inputs));
    for (const { order, expected } of v.cases) {
        const graph = v.operations.map(op => ({ type: op.type, parent: op.previd ? v.ids.indexOf(op.previd) : undefined }));
        const priority = v.transport === 'BTC:signet' ? inputs : inputs.slice().sort((a, b) => v.ids[a] < v.ids[b] ? -1 : 1);
        expect(expected).toEqual(project(graph, priority));
        const db = new DbMemory('convergence');
        const ipfs = new MemoryClient();
        let g = new Gatekeeper({ db, ipfs });
        const events = order.map((index, receipt): GatekeeperEvent => ({
            operation: v.operations[index], registry: v.transport === 'foreign-anchor' ? (index === 2 ? 'BTC:signet' : 'local') : ['mixed', 'pin-mixed'].includes(v.transport) ? (index % 2 ? (v.transport === 'pin-mixed' ? 'pin' : 'hyperswarm') : 'local') : v.transport,
            time: v.operations[index].proof!.created,
            ordinal: [1000 + (v.receipts === 'fresh' ? receipt : v.receipts === 'tied' ? 0 : index), 0],
            ...(v.transport !== 'BTC:signet' && !(v.transport === 'foreign-anchor' && index === 2) ? {} : { registration: { height: 1000 + index, txid: `tx${index}`, batch: 'batch', opidx: 0 } }),
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
            const doc = await g.resolveDID(v.did, { verify: true });
            const path = (await db.getEvents(v.did)).map(e => v.ids.indexOf(e.opid!));
            expect({ order, phase, path }).toEqual({ order, phase, path: expected });
            expect(doc.didDocumentMetadata?.versionId).toBe(v.ids[expected.at(-1)!]);
            expect(doc.didDocumentData).toEqual(v.operations[expected.at(-1)!].doc!.didDocumentData);
            expect((await db.getCandidates())[v.did]).toHaveLength(order.length);
            const confirmedPath = [expected[0]];
            for (const index of expected.slice(1)) {
                if (events.find(e => e.operation === v.operations[index])!.registry !== v.registry) break;
                confirmedPath.push(index);
            }
            const confirmed = await g.resolveDID(v.did, { verify: true, confirm: true });
            expect(confirmed.didDocumentMetadata?.versionId).toBe(v.ids[confirmedPath.at(-1)!]);
            outcomes.add(path.join(','));
        }
    }
    expect(outcomes.size).toBe(1);
}, 30000);

it.each(fixture.controllerForks)('replays asset authorization after a preferred controller branch (legacy=$legacy)', async v => {
    for (const order of v.orders) {
        const db = new DbMemory('controller-convergence');
        const ipfs = new MemoryClient();
        let g = new Gatekeeper({ db, ipfs });
        for (const [receipt, index] of order.entries()) {
            const operation = v.operations[index];
            await g.importBatch([{ operation, registry: 'hyperswarm', time: operation.proof!.created, ordinal: [receipt, 0] }]);
            await g.processEvents();
        }
        for (const restart of [false, true]) {
            if (restart) g = new Gatekeeper({ db, ipfs });
            for (const [did, path] of [[v.controller, v.controllerPath], [v.asset, v.assetPath]] as [string, number[]][]) {
                const doc = await g.resolveDID(did, { verify: true, confirm: true });
                expect((await db.getEvents(did)).map(e => v.ids.indexOf(e.opid!))).toEqual(path);
                expect(doc.didDocumentMetadata?.versionId).toBe(v.ids[path.at(-1)!]);
            }
            expect((await db.getCandidates())[v.asset]).toHaveLength(3);
            expect((await db.getCandidates())[v.controller]).toHaveLength(3);
        }
    }
}, 30000);

// The same signed operations, with distinct receipts for a single canonical ID.
type RecordCase = { name: string;
    events: { operation: number; registry: string; ordinal: number[] }[];
    initial: number[]; expected: number[]; replayPasses: number[][] };
const recordCases: { registry: string; cases: RecordCase[]; replayCases: RecordCase[] } = JSON.parse(readFileSync('tests/convergence/record-cases.json', 'utf8'));

it.each([...recordCases.cases, ...recordCases.replayCases])('settles full event records: $name', async c => {
    const v = fixture.histories.find(h => h.registry === recordCases.registry)!;
    const db = new DbMemory('record-convergence');
    const ipfs = new MemoryClient();
    let g = new Gatekeeper({ db, ipfs });
    const events: GatekeeperEvent[] = c.events.map(e => ({
        operation: v.operations[e.operation], registry: e.registry, ordinal: e.ordinal,
        time: v.operations[e.operation].proof!.created, opid: v.ids[e.operation], did: v.did,
    }));
    for (const [index, event] of events.entries()) {
        await g.importBatch([structuredClone(event)]);
        await g.processEvents();
        if (index === c.initial.length - 1) {
            expect(await db.getEvents(v.did)).toEqual(c.initial.map(i => events[i]));
        }
    }
    const expected = c.expected.map(i => events[i]);
    expect(await db.getEvents(v.did)).toEqual(expected);
    await g.importBatch(structuredClone(events).reverse());
    await g.processEvents();
    expect(await db.getEvents(v.did)).toEqual(expected);
    g = new Gatekeeper({ db, ipfs });
    await g.resolveDID(v.did, { verify: true });
    expect(await db.getEvents(v.did)).toEqual(expected);
});

const passCases = [...recordCases.cases, ...recordCases.replayCases].flatMap(c => [
    { ...c, phase: 'cold', seed: [], passes: c.replayPasses },
    ...(recordCases.cases.includes(c) ? [{ ...c, phase: 'warm', seed: c.initial, passes: [c.expected] }] : []),
]);

it.each(passCases)('matches Lean-checked replay passes and serialized stopping: $name ($phase)', async c => {
    const v = fixture.histories.find(h => h.registry === recordCases.registry)!;
    const db = new DbMemory('replay-pass-bridge');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    const cipher = new Cipher();
    await g.getDIDs();
    const events: GatekeeperEvent[] = c.events.map(e => ({
        operation: v.operations[e.operation], registry: e.registry, ordinal: e.ordinal,
        time: v.operations[e.operation].proof!.created, opid: v.ids[e.operation], did: v.did,
    }));
    // Call the exact routine used inside rebuildHistories, without adding ingress
    // reconciliation between candidates. The public import/restart tests remain above.
    const replay = g as unknown as { importEventOnce(event: GatekeeperEvent): Promise<unknown> };
    for (const index of c.seed) await replay.importEventOnce(structuredClone(events[index]));
    expect(await db.getEvents(v.did)).toEqual(c.seed.map(i => events[i]));
    // Compare JSON values, not JavaScript prototypes (structuredClone crosses
    // Jest VM realms); undefined omission is part of the wire representation.
    const snapshot = async (): Promise<GatekeeperEvent[]> => JSON.parse(JSON.stringify(await db.getEvents(v.did)));
    let stopped = false;
    for (const expected of [...c.passes, c.expected]) {
        const before = await snapshot();
        const previous = cipher.canonicalizeJSON(before);
        expect(JSON.parse(previous)).toEqual(before);
        for (const event of events) await replay.importEventOnce(structuredClone(event));
        const after = await snapshot();
        expect(after).toEqual(expected.map(i => events[i]));
        const serialized = cipher.canonicalizeJSON(after);
        expect(JSON.parse(serialized)).toEqual(after);
        // Check both false early stops and failure to notice a full-record fixed point.
        expect(serialized === previous).toBe(isDeepStrictEqual(after, before));
        if (serialized === previous) {
            stopped = true;
            break;
        }
    }
    expect(stopped).toBe(true);
    expect(await db.getEvents(v.did)).toEqual(c.expected.map(i => events[i]));
});
