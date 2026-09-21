import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';

type Vector = { legacy: boolean; did: string; assetDid: string; events: GatekeeperEvent[]; receipts: GatekeeperEvent[] };
const vectors: Vector[] = JSON.parse(readFileSync('tests/convergence/local-registration-counterexample.json', 'utf8'));

// Unanchored metadata must not supply chain authority.
it.each(vectors)('audits local registration metadata (legacy=$legacy)', async vector => {
    const outcomes: number[] = [];
    for (const order of [[0, 1], [1, 0]]) {
        const db = new DbMemory('local-registration-audit');
        const ipfs = new MemoryClient();
        let gatekeeper = new Gatekeeper({ db, ipfs });
        for (const event of vector.events) {
            await gatekeeper.importBatch([structuredClone(event)]);
            await gatekeeper.processEvents();
        }
        for (const index of order) {
            await gatekeeper.importBatch([structuredClone(vector.receipts[index])]);
            await gatekeeper.processEvents();
        }
        expect(await db.getEvents(vector.assetDid)).toEqual([]);
        gatekeeper = new Gatekeeper({ db, ipfs });
        await gatekeeper.resolveDID(vector.did, { verify: true });
        const agents = await db.getEvents(vector.did);
        expect(agents.map(e => e.operation)).toEqual(vector.events.map(e => e.operation));
        const candidates = (await db.getCandidates())[vector.assetDid];
        expect(candidates).toHaveLength(1);
        expect(candidates[0].operation).toEqual(vector.receipts[0].operation);
        expect(candidates[0].time).toBe(vector.receipts[0].operation.created);
        outcomes.push((await db.getEvents(vector.assetDid)).length);
    }
    expect(outcomes).toEqual([0, 0]);
});

it.each(vectors)('repairs old metadata-authorized assets (legacy=$legacy)', async vector => {
    const db = new DbMemory('local-registration-recovery');
    const ipfs = new MemoryClient();
    const gatekeeper = new Gatekeeper({ db, ipfs });
    const retained = await Promise.all(vector.events.map(async event => ({
        ...structuredClone(event), did: vector.did, opid: await gatekeeper.generateCID(event.operation),
    })));
    const oldAsset = { ...structuredClone(vector.receipts[1]), did: vector.assetDid,
        opid: await gatekeeper.generateCID(vector.receipts[1].operation) };
    await db.setCandidates(vector.did, retained);
    await db.setEvents(vector.did, retained);
    await db.setCandidates(vector.assetDid, [oldAsset]);
    await db.setEvents(vector.assetDid, [oldAsset]);
    const restarted = new Gatekeeper({ db, ipfs });
    await restarted.resolveDID(vector.did, { verify: true });
    expect(await db.getEvents(vector.assetDid)).toEqual([]);
    expect((await db.getCandidates())[vector.assetDid]).toEqual([oldAsset]);
    expect((await db.getEvents(vector.did)).map(event => event.operation))
        .toEqual(vector.events.map(event => event.operation));
});
