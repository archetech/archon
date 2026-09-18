import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DbDisk from '@didcid/gatekeeper/db/json.ts';
import Gatekeeper from '@didcid/gatekeeper';
import Db from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';

// RFC 8785 now agrees with the original Rust numeric-key encoding.
it('generates canonical CIDs while preserving signed legacy predecessors', async () => {
    const vector = JSON.parse(readFileSync('tests/gatekeeper/numeric-predecessor-vectors.json', 'utf8'));
    const g = new Gatekeeper({ db: new Db('numeric-predecessor'), ipfs: new MemoryClient() });
    for (const name of ['agent', 'update', 'successor']) {
        expect(await g.generateCID(vector[name])).toBe(vector.cids[name].rust);
        expect(await g.generateCID(vector[name], true)).toBe(vector.cids[name].rust);
    }
    expect(await g.generateDID(vector.agent)).toBe(vector.did);
    expect(vector.cids.update.rust).not.toBe(vector.cids.update.typescript);
});


it.each([[0, 1, 2], [0, 2, 1]])('recovers legacy predecessors on a fresh node in order %j', async (...order) => {
    const vector = JSON.parse(readFileSync('tests/gatekeeper/numeric-predecessor-vectors.json', 'utf8'));
    const db = new Db('fresh-numeric');
    const ipfs = new MemoryClient();
    let g = new Gatekeeper({ db, ipfs });
    const operations = [vector.agent, vector.update, vector.successor];
    for (const i of order) {
        const operation = operations[i as number];
        await g.importEvent({ operation, time: operation.proof.created, registry: 'hyperswarm', opid: vector.cids.agent.typescript });
    }
    g = new Gatekeeper({ db, ipfs });
    expect((await g.resolveDID(vector.did, { verify: true })).didDocumentData).toEqual({ recovered: true });
    expect((await g.exportDID(vector.did))[2].operation.previd).toBe(vector.cids.update.typescript);
    expect(await db.getOperation(vector.cids.update.typescript)).toEqual(vector.update);
    expect(await db.getOperation(vector.cids.agent.typescript)).toEqual(vector.agent);
});


it('repairs legacy TS projections and persists canonical IDs and aliases across a disk restart', async () => {
    const v = JSON.parse(readFileSync('tests/gatekeeper/numeric-predecessor-vectors.json', 'utf8'));
    const folder = mkdtempSync(join(tmpdir(), 'archon-legacy-cids-'));
    let db = new DbDisk('history', folder);
    const ipfs = new MemoryClient();
    const events = ['agent', 'update', 'successor'].map(name => ({
        operation: v[name], did: v.did, opid: v.cids[name].typescript,
        registry: 'hyperswarm', time: v[name].proof.created,
    }));
    try {
        await db.setEvents(v.did, events);
        await db.setCandidates(v.did, events);
        for (let run = 0; run < 2; run++) {
            const g = new Gatekeeper({ db, ipfs });
            expect((await g.resolveDID(v.did, { verify: true })).didDocumentData).toEqual({ recovered: true });
            expect((await g.exportDID(v.did)).map(e => e.opid)).toEqual(['agent', 'update', 'successor'].map(name => v.cids[name].rust));
            expect((await g.exportDID(v.did))[2].operation.previd).toBe(v.cids.update.typescript);
            expect(await db.getOperation(v.cids.update.typescript)).toEqual(v.update);
            await db.stop();
            db = new DbDisk('history', folder);
        }
    } finally {
        await db.stop();
        rmSync(folder, { recursive: true, force: true });
    }
});
