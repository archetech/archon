import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';

// Records the demonstrated boundary while the pin-time decision is pending.
// This deliberately asserts the current divergence, not a convergence claim.
it('audits repeated pin receipts through the ordinary importer', async () => {
    const vector = JSON.parse(readFileSync('tests/convergence/pin-receipt-counterexample.json', 'utf8'));
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
            outcomes.push({ asset: (await db.getEvents(vector.assetDid)).length,
                candidates: candidates[vector.did].map(event => JSON.stringify(event)).sort() });
        }
    }
    expect(outcomes[0].candidates).toEqual(outcomes[2].candidates);
    expect(outcomes.map(outcome => outcome.asset)).toEqual([0, 0, 1, 1]);
});
