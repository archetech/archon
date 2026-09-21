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
    // Incomplete receipts are rejected before authorization in either arrival order.
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

const malformed: { name: string; registration?: unknown }[] = JSON.parse(readFileSync('tests/convergence/invalid-chain-metadata.json', 'utf8'));
it.each(vectors)('requires complete consistent chain receipts at ingress and replay (legacy=$legacy)', async vector => {
    for (const { registration } of malformed) {
        const db = new DbMemory('metadata-admission');
        const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
        const good = structuredClone(vector.genesis[1]);
        const bad = { ...good, registration } as GatekeeperEvent;
        expect(await g.importBatch([bad])).toMatchObject({ rejected: 1, queued: 0 });
        const replay = g as unknown as { importEventOnce(event: GatekeeperEvent): Promise<string> };
        expect(await replay.importEventOnce(bad)).toBe('rejected');
        expect(await db.getCandidates()).toEqual({});
        expect(await g.importBatch([good])).toMatchObject({ rejected: 0, queued: 1 });
        expect(await g.processEvents()).toMatchObject({ added: 1 });
        // The same signed bytes remain eligible as an unconfirmed relayed hint.
        expect(await g.importRelayedBatch([bad])).toMatchObject({ rejected: 0 });
    }
});

it.each(vectors)('validates CID batch evidence before fetching and keeps original opidx (legacy=$legacy)', async vector => {
    const db = new DbMemory('metadata-cids');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    const good = vector.genesis[1];
    const cid = await g.generateCID(good.operation);
    for (const invalid of malformed.filter(item => !item.name.startsWith('opidx-') && item.name !== 'missing-opidx')) {
        await expect(g.importBatchByCids([cid], { ...good, ordinal: [1, 0], registration: invalid.registration } as never)).rejects.toThrow('metadata');
        expect(await db.getOperation(cid)).toBeNull();
    }
    await db.addOperation(cid, good.operation);
    for (const registry of ['BTC:signet', 'ZEC:testnet', 'ETH:sepolia', 'SOL:devnet', 'future:chain']) {
        // Additional registry position components remain part of the ordinal.
        expect(await g.importBatchByCids([null, cid] as never, { ...good, registry, ordinal: [1, 0, 7] })).toMatchObject({ queued: 1 });
        await g.processEvents();
        const candidate = (await db.getCandidates())[vector.did].find(e => e.registry === registry)!;
        expect(candidate.ordinal).toEqual([1, 0, 7, 1]);
        expect(candidate.registration?.opidx).toBe(1);
    }
});
