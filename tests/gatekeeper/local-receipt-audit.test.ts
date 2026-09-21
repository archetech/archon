import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';

type LocalVector = {
    legacy: boolean;
    nonlocalGenesis: GatekeeperEvent["operation"];
    nonlocalDid: string;
    did: string;
    assetDid: string;
    asset: GatekeeperEvent;
    deletion: GatekeeperEvent;
    events: GatekeeperEvent[];
    orders: number[][];
};
const vectors: LocalVector[] = JSON.parse(readFileSync('tests/convergence/local-receipt-counterexample.json', 'utf8'));

// Local receipts use intrinsic operation clocks at ingress and recovery.
it.each(vectors)('normalizes local receipt clocks (legacy=$legacy)', async vector => {
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
            const accepted = await db.getEvents(vector.did);
            expect(accepted.map(event => event.operation)).toEqual(vector.events.slice(0, 3).map(event => event.operation));
            for (const event of accepted) expect(event.time).toBe(event.operation.type === 'create'
                ? event.operation.created : event.operation.proof!.created);
            outcomes.push((await db.getEvents(vector.assetDid)).length);
            const candidates = (await db.getCandidates())[vector.did];
            identities.push(candidates.map(event => JSON.stringify([event.registry, event.operation])).sort());
        }
        const restarted = new Gatekeeper({ db, ipfs });
        await restarted.importBatch([structuredClone(vector.deletion)]);
        await restarted.processEvents();
        const deleted = await db.getEvents(vector.did);
        expect(deleted).toHaveLength(4);
        expect(deleted[3].operation).toEqual(vector.deletion.operation);
        expect(deleted[3].time).toBe(vector.deletion.operation.proof!.created);
    }
    // The complete operations (including proofs) agree; local receipt clocks
    // are the difference, and they are excluded by the frozen target claim.
    for (const identity of identities) expect(identity).toEqual(identities[0]);
    expect(outcomes).toEqual([0, 0, 0, 0]);
});

it.each(vectors)('repairs stored local clocks and reauthorizes assets (legacy=$legacy)', async vector => {
    const db = new DbMemory('local-clock-recovery');
    const ipfs = new MemoryClient();
    const gatekeeper = new Gatekeeper({ db, ipfs });
    const retained = await Promise.all([0, 1, 4].map(async index => ({
        ...structuredClone(vector.events[index]), did: vector.did,
        opid: await gatekeeper.generateCID(vector.events[index].operation),
    })));
    const oldAsset = { ...structuredClone(vector.asset), did: vector.assetDid,
        opid: await gatekeeper.generateCID(vector.asset.operation) };
    await db.setCandidates(vector.did, retained);
    await db.setEvents(vector.did, retained);
    await db.setCandidates(vector.assetDid, [oldAsset]);
    await db.setEvents(vector.assetDid, [oldAsset]);
    const restarted = new Gatekeeper({ db, ipfs });
    await restarted.resolveDID(vector.did, { verify: true });
    expect(await db.getEvents(vector.assetDid)).toEqual([]);
    const repaired = (await db.getCandidates())[vector.did];
    expect(repaired.map(event => event.operation)).toEqual(retained.map(event => event.operation));
    expect(repaired.map(event => event.opid)).toEqual(retained.map(event => event.opid));
    expect(repaired.map(event => event.ordinal)).toEqual(retained.map(event => event.ordinal));
    for (const event of repaired) expect(event.time).toBe(event.operation.type === 'create'
        ? event.operation.created : event.operation.proof!.created);
});

it.each(vectors)('uses creation time for direct local creation (legacy=$legacy)', async vector => {
    const db = new DbMemory('direct-local-clock');
    const gatekeeper = new Gatekeeper({ db, ipfs: new MemoryClient() });
    const operation = structuredClone(vector.events[0].operation);
    expect(operation.created).not.toBe(operation.proof!.created);
    expect(await gatekeeper.createDID(operation)).toBe(vector.did);
    const accepted = await db.getEvents(vector.did);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].operation).toEqual(operation);
    expect(accepted[0].time).toBe(operation.created);
});

it.each(vectors)('admits local chain-genesis receipts without chain authority (legacy=$legacy)', async vector => {
    const db = new DbMemory('local-chain-genesis');
    const ipfs = new MemoryClient();
    let gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'BTC:signet'] });
    const operation = structuredClone(vector.nonlocalGenesis);
    expect(operation.created).not.toBe(operation.proof!.created);
    expect(await gatekeeper.createDID(operation)).toBe(vector.nonlocalDid);
    for (let pass = 0; pass < 2; pass++) {
        const accepted = await db.getEvents(vector.nonlocalDid);
        expect(accepted).toHaveLength(1);
        expect(accepted[0].registry).toBe('local');
        expect(accepted[0].time).toBe(operation.created);
        expect(accepted[0].operation).toEqual(operation);
        const doc = await gatekeeper.resolveDID(vector.nonlocalDid, { confirm: true });
        // Genesis is admitted by definition; receipt matching is a separate fact.
        expect(doc.didDocumentMetadata?.confirmed).toBe(true);
        expect(accepted[0].registry).not.toBe(doc.didDocumentRegistration?.registry);
        expect(doc.didDocument?.id).toBe(vector.nonlocalDid);
        gatekeeper = new Gatekeeper({ db, ipfs });
        await gatekeeper.resolveDID(vector.nonlocalDid, { verify: true });
    }
});
