import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import Cipher from '@didcid/cipher/node';
import type { GatekeeperEvent, Operation } from '@didcid/gatekeeper/types';

type Vector = { seed?: number; did: string; ids: string[]; operations: Operation[]; events: GatekeeperEvent[]; block: { height: number; hash: string; time: number } };
type Case = { vector: number; order: number[]; passBound: number; passes: number[][][] };
for (const [source, trace] of [['chain-successor-vectors', 'interleaved-cases'], ['chain-document-vectors', 'chain-document-cases']]) {
    const vectors: Vector[] = JSON.parse(readFileSync(`tests/convergence/${source}.json`, 'utf8'));
    const cases: Case[] = JSON.parse(readFileSync(`tests/convergence/${trace}.json`, 'utf8'));
    it.each(cases)(`matches ${source} Lean transitions: vector=$vector order=$order`, async c => {
        expect(c.passes.length).toBeLessThanOrEqual(c.passBound);
        const v = vectors[c.vector];
        const db = new DbMemory('interleaved-replay');
        const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
        await g.getDIDs();
        await g.addBlock('BTC:signet', v.block);
        const events = v.events.map(e => ({ ...e, did: v.did,
            opid: v.ids[v.operations.findIndex(op => isDeepStrictEqual(op, e.operation))] }));
        const replay = g as unknown as { importEventOnce(event: GatekeeperEvent): Promise<unknown> };
        if (v.seed !== undefined) await replay.importEventOnce(structuredClone(events[v.seed]));
        const cipher = new Cipher();
        for (const [pass, steps] of c.passes.entries()) {
            const before = cipher.canonicalizeJSON(await db.getEvents(v.did));
            for (const [i, t] of c.order.entries()) {
                await replay.importEventOnce(structuredClone(events[t]));
                expect(JSON.parse(JSON.stringify(await db.getEvents(v.did)))).toEqual(steps[i].map(index => events[index]));
            }
            const after = cipher.canonicalizeJSON(await db.getEvents(v.did));
            expect(after === before).toBe(pass === c.passes.length - 1);
        }
    });
}
