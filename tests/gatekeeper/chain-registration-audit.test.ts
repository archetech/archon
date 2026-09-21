import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';
type Vector = { legacy: boolean; did: string; assetDid: string; lateAssetDid: string;
    genesis: GatekeeperEvent[]; events: GatekeeperEvent[]; asset: GatekeeperEvent; lateReceipts: GatekeeperEvent[] };
const vectors: Vector[] = JSON.parse(readFileSync('tests/convergence/chain-registration-counterexample.json', 'utf8'));
it.each(vectors)('audits same-position chain metadata (legacy=$legacy)', async vector => {
    const outcomes: number[] = [];
    for (const order of [[0, 1], [1, 0]]) {
        const db = new DbMemory('chain-authority-audit');
        const ipfs = new MemoryClient();
        let gatekeeper = new Gatekeeper({ db, ipfs });
        for (const event of [...order.map(i => vector.genesis[i]), ...vector.events, vector.asset]) {
            await gatekeeper.importBatch([structuredClone(event)]);
            await gatekeeper.processEvents();
        }
        expect((await db.getEvents(vector.did)).map(event => event.operation))
            .toEqual([vector.genesis[0].operation, ...vector.events.map((event: { operation: unknown }) => event.operation)]);
        outcomes.push((await db.getEvents(vector.assetDid)).length);
        gatekeeper = new Gatekeeper({ db, ipfs });
        await gatekeeper.resolveDID(vector.did, { verify: true });
        outcomes.push((await db.getEvents(vector.assetDid)).length);
    }
    // Rich metadata wins before authorization in either arrival order.
    expect(outcomes).toEqual([1, 1, 1, 1]);
});

it.each(vectors)('does not fall back to incomplete chain authority (legacy=$legacy)', async vector => {
    for (const order of [[0, 1], [1, 0]]) {
        const db = new DbMemory('chain-authority-rejection');
        const ipfs = new MemoryClient();
        let gatekeeper = new Gatekeeper({ db, ipfs });
        for (const event of [vector.genesis[1], ...vector.events]) {
            await gatekeeper.importBatch([structuredClone(event)]);
            await gatekeeper.processEvents();
        }
        for (const index of order) {
            await gatekeeper.importBatch([structuredClone(vector.lateReceipts[index])]);
            await gatekeeper.processEvents();
        }
        for (let pass = 0; pass < 2; pass++) {
            expect(await db.getEvents(vector.lateAssetDid)).toEqual([]);
            const candidates = (await db.getCandidates())[vector.lateAssetDid];
            expect(candidates).toHaveLength(1);
            expect(candidates[0].registration).toEqual(vector.lateReceipts[1].registration);
            expect(candidates[0].operation).toEqual(vector.lateReceipts[1].operation);
            gatekeeper = new Gatekeeper({ db, ipfs });
            await gatekeeper.resolveDID(vector.did, { verify: true });
        }
    }
});
