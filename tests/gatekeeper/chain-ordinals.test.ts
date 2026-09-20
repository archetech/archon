import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent, Operation } from '@didcid/gatekeeper/types';

const vectors = JSON.parse(readFileSync('tests/convergence/tied-anchor-vectors.json', 'utf8')) as {
    legacy: boolean; did: string; operations: Operation[]; ids: string[];
}[];
const malformed = [undefined, null, [], Array(1), 7, '7', [null], [null, 1], [-1], [0.5], ['1', 2], [Number.MAX_SAFE_INTEGER + 1]];

it.each(vectors.filter((_, i) => i % 2 === 0))('requires chain positions through import and restart (legacy=$legacy)', async vector => {
    const genesis: GatekeeperEvent = { registry: 'SOL:devnet', time: '2026-09-01T00:00:00Z',
        ordinal: [100, 0, 0], operation: vector.operations[0], opid: vector.ids[0], did: vector.did,
        registration: { height: 100, txid: 'ordinal-audit', batch: vector.did, opidx: 0 } };
    for (const ordinal of malformed) {
        const db = new DbMemory('chain-ordinals');
        const ipfs = new MemoryClient();
        let g = new Gatekeeper({ db, ipfs });
        const invalid = { ...genesis, ordinal } as unknown as GatekeeperEvent;
        expect(await g.verifyEvent(invalid)).toBe(false);
        expect(await g.importBatch([invalid])).toMatchObject({ queued: 0, rejected: 1 });
        expect(await g.importEvent(invalid)).toBe('rejected');
        expect(await db.getEvents(vector.did)).toEqual([]);
        expect((await db.getCandidates())[vector.did]).toBeUndefined();
        await db.addOperation(vector.ids[0], vector.operations[0]);
        await expect(g.importBatchByCids([vector.ids[0]], { ...genesis, ordinal } as never)).rejects.toThrow('metadata');
        // Malformed typed fields were never supported by Rust storage. The
        // audited history has none; only representable absent/empty positions
        // belong in this stored-history repair check.
        if (ordinal !== undefined && ordinal !== null && (!Array.isArray(ordinal) || ordinal.length > 0)) continue;
        // Simulate an old stored projection and journal: replay must not restore
        // authority to a receipt that the current importer rejects.
        await db.setCandidates(vector.did, [invalid]);
        await db.setEvents(vector.did, [invalid]);
        g = new Gatekeeper({ db, ipfs });
        await g.resolveDID(vector.did, { verify: true });
        expect(await db.getEvents(vector.did)).toEqual([]);
        expect(await g.importBatch([genesis])).toMatchObject({ queued: 1, rejected: 0 });
        await g.processEvents();
        expect((await db.getEvents(vector.did))[0].ordinal).toEqual(genesis.ordinal);
        g = new Gatekeeper({ db, ipfs });
        await g.resolveDID(vector.did, { verify: true });
        expect((await db.getEvents(vector.did))[0].ordinal).toEqual(genesis.ordinal);
    }
    const positionedDb = new DbMemory('large-position');
    const positioned = new Gatekeeper({ db: positionedDb, ipfs: new MemoryClient() });
    await positionedDb.addOperation(vector.ids[0], vector.operations[0]);
    await positioned.importBatchByCids([null, vector.ids[0]] as never, { ...genesis, ordinal: [2 ** 40, 1.0] });
    await positioned.processEvents();
    expect((await positionedDb.getEvents(vector.did))[0].ordinal).toEqual([2 ** 40, 1, 1]);
    expect((await positionedDb.getEvents(vector.did))[0].registration?.opidx).toBe(1);
    expect(await positioned.importBatchByCids([null] as never, genesis)).toEqual({ queued: 0, processed: 0, rejected: 0, total: 0 });
    for (const registry of ['local', 'hyperswarm', 'pin']) {
        const g = new Gatekeeper({ db: new DbMemory('hints'), ipfs: new MemoryClient() });
        expect(await g.verifyEvent({ ...genesis, registry, ordinal: undefined })).toBe(true);
    }
    const db = new DbMemory('relay');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    expect(await g.importRelayedBatch([{ ...genesis, ordinal: undefined }])).toMatchObject({ queued: 1, rejected: 0 });
    await g.processEvents();
    const [hint] = await db.getEvents(vector.did);
    expect(hint.registry).toBe('hyperswarm');
    expect(hint.registration).toBeUndefined();
});
