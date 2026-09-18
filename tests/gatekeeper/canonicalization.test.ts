import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Gatekeeper from '@didcid/gatekeeper';
import Db from '@didcid/gatekeeper/db/json.ts';
import Memory from '@didcid/ipfs/memory';
import { encodeJSON, generateCID } from '@didcid/ipfs/utils';
import type { Operation } from '@didcid/gatekeeper/types';
const vectors: { bytes: { name: string; input: string; canonical: string; cid: string }[]; signed: { modern: boolean; controller: string; did: string; operations: Operation[]; cids: string[] }[] } = JSON.parse(readFileSync('tests/gatekeeper/canonicalization-vectors.json', 'utf8'));

it.each(vectors.bytes)('RFC 8785 bytes and JSON CID: $name', async ({ input, canonical, cid }) => {
    const value = JSON.parse(input);
    expect(new TextDecoder().decode(encodeJSON(value, { canonical: true }))).toBe(canonical);
    expect(await generateCID(value, { canonical: true })).toBe(cid);
    const ipfs = new Memory();
    expect(await ipfs.addJSON(value, { canonical: true })).toBe(cid);
    expect((await ipfs.getData(cid)).toString()).toBe(canonical);
    expect(await ipfs.getJSON(cid)).toEqual(JSON.parse(canonical));
});

it.each(vectors.signed)('signed JCS generation, import, and durable restart (modern=$modern)', async v => {
    const folder = mkdtempSync(join(tmpdir(), 'archon-jcs-'));
    const ipfs = new Memory();
    let db = new Db('jcs', folder);
    let g = new Gatekeeper({ db, ipfs });
    const [agent, asset, update, deletion]: Operation[] = v.operations;
    try {
        for (let i = 0; i < v.operations.length; i++) {
            expect(await g.generateCID(v.operations[i])).toBe(v.cids[i]);
            expect(await g.generateCID(v.operations[i], true)).toBe(v.cids[i]);
        }
        expect(await g.createDID(agent)).toBe(v.controller);
        expect(await g.createDID(asset)).toBe(v.did);
        expect(await g.updateDID(update)).toBe(true);
        expect(await g.deleteDID(deletion)).toBe(true);
        await g.resetDb();
        // Fresh peer, successor before predecessor, with no cached aliases.
        await g.importBatch([update, asset, agent].map(operation => ({ operation, registry: 'hyperswarm', time: operation.proof!.created })));
        await g.processEvents();
        await db.stop();
        db = new Db('jcs', folder);
        g = new Gatekeeper({ db, ipfs });
        const doc = await g.resolveDID(v.did, { verify: true });
        expect(doc.didDocumentData).toEqual(update.doc!.didDocumentData);
        expect(doc.didDocumentMetadata?.versionId).toBe(v.cids[2]);
        expect((await g.exportDID(v.did)).map(e => e.opid)).toEqual(v.cids.slice(1, 3));
        await g.importEvent({ operation: deletion, registry: 'hyperswarm', time: deletion.proof!.created });
        expect((await g.resolveDID(v.did, { verify: true })).didDocumentMetadata?.deactivated).toBe(true);
    } finally {
        await db.stop();
        rmSync(folder, { recursive: true, force: true });
    }
});
