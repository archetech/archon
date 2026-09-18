import { readFileSync } from 'node:fs';
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
            // Resolution does not rewrite stored receipt evidence.
            expect((await db.getEvents(v.controller)).map(e => e.time)).toEqual([time, time]);
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

it.each(['local', 'BTC:signet'])('retains event-time selection for %s', async registry => {
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
