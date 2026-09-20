import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';

type Vector = { legacy: boolean; did: string; assetDid: string; ids: string[]; block: { height: number; hash: string; time: number }; events: GatekeeperEvent[]; orders: number[][] };
const vectors: Vector[] = JSON.parse(readFileSync('tests/convergence/chain-anchor-vectors.json', 'utf8'));
it.each(vectors)('selects earliest valid anchors independently of hint order (legacy=$legacy)', async vector => {
    for (const order of vector.orders) {
        const db = new DbMemory('chain-convergence');
        const ipfs = new MemoryClient();
        let gatekeeper = new Gatekeeper({ db, ipfs });
        await gatekeeper.addBlock('BTC:signet', vector.block);
        for (const index of order) {
            await gatekeeper.importBatch([structuredClone(vector.events[index])]);
            await gatekeeper.processEvents();
        }
        for (const phase of ['initial', 'repeat', 'restart']) {
            if (phase === 'repeat') {
                await gatekeeper.importBatch(structuredClone(vector.events.slice().reverse()));
                await gatekeeper.processEvents();
            }
            if (phase === 'restart') gatekeeper = new Gatekeeper({ db, ipfs });
            await gatekeeper.getDIDs();
            const controller = await db.getEvents(vector.did);
            expect({ order, phase, positions: controller.map(event => event.ordinal) }).toEqual({ order, phase, positions: [[100, 30, 0], [100, 40, 0], [100, 10, 0]] });
            expect(controller.map(event => event.opid)).toEqual(vector.ids.slice(0, 3));
            expect(controller.map(event => event.registry)).toEqual(Array(3).fill('BTC:signet'));
            const asset = await gatekeeper.resolveDID(vector.assetDid, { verify: true, confirm: true });
            expect(asset.didDocumentData).toEqual({ state: 'created' });
            // Earlier is only preferred if valid at that controller cutoff.
            expect((await db.getEvents(vector.assetDid)).map(event => event.ordinal)).toEqual([[100, 45, 0]]);
            const candidates = await db.getCandidates();
            expect(candidates[vector.did]).toHaveLength(6);
            expect(candidates[vector.assetDid]).toHaveLength(2);
        }
    }
}, 30000);
