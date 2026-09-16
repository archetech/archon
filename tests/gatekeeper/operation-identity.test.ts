import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DbJson from '@didcid/gatekeeper/db/json.ts';
import DbSqlite from '@didcid/gatekeeper/db/sqlite.ts';
import Gatekeeper from '@didcid/gatekeeper';
import Db from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import { Operation, GatekeeperEvent } from '@didcid/gatekeeper/types';
const fixture = JSON.parse(readFileSync('tests/gatekeeper/operation-identity-vectors.json', 'utf8'));

function event(operation: Operation, height: number): GatekeeperEvent {
    return { operation, registry: 'BTC:signet', time: '2026-04-11T13:00:00Z', ordinal: [height, 0], registration: { height, index: 0, txid: `tx${height}`, batch: `batch${height}` } };
}
const vector = fixture as { did: string; createCid: string; updateCid: string; aliasCid: string } & Record<'create' | 'update' | 'variant' | 'successor' | 'aliasSuccessor', Operation>;

it.each([false, true])('distinguishes equal signatures and chooses anchored branches (variant first: %s)', async variantFirst => {
    const db = new Db('identity');
    const ipfs = new MemoryClient();
    const g = new Gatekeeper({ db, ipfs });
    await g.importEvent(event(vector.create, 100));
    const batch = [event(vector.update, 200), event(vector.variant, 300)];
    if (variantFirst) batch.reverse();
    expect((await g.importBatch(batch)).queued).toBe(2);
    await g.processEvents();
    await g.importEvent(event(vector.successor, 400));
    const restarted = new Gatekeeper({ db, ipfs });
    expect((await restarted.resolveDID(vector.did, { verify: true, confirm: true })).didDocumentData).toEqual({ version: 3 });
    expect((await db.getCandidates())[vector.did]).toHaveLength(4);
});

it.each(['successor', 'aliasSuccessor'] as const)('canonicalizes fetched operation identity and accepts %s across restart', async successor => {
    const db = new Db('aliases');
    const ipfs = new MemoryClient();
    let g = new Gatekeeper({ db, ipfs });
    await g.importEvent(event(vector.create, 100));
    const alias = await ipfs.addJSON(vector.update);
    expect(alias).toBe(vector.aliasCid);
    expect(alias).not.toBe(vector.updateCid);
    const { operation: _, ...metadata } = event(vector.update, 200);
    void _;
    await g.importBatchByCids([alias], { ...metadata, ordinal: [200] });
    await g.processEvents();
    expect((await g.resolveDID(vector.did)).didDocumentMetadata?.versionId).toBe(vector.updateCid);
    g = new Gatekeeper({ db, ipfs });
    await g.importEvent(event(vector[successor], 300));
    expect((await g.resolveDID(vector.did, { verify: true })).didDocumentData).toEqual({ version: 3 });
    expect((await g.exportDID(vector.did))[1].opid).toBe(vector.updateCid);
});

it('repairs a legacy alias projection without changing signed predecessor bytes', async () => {
    const db = new Db('legacy-alias');
    const ipfs = new MemoryClient();
    const g = new Gatekeeper({ db, ipfs });
    await db.setEvents(vector.did, [
        { ...event(vector.create, 100), opid: vector.createCid },
        { ...event(vector.update, 200), opid: vector.aliasCid },
        { ...event(vector.aliasSuccessor, 300), opid: await g.generateCID(vector.aliasSuccessor) },
    ]);
    expect((await g.resolveDID(vector.did, { verify: true })).didDocumentData).toEqual({ version: 3 });
    const events = await g.exportDID(vector.did);
    expect(events[1].opid).toBe(vector.updateCid);
    expect(events[2].operation.previd).toBe(vector.aliasCid);
});


it.each([DbJson, DbSqlite])('retains retrieval aliases in %s across storage restart', async Database => {
    const folder = mkdtempSync(join(tmpdir(), 'archon-identity-'));
    let db = new Database('identity', folder);
    const ipfs = new MemoryClient();
    try {
        await db.start();
        let g = new Gatekeeper({ db, ipfs });
        await g.importEvent(event(vector.create, 100));
        const cid = await ipfs.addJSON(vector.update);
        await g.importBatchByCids([cid], { registry: 'BTC:signet', time: '2026-04-11T13:00:00Z', ordinal: [200], registration: { height: 200, index: 0, txid: 'tx', batch: 'batch' } });
        await g.processEvents();
        await db.stop();
        db = new Database('identity', folder);
        await db.start();
        g = new Gatekeeper({ db, ipfs });
        await g.importEvent(event(vector.aliasSuccessor, 300));
        expect((await g.resolveDID(vector.did, { verify: true })).didDocumentData).toEqual({ version: 3 });
    } finally {
        await db.stop();
        rmSync(folder, { recursive: true, force: true });
    }
});
