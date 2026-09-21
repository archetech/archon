import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Gatekeeper from '@didcid/gatekeeper';
import Db from '@didcid/gatekeeper/db/json.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { Operation } from '@didcid/gatekeeper/types';

type Vector = { name: string; did: string; setup: Operation[]; update: Operation; successor: Operation; accepted: boolean; ids: string[] };
const vectors: Vector[] = JSON.parse(readFileSync('tests/convergence/method-id-vectors.json', 'utf8'));
const hint = (operation: Operation) => ({ registry: 'hyperswarm', time: operation.proof!.created, operation });

it.each(vectors)('checks normalized method IDs in submission, import and restart: $name', async v => {
    const folder = mkdtempSync(join(tmpdir(), 'archon-method-'));
    const ipfs = new MemoryClient();
    try {
        for (const direct of [false, true]) {
            const name = direct ? 'direct' : 'import';
            let db = new Db(name, folder);
            let g = new Gatekeeper({ db, ipfs });
            for (const op of v.setup) {
                if (direct) await g.createDID(op);
                else { await g.importBatch([hint(op)]); await g.processEvents(); }
            }
            if (direct) {
                if (v.accepted) {
                    expect(await g.updateDID(v.update)).toBe(true);
                    expect(await g.updateDID(v.successor)).toBe(true);
                } else {
                    expect(await g.updateDID(v.update)).toBe(false);
                }
            } else {
                await g.importBatch([hint(v.update)]);
                expect(await g.processEvents()).toMatchObject(v.accepted ? { added: 1 } : { rejected: 1 });
                if (v.accepted) {
                    await g.importBatch([hint(v.successor)]);
                    expect(await g.processEvents()).toMatchObject({ added: 1 });
                }
            }
            for (let restart = 0; restart < 2; restart++) {
                await g.resolveDID(v.did, { verify: true });
                expect((await db.getEvents(v.did)).map(e => e.opid)).toEqual(v.ids);
                db = new Db(name, folder);
                g = new Gatekeeper({ db, ipfs });
            }
        }
    } finally { rmSync(folder, { recursive: true, force: true }); }
});
