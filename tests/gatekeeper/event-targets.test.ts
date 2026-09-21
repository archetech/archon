import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Gatekeeper from '@didcid/gatekeeper';
import Db from '@didcid/gatekeeper/db/json-memory.ts';
import DbJson from '@didcid/gatekeeper/db/json.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent, Operation } from '@didcid/gatekeeper/types';

type Vector = { name: string; did: string; operations: Operation[]; ids: string[];
    other: Operation; otherDid: string; createWithDid: Operation; createWithDidTarget: string; aliasDid: string; aliasUpdate: Operation };
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
        let db = new DbJson('target', folder);
        let g = new Gatekeeper({ db, ipfs });
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
                g = new Gatekeeper({ db, ipfs });
            }
        } finally { rmSync(folder, { recursive: true, force: true }); }
    }
});

it.each(vectors)('removes misaddressed stored evidence before replay: $name', async v => {
    for (const journal of [false, true]) for (const envelope of ['wrong', 'correct', 'omitted']) {
        const db = new Db('stored-targets');
        const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
        const bad = v.operations.map((op, i) => ({
            ...hint(op, envelope === 'wrong' ? v.otherDid : envelope === 'correct' ? v.did : undefined), opid: v.ids[i],
        }));
        const genuine = { ...hint(v.other, v.otherDid), opid: await g.generateCID(v.other) };
        // Correct or omitted envelopes cannot escape an incorrect storage bucket.
        await db.setEvents(v.otherDid, bad);
        if (journal) await db.setCandidates(v.otherDid, [...bad, genuine]);
        const valid = v.operations.map((op, i) => ({ ...hint(op, v.did), opid: v.ids[i] }));
        await db.setEvents(v.did, valid);
        await g.initialize();
        expect((await db.getEvents(v.did)).map(e => e.operation)).toEqual(v.operations);
        expect((await db.getEvents(v.otherDid)).map(e => e.operation)).toEqual(journal ? [v.other] : []);
        const candidates = await db.getCandidates();
        expect((candidates[v.otherDid] ?? []).map(e => e.operation)).toEqual(journal ? [v.other] : []);
        expect(Object.values(candidates).flat()).toHaveLength(v.operations.length + Number(journal));
    }
});

it.each(vectors)('does not erase the canonical history when repairing prefix aliases: $name', async v => {
    for (const [published, journal] of [[false, true], [true, true], [true, false]]) {
        const db = new Db('alias-targets');
        const good = { ...hint(v.operations[0], v.did), opid: v.ids[0] };
        if (journal) await db.setCandidates(v.did, [good]);
        await db.setCandidates(v.aliasDid, [{ ...good, did: v.aliasDid }]);
        if (published) await db.setEvents(v.did, [good]);
        const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
        await g.initialize();
        expect((await db.getEvents(v.did)).map(e => e.operation)).toEqual([v.operations[0]]);
        expect((await db.getCandidates())[v.aliasDid]).toEqual([]);
        // Read aliases are still supported, but cannot change the signed target.
        expect((await g.resolveDID(v.aliasDid)).didDocument?.id).toBe(v.aliasDid);
        expect(await g.updateDID(v.aliasUpdate)).toBe(false);
        await g.importBatch([hint(v.aliasUpdate)]);
        expect(await g.processEvents()).toMatchObject({ rejected: 1, added: 0 });
        expect((await db.getEvents(v.did)).map(e => e.operation)).toEqual([v.operations[0]]);
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
