import { readFileSync } from 'node:fs';
import { createEvents } from '../../services/mediators/hyperswarm/src/events.js';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent, Operation } from '@didcid/gatekeeper/types';

type Vector = { legacy: boolean; controller: string; asset: string } & Record<
    'leapRotation' | 'agent' | 'assetCreate' | 'assetUpdate' | 'assetDelete' | 'lateAssetDelete' | 'controllerDelete' | 'controllerRotation' | 'afterRotation' | 'backdatedSuccessor', Operation>;
const vectors: Vector[] = JSON.parse(readFileSync('tests/gatekeeper/hyperswarm-time-vectors.json', 'utf8'));
const receipts = ['2026-09-04T00:51:32.083Z', '2026-09-17T17:53:05.466Z'];
const event = (operation: Operation, time: string): GatekeeperEvent => ({ operation, registry: 'hyperswarm', time });

it.each(vectors.flatMap(v => ['deletion', 'rotation', 'late-deletion'].map(scenario => ({ ...v, scenario }))))(
    '$scenario authorization uses proof time (legacy=$legacy)', async v => {
        for (const time of receipts) for (const order of ['controller-first', 'asset-first', 'reverse', 'direct']) {
            const db = new DbMemory('proof-time');
            const ipfs = new MemoryClient();
            let g = new Gatekeeper({ db, ipfs });
            const controllerOps = [v.agent, v.scenario === 'rotation' ? v.controllerRotation : v.controllerDelete];
            const assetOps = [v.assetCreate, v.assetUpdate, v.scenario === 'deletion' ? v.assetDelete : v.scenario === 'rotation' ? v.afterRotation : v.lateAssetDelete];
            if (order === 'direct') {
                for (const op of controllerOps) await g.importEvent(event(op, time));
                expect(await g.createDID(v.assetCreate)).toBe(v.asset);
                for (const op of assetOps.slice(1)) expect(await g.updateDID(op)).toBe(op !== v.lateAssetDelete);
                // Gossip confirms the locally submitted operations on Hyperswarm.
                for (const op of assetOps) await g.importEvent(event(op, time));
            } else {
                const ops = order === 'controller-first' ? [...controllerOps, ...assetOps]
                    : order === 'asset-first' ? [...assetOps, ...controllerOps] : [...controllerOps, ...assetOps].reverse();
                for (const op of ops) await g.importEvent(event(op, time));
            }
            for (const restart of [false, true]) {
                if (restart) g = new Gatekeeper({ db, ipfs });
                for (const verify of [false, true]) {
                    for (const [cutoff, sequence] of [['2026-09-04T00:51:32.806Z', '1'], ['2026-09-04T00:51:32.807Z', '2'], ['2026-09-03T20:51:32.807-04:00', '2']]) {
                        const doc = await g.resolveDID(v.controller, { versionTime: cutoff, verify, confirm: true });
                        expect(doc.didDocumentMetadata?.versionSequence).toBe(sequence);
                        expect(!!doc.didDocumentMetadata?.deactivated).toBe(sequence === '2' && v.scenario !== 'rotation');
                    }
                    const historical = await g.resolveDID(v.asset, { versionTime: '2026-09-04T00:51:32.400Z', verify, confirm: true });
                    expect(historical.didDocumentMetadata?.versionSequence).toBe('2');
                    expect(historical.didDocumentMetadata?.updated).toBe('2026-09-04T00:51:32Z');
                    const latest = await g.resolveDID(v.asset, { verify, confirm: true });
                    expect(latest.didDocumentMetadata?.versionSequence).toBe(v.scenario === 'late-deletion' ? '2' : '3');
                    expect(!!latest.didDocumentMetadata?.deactivated).toBe(v.scenario === 'deletion');
                    if (v.scenario === 'deletion') expect(latest.didDocumentMetadata?.deleted).toBe('2026-09-04T00:51:32Z');
                    else expect(latest.didDocumentData).toEqual({ state: v.scenario === 'rotation' ? 'rotated' : 'updated' });
                }
            }
            // Imported envelopes are corrected before they become durable history.
            expect((await db.getEvents(v.controller)).map(e => e.time)).toEqual(controllerOps.map(op => op.proof!.created));
        }
    }, 20000,
);

it.each(vectors)('keeps predecessor order when proof times decrease (legacy=$legacy)', async v => {
    const g = new Gatekeeper({ db: new DbMemory('proof-prefix'), ipfs: new MemoryClient() });
    for (const op of [v.backdatedSuccessor, v.controllerRotation, v.agent]) await g.importEvent(event(op, receipts[0]));
    for (const verify of [false, true]) {
        const before = await g.resolveDID(v.controller, { versionTime: '2026-09-04T00:51:32.600Z', verify });
        expect(before.didDocumentMetadata?.versionSequence).toBe('1');
        const after = await g.resolveDID(v.controller, { versionTime: '2026-09-04T00:51:32.807Z', verify });
        expect(after.didDocumentMetadata?.versionSequence).toBe('3');
        expect(after.didDocumentData).toEqual({ state: 'backdated' });
    }
});

it.each(['local', 'hyperswarm', 'BTC:signet'])('resolution consumes stored event time for %s', async registry => {
    const v = vectors[0];
    const db = new DbMemory('other-registry');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    await g.resolveDID(v.controller); // Initialize before installing this projection.
    const events = await Promise.all([v.agent, v.controllerRotation].map(async operation => ({
        operation, registry, time: receipts[1], opid: await g.generateCID(operation),
    })));
    await db.setEvents(v.controller, events);
    for (const verify of [false, true]) {
        expect((await g.resolveDID(v.controller, { versionTime: '2026-09-04T00:51:33Z', verify })).didDocumentMetadata?.versionSequence).toBe('1');
        const later = await g.resolveDID(v.controller, { versionTime: '2026-09-18T00:00:00Z', verify });
        expect(later.didDocumentMetadata?.versionSequence).toBe('2');
        expect(later.didDocumentMetadata?.updated).toBe('2026-09-17T17:53:05Z');
    }
});

it.each(vectors)('accepts the existing RFC 3339 leap-second proof grammar (legacy=$legacy)', async v => {
    const g = new Gatekeeper({ db: new DbMemory('proof-leap'), ipfs: new MemoryClient() });
    for (const op of [v.agent, v.leapRotation]) expect(await g.importEvent(event(op, receipts[1]))).toBe('added');
    for (const verify of [false, true]) {
        expect((await g.resolveDID(v.controller, { versionTime: '2026-09-04T00:51:59.999Z', verify })).didDocumentMetadata?.versionSequence).toBe('1');
        const doc = await g.resolveDID(v.controller, { versionTime: '2026-09-04T00:52:00Z', verify });
        expect(doc.didDocumentMetadata?.versionSequence).toBe('2');
        expect(doc.didDocumentMetadata?.updated).toBe('2026-09-04T00:51:60Z');
    }
});

// The producer must supply correct times even when connected to an older Gatekeeper.
it('constructs gossip events using proof times, retaining receipt ordinals', () => {
    const ops = [vectors[0].agent, vectors[0].controllerDelete];
    const events = createEvents(ops);
    expect(events.map(e => e.time)).toEqual(ops.map(op => op.proof!.created));
    expect(events.map(e => e.ordinal?.[1])).toEqual([0, 1]);
    expect(events[0].ordinal?.[0]).toBe(events[1].ordinal?.[0]);
    expect(events.map(e => e.operation)).toEqual(ops);
});

it.each(vectors)('repairs persisted candidates and accepts old HTTP envelopes (legacy=$legacy)', async v => {
    const db = new DbMemory('old-hyperswarm');
    const ipfs = new MemoryClient();
    let g = new Gatekeeper({ db, ipfs });
    const ops = [v.agent, v.controllerDelete];
    const old = await Promise.all(ops.map(async op => ({ ...event(op, receipts[0]), did: v.controller, opid: await g.generateCID(op), ordinal: [42] })));
    await db.setEvents(v.controller, old);
    await db.setCandidates(v.controller, old);
    const imported = [v.assetCreate, v.assetUpdate, v.assetDelete].map(op => ({
        ...event(op, receipts[1]), registry: 'BTC:signet', registration: { height: 42 },
    }));
    await g.importDIDs([imported]);
    await g.processEvents();
    expect((await g.resolveDID(v.asset)).didDocumentMetadata?.deactivated).toBe(true);
    // A repeat from an old peer must neither restore receipt time nor duplicate evidence.
    await g.importDIDs([old]);
    await g.processEvents();
    g = new Gatekeeper({ db, ipfs });
    await g.resolveDID(v.controller);
    const candidates = (await db.getCandidates())[v.controller];
    expect(candidates).toHaveLength(2);
    expect(candidates.map(e => e.time)).toEqual(ops.map(op => op.proof!.created));
    expect(candidates.map(e => e.ordinal)).toEqual([[42], [42]]);
    expect(candidates.map(e => e.operation)).toEqual(ops);
    expect((await db.getEvents(v.controller)).map(e => e.time)).toEqual(ops.map(op => op.proof!.created));
});

it('imports existing microsecond proof timestamps and compares equivalent instants', async () => {
    const v = vectors.find(v => v.legacy)!;
    // Legacy proof configuration is unsigned; this exercises the production format.
    const rotation = JSON.parse(JSON.stringify(v.controllerRotation));
    rotation.proof.created = '2026-09-04T00:51:32.807411Z';
    const g = new Gatekeeper({ db: new DbMemory('microsecond-time'), ipfs: new MemoryClient() });
    for (const op of [v.agent, rotation]) expect(await g.importEvent(event(op, receipts[0]))).toBe('added');
    for (const [cutoff, sequence] of [['2026-09-04T00:51:32.806999Z', '1'], ['2026-09-04T00:51:32.807Z', '2'], ['2026-09-03T20:51:32.807-04:00', '2']]) {
        expect((await g.resolveDID(v.controller, { versionTime: cutoff })).didDocumentMetadata?.versionSequence).toBe(sequence);
    }
});
