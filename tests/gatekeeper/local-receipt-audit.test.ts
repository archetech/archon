import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';

type LocalVector = {
    legacy: boolean;
    did: string;
    assetDid: string;
    asset: GatekeeperEvent;
    events: GatekeeperEvent[];
    orders: number[][];
};
const vectors: LocalVector[] = JSON.parse(readFileSync('tests/convergence/local-receipt-counterexample.json', 'utf8'));

// C2 blocker: local clock normalization needs an explicit protocol decision.
it.each(vectors)('reproduces local receipt-clock divergence (legacy=$legacy)', async vector => {
    const outcomes: number[] = [];
    const identities: string[][] = [];
    for (const order of vector.orders) {
        const db = new DbMemory('local-receipt-audit');
        const ipfs = new MemoryClient();
        const gatekeeper = new Gatekeeper({ db, ipfs });
        for (const index of order) {
            await gatekeeper.importBatch([structuredClone(vector.events[index])]);
            await gatekeeper.processEvents();
        }
        for (let pass = 0; pass < 2; pass++) {
            const restarted = new Gatekeeper({ db, ipfs });
            await restarted.resolveDID(vector.did, { verify: true });
            await restarted.importBatch([structuredClone(vector.asset)]);
            await restarted.processEvents();
            outcomes.push((await db.getEvents(vector.assetDid)).length);
            const candidates = (await db.getCandidates())[vector.did];
            identities.push(candidates.map(event => JSON.stringify([event.registry, event.operation])).sort());
        }
    }
    // The complete operations (including proofs) agree; local receipt clocks
    // are the difference, and they are excluded by the frozen target claim.
    for (const identity of identities) expect(identity).toEqual(identities[0]);
    expect(outcomes).toEqual([0, 0, 1, 1]);
});
