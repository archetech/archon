import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import { generateCID as rawCID } from '@didcid/ipfs/utils';
import Cipher from '@didcid/cipher/node';
const cipher = new Cipher();
const generateCID = (operation: Operation) => rawCID(JSON.parse(cipher.canonicalizeJSON(operation)));
import MemoryClient from '@didcid/ipfs/memory';
import type { Operation, GatekeeperEvent } from '@didcid/gatekeeper/types';

class Db extends DbMemory {
    snapshot() { return this.loadDb(); }
}
const vectors = JSON.parse(readFileSync('tests/gatekeeper/operation-size-v1-vectors.json', 'utf8')) as {
    agent: Operation; did: string;
    cases: { name: string; accepted: boolean; units: number; bytes: number; padding: { character: string; repeat: number; ascii: number }; operation: Operation }[];
};
const cases = vectors.cases.map(v => ({ ...v, operation: { ...v.operation,
    sizePadding: v.padding.character.repeat(v.padding.repeat) + 'a'.repeat(v.padding.ascii),
} }));
const event = (operation: Operation): GatekeeperEvent => ({ operation, registry: 'hyperswarm', time: operation.proof!.created });

it.each(cases)('preserves v1 $name across submission, import, and replay', async ({ operation, accepted, units, bytes }) => {
    expect(JSON.stringify(operation).length).toBe(units);
    expect(Buffer.byteLength(JSON.stringify(operation))).toBe(bytes);
    const create = operation.type === 'create';
    const did = create ? 'did:cid:' + await generateCID(operation) : vectors.did;
    for (const mode of ['direct', 'import', 'replay']) {
        const db = new Db('operation-size');
        const ipfs = new MemoryClient();
        let g = new Gatekeeper({ db, ipfs });
        if (!create && mode !== 'replay') await g.createDID(vectors.agent);
        if (mode === 'direct') {
            const before = JSON.stringify(db.snapshot());
            const result = create ? g.createDID(operation) : g.updateDID(operation);
            if (accepted) await expect(result).resolves.toBeTruthy();
            else {
                await expect(result).rejects.toThrow('size');
                expect(JSON.stringify(db.snapshot())).toBe(before);
            }
        } else if (mode === 'import') {
            expect(await g.importEvent(event(operation))).toBe(accepted ? 'added' : 'rejected');
        } else {
            const ops = create ? [operation] : [vectors.agent, operation];
            const events = await Promise.all(ops.map(async op => ({ ...event(op), opid: await generateCID(op) })));
            await db.setEvents(did, events);
            await db.setCandidates(did, events);
        }
        for (const restart of [false, true]) {
            if (restart) g = new Gatekeeper({ db, ipfs });
            for (const verify of [false, true]) {
                if (create && !accepted) expect((await g.resolveDID(did, { verify })).didResolutionMetadata?.error).toBe('notFound');
                else {
                    const doc = await g.resolveDID(did, { verify });
                    expect(doc.didDocumentMetadata?.versionSequence).toBe(create || !accepted ? '1' : '2');
                    expect(!!doc.didDocumentMetadata?.deactivated).toBe(accepted && operation.type === 'delete');
                }
            }
        }
    }
});

it('keeps a local submission cap out of import, verification, and restart', async () => {
    const db = new Db('local-size-cap');
    const ipfs = new MemoryClient();
    let g = new Gatekeeper({ db, ipfs, maxOpBytes: 100 });
    await expect(g.createDID(vectors.agent)).rejects.toThrow('size');
    expect(await g.importEvent(event(vectors.agent))).toBe('added');
    const operation = cases.find(c => c.name === 'legacy_40000_bmp')!.operation;
    await expect(g.updateDID(operation)).rejects.toThrow('size');
    expect(await g.importEvent(event(operation))).toBe('added');
    g = new Gatekeeper({ db, ipfs, maxOpBytes: 100 });
    expect((await g.resolveDID(vectors.did, { verify: true })).didDocumentMetadata?.versionSequence).toBe('2');
});

it('cannot raise protocol acceptance by increasing the local cap', async () => {
    const g = new Gatekeeper({ db: new Db('raised-size-cap'), ipfs: new MemoryClient(), maxOpBytes: 1_000_000 });
    await g.createDID(vectors.agent);
    const operation = cases.find(c => c.name === 'bmp_65537')!.operation;
    await expect(g.updateDID(operation)).rejects.toThrow('size');
    expect(await g.importEvent(event(operation))).toBe('rejected');
});
