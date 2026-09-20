import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';
type PinVector = { legacy: boolean; did: string; assetDid: string; asset: GatekeeperEvent;
    events: GatekeeperEvent[]; orders: number[][] };


// Regresses the signed first-applicable pin-clock divergence.
const vectors: PinVector[] = JSON.parse(readFileSync('tests/convergence/pin-receipt-counterexample.json', 'utf8'));
it.each(vectors)('converges pin receipts (legacy=$legacy)', async vector => {
    const outcomes = [];
    for (const order of vector.orders) {
        const db = new DbMemory('pin-receipt-audit');
        const ipfs = new MemoryClient();
        let gatekeeper = new Gatekeeper({ db, ipfs });
        for (const index of order) {
            // Restart the normal ingress dedup cache so both pin observations
            // become retained evidence, as they can across service restarts.
            gatekeeper = new Gatekeeper({ db, ipfs });
            await gatekeeper.importBatch([structuredClone(vector.events[index])]);
            await gatekeeper.processEvents();
        }
        for (let pass = 0; pass < 2; pass++) {
            gatekeeper = new Gatekeeper({ db, ipfs });
            await gatekeeper.resolveDID(vector.did, { verify: true });
            await gatekeeper.importBatch([structuredClone(vector.asset)]);
            await gatekeeper.processEvents();
            const candidates = await db.getCandidates();
            for (const event of candidates[vector.did]) {
                if (event.registry === 'pin') expect(event.time).toBe(event.operation.proof!.created);
            }
            outcomes.push({ asset: (await db.getEvents(vector.assetDid)).length,
                candidates: candidates[vector.did].map(event => JSON.stringify(event)).sort() });
        }
    }
    expect(outcomes[0].candidates).toEqual(outcomes[2].candidates);
    expect(outcomes.map(outcome => outcome.asset)).toEqual([0, 0, 0, 0]);
});

it.each(vectors)('repairs stored pin clocks and asset authorization (legacy=$legacy)', async vector => {
    const db = new DbMemory('pin-clock-recovery');
    const ipfs = new MemoryClient();
    const gatekeeper = new Gatekeeper({ db, ipfs });
    const retained = await Promise.all(vector.events.map(async (event) => ({
        ...structuredClone(event), did: vector.did, opid: await gatekeeper.generateCID(event.operation),
    })));
    const oldAsset = { ...structuredClone(vector.asset), did: vector.assetDid,
        opid: await gatekeeper.generateCID(vector.asset.operation) };
    // Seed the actual pre-fix late-receipt projection, including its accepted asset.
    await db.setCandidates(vector.did, retained);
    await db.setEvents(vector.did, [retained[0], retained[3], retained[4]]);
    await db.setCandidates(vector.assetDid, [oldAsset]);
    await db.setEvents(vector.assetDid, [oldAsset]);
    const before = retained.map(event => JSON.stringify(event.operation));
    const repaired = new Gatekeeper({ db, ipfs });
    await repaired.resolveDID(vector.did, { verify: true });
    expect(await db.getEvents(vector.assetDid)).toEqual([]);
    const candidates = (await db.getCandidates())[vector.did];
    expect(candidates.map(event => JSON.stringify(event.operation))).toEqual(before);
    for (const event of candidates) if (event.registry === 'pin') {
        expect(event.time).toBe(event.operation.proof!.created);
    }
});
