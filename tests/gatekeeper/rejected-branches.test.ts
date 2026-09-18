import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import Gatekeeper from '@didcid/gatekeeper';
import Db from '@didcid/gatekeeper/db/json.ts';
import Memory from '@didcid/ipfs/memory';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';
type Vector = { registry: string; asset: string; controller: string; base: GatekeeperEvent[] } &
    Record<'competitor' | 'rejected' | 'successor' | 'descendant' | 'earlier' | 'rotation' | 'direct' | 'directSuccessor' | 'directRejected', GatekeeperEvent>;
const vectors: Vector[] = JSON.parse(readFileSync('tests/gatekeeper/rejected-branch-vectors.json', 'utf8'));

it.each(vectors)('retires rejected branches, retains missing intermediates, and recovers after restart ($registry)', async v => {
    const folder = mkdtempSync(join(tmpdir(), 'archon-rejected-'));
    let db = new Db('history', folder);
    const ipfs = new Memory();
    let g = new Gatekeeper({ db, ipfs });
    try {
        for (const event of [...v.base, v.competitor]) await g.importEvent(event);
        expect(await g.importEvent(v.rejected)).toBe('rejected');
        // The intermediate successor is unseen: do not infer its ancestry.
        await g.importBatch([v.descendant]);
        expect(await g.processEvents()).toMatchObject({ pending: 1, pendingBatches: ['batch500'] });
        await g.importBatch([v.successor]);
        expect(await g.processEvents()).toMatchObject({ pending: 0, rejected: 2 });
        expect((await g.resolveDID(v.asset)).didDocumentData).toBe('before-rotation');
        expect((await db.getCandidates())[v.asset]).toHaveLength(5);
        const replay = jest.spyOn(g as any, 'rebuildHistories');
        const importOnce = jest.spyOn(g as any, 'importEventOnce');
        for (let i = 0; i < 3; i++) expect(await g.importEvent(v.descendant)).toBe('rejected');
        expect(replay).not.toHaveBeenCalled();
        expect(importOnce).not.toHaveBeenCalled();
        await db.stop();
        db = new Db('history', folder);
        g = new Gatekeeper({ db, ipfs });
        expect(await g.importEvent(v.descendant)).toBe('rejected');
        // A distinct earlier anchor makes the formerly losing branch win.
        expect(await g.importEvent(v.earlier)).toBe('added');
        expect((await g.resolveDID(v.asset, { verify: true })).didDocumentData).toBe('recovered-descendant');
        expect(await g.importEvent(v.descendant)).toBe('merged');
        await db.stop();
        db = new Db('history', folder);
        g = new Gatekeeper({ db, ipfs });
        expect((await g.resolveDID(v.asset, { verify: true })).didDocumentData).toBe('recovered-descendant');
    } finally {
        await db.stop();
        rmSync(folder, { recursive: true, force: true });
    }
});

it.each(vectors)('keeps unavailable controller evidence pending and revisits rejected descendants ($registry)', async v => {
    const folder = mkdtempSync(join(tmpdir(), 'archon-controller-'));
    const db = new Db('history', folder);
    const g = new Gatekeeper({ db, ipfs: new Memory() });
    try {
        // All operation content exists, but the controller does not.
        await g.importBatch([v.base[1], v.rejected, v.successor, v.descendant]);
        expect((await g.processEvents()).pending).toBe(4);
        await g.importEvent(v.base[0]);
        expect((await g.processEvents()).pending).toBe(0);
        expect((await g.resolveDID(v.asset)).didDocumentData).toBe('recovered-descendant');
        await g.importEvent(v.rotation);
        expect(await g.importEvent(v.successor)).toBe('rejected');
        expect(await g.importEvent(v.descendant)).toBe('rejected');
        await g.removeDIDs([v.controller]);
        expect(await g.importEvent(v.descendant)).toBe('deferred');
        await g.importEvent(v.base[0]);
        expect((await g.resolveDID(v.asset, { verify: true })).didDocumentData).toBe('recovered-descendant');
    } finally {
        await db.stop();
        rmSync(folder, { recursive: true, force: true });
    }
});

it.each(vectors)('reconsiders retained descendants after a direct operation changes target history ($registry)', async v => {
    const folder = mkdtempSync(join(tmpdir(), 'archon-direct-'));
    const db = new Db('history', folder);
    const g = new Gatekeeper({ db, ipfs: new Memory(), registries: ['local', 'hyperswarm', 'BTC:signet'] });
    try {
        for (const event of [...v.base, v.rotation]) await g.importEvent(event);
        expect(await g.importEvent(v.directRejected)).toBe('rejected');
        expect(await g.importEvent(v.directSuccessor)).toBe('rejected');
        expect(await g.updateDID(v.direct.operation)).toBe(true);
        expect((await g.resolveDID(v.asset, { verify: true })).didDocumentData).toBe('new-key-successor');
    } finally {
        await db.stop();
        rmSync(folder, { recursive: true, force: true });
    }
});
