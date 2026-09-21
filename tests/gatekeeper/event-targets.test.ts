import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Gatekeeper from '@didcid/gatekeeper';
import Db from '@didcid/gatekeeper/db/json-memory.ts';
import DbJson from '@didcid/gatekeeper/db/json.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent, Operation } from '@didcid/gatekeeper/types';

type Vector = { name: string; did: string; operations: Operation[]; ids: string[];
    other: Operation; otherDid: string; createWithDid: Operation; createWithDidTarget: string };
const vectors: Vector[] = JSON.parse(readFileSync('tests/convergence/event-target-vectors.json', 'utf8'));
const hint = (operation: Operation, did?: string): GatekeeperEvent => ({
    registry: 'hyperswarm', time: operation.proof!.created, operation, ...(did === undefined ? {} : { did }),
});

it.each(vectors)('binds targets before queue deduplication: $name', async v => {
    for (const relay of [false, true]) for (const explicit of [false, true]) {
        const db = new Db('targets');
        const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
        const ingest = (event: GatekeeperEvent) => relay ? g.importRelayedBatch([event]) : g.importBatch([event]);
        for (const [i, operation] of v.operations.entries()) {
            expect(await ingest(hint(operation, v.otherDid))).toMatchObject({ rejected: 1, queued: 0 });
            expect(await ingest(hint(operation, explicit ? v.did : undefined))).toMatchObject({ rejected: 0, queued: 1 });
            expect(await g.processEvents()).toMatchObject({ added: 1, rejected: 0, pending: 0 });
            expect((await db.getEvents(v.did)).map(e => e.opid)).toEqual(v.ids.slice(0, i + 1));
            expect(await db.getEvents(v.otherDid)).toEqual([]);
        }
        expect(Object.keys(await db.getCandidates())).toEqual([v.did]);
        expect((await g.resolveDID(v.did)).didDocumentMetadata?.deactivated).toBe(true);
    }
});

it.each(vectors)('rejects conflicting genesis in either order through restart: $name', async v => {
    for (const reverse of [false, true]) {
        const folder = mkdtempSync(join(tmpdir(), 'archon-target-'));
        const ipfs = new MemoryClient();
        const didPrefix = v.did.slice(0, v.did.lastIndexOf(':'));
        let db = new DbJson('target', folder);
        let g = new Gatekeeper({ db, ipfs, didPrefix });
        try {
            const events = [
                { ...hint(v.other, v.did), opid: v.ids[0] },
                hint(v.operations[0], v.did),
            ];
            if (reverse) events.reverse();
            for (const event of events) {
                await g.importRelayedBatch([event]);
                await g.processEvents();
            }
            for (let restart = 0; restart < 2; restart++) {
                expect((await g.resolveDID(v.did, { verify: true })).didDocumentMetadata?.versionId).toBe(v.ids[0]);
                expect((await db.getEvents(v.did)).map(e => e.operation)).toEqual([v.operations[0]]);
                expect((await db.getCandidates())[v.did]).toHaveLength(1);
                db = new DbJson('target', folder);
                g = new Gatekeeper({ db, ipfs, didPrefix });
            }
        } finally { rmSync(folder, { recursive: true, force: true }); }
    }
});

it.each(vectors)('derives creation identity consistently with direct submission: $name', async v => {
    const db = new Db('direct-targets');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    expect(await g.createDID(v.operations[0])).toBe(v.did);
    expect(await g.updateDID(v.operations[1])).toBe(true);
    expect(await g.deleteDID(v.operations[2])).toBe(true);
    expect(await g.createDID(v.createWithDid)).toBe(v.createWithDidTarget);
    const imported = new Gatekeeper({ db: new Db('create-target'), ipfs: new MemoryClient() });
    expect(await imported.importBatch([hint(v.createWithDid, v.otherDid)])).toMatchObject({ rejected: 1 });
    await imported.importBatch([hint(v.createWithDid)]);
    expect(await imported.processEvents()).toMatchObject({ added: 1 });
    expect((await imported.resolveDID(v.createWithDidTarget)).didDocument?.id).toBe(v.createWithDidTarget);
});

it.each(vectors)('checks targets in the per-event replay importer: $name', async v => {
    const db = new Db('replay-targets');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    const replay = g as unknown as { importEventOnce(event: GatekeeperEvent): Promise<string> };
    for (const operation of v.operations) {
        expect(await replay.importEventOnce(hint(operation, v.otherDid))).toBe('rejected');
        expect(await replay.importEventOnce(hint(operation, v.did))).toBe('added');
    }
    expect((await db.getEvents(v.did)).map(e => e.operation)).toEqual(v.operations);
    expect(await db.getEvents(v.otherDid)).toEqual([]);
});
