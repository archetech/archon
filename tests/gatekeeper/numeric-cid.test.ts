import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import CipherNode from '@didcid/cipher/node';
import Db from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { Operation, GatekeeperEvent } from '@didcid/gatekeeper/types';

const vector = JSON.parse(readFileSync('tests/gatekeeper/numeric-cid-vectors.json', 'utf8'));
const event = (operation: Operation): GatekeeperEvent => ({ operation, registry: 'hyperswarm', time: operation.proof!.created });

it('hashes and saves the same canonical JSON bytes for nested numeric keys', async () => {
    const ipfs = new MemoryClient();
    const g = new Gatekeeper({ db: new Db('numeric'), ipfs });
    for (const name of ['agent', 'asset', 'update', 'successor']) {
        const op = vector[name];
        const cid = vector.cids[name].canonical;
        expect(await g.generateCID(op)).toBe(cid);
        expect(await g.generateCID(op, true)).toBe(cid);
        expect(await ipfs.getJSON(cid)).toEqual(op);
        expect((await ipfs.getData(cid)).toString()).toBe(new CipherNode().canonicalizeJSON(op));
        expect(await g.generateCID(Object.fromEntries(Object.entries(op).reverse()))).toBe(cid);
    }
    expect(await g.generateDID(vector.asset)).toBe(vector.assetDid);
});

it.each([false, true])('recovers an uncached legacy predecessor after restart (old projection: %s)', async oldProjection => {
    const db = new Db('numeric-repair');
    const ipfs = new MemoryClient();
    let g = new Gatekeeper({ db, ipfs });
    for (const name of ['agent', 'asset', 'update']) {
        const did = name === 'agent' ? vector.agentDid : vector.assetDid;
        await db.addEvent(did, { ...event(vector[name]), did,
            opid: oldProjection ? vector.cids[name].legacy : vector.cids[name].canonical });
    }
    await db.setCandidates(vector.assetDid, [event(vector.asset), event(vector.update), event(vector.successor)]);
    if (!oldProjection) expect(await db.getOperation(vector.cids.update.legacy)).toBeNull();
    const fetch = jest.spyOn(ipfs, 'getJSON');
    expect((await g.resolveDID(vector.assetDid, { verify: true })).didDocumentData).toEqual({ recovered: true });
    expect(await db.getOperation(vector.cids.update.legacy)).toEqual(vector.update);
    expect(fetch).not.toHaveBeenCalled();
    const before = await db.getEvents(vector.assetDid);
    const writes = jest.spyOn(db, 'addOperation');
    g = new Gatekeeper({ db, ipfs });
    expect((await g.resolveDID(vector.assetDid, { verify: true })).didDocumentData).toEqual({ recovered: true });
    expect(await db.getEvents(vector.assetDid)).toEqual(before);
    expect(writes).not.toHaveBeenCalled();
    expect(before[2].operation.previd).toBe(vector.cids.update.legacy);
});

it('retains an existing legacy genesis DID and its signed successor during repair', async () => {
    const db = new Db('numeric-genesis');
    const ipfs = new MemoryClient();
    await db.setEvents(vector.agentDid, [{ ...event(vector.agent), did: vector.agentDid, opid: vector.cids.agent.canonical }]);
    await db.setEvents(vector.legacyAssetDid, [
        { ...event(vector.asset), did: vector.legacyAssetDid, opid: vector.cids.asset.legacy },
        { ...event(vector.legacyAssetUpdate), did: vector.legacyAssetDid, opid: vector.cids.legacyAssetUpdate.legacy },
    ]);
    const g = new Gatekeeper({ db, ipfs });
    const doc = await g.resolveDID(vector.legacyAssetDid, { verify: true });
    expect(doc.didDocument?.id).toBe(vector.legacyAssetDid);
    expect(doc.didDocumentData).toEqual({ legacyDidPreserved: true });
    expect((await db.getEvents(vector.legacyAssetDid))[0].opid).toBe(vector.cids.asset.canonical);
});

it.each([false, true])('recovers legacy genesis from operation-only gossip (successor first: %s)', async successorFirst => {
    const db = new Db('numeric-gossip');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    await g.importEvent(event(vector.agent));
    if (successorFirst) await g.importEvent(event(vector.legacyAssetUpdate));
    await g.importEvent(event(vector.asset));
    if (!successorFirst) await g.importEvent(event(vector.legacyAssetUpdate));
    const doc = await g.resolveDID(vector.legacyAssetDid, { verify: true });
    expect(doc.didDocument?.id).toBe(vector.legacyAssetDid);
    expect(doc.didDocumentData).toEqual({ legacyDidPreserved: true });
});

it('resolves a historical genesis identifier from its known canonical seed', async () => {
    const g = new Gatekeeper({ db: new Db('numeric-lookup'), ipfs: new MemoryClient() });
    await g.createDID(vector.agent);
    await g.createDID(vector.asset);
    const doc = await g.resolveDID(vector.legacyAssetDid, { verify: true });
    expect(doc.didDocument?.id).toBe(vector.legacyAssetDid);
    expect(doc.didDocumentData).toEqual(vector.asset.data);
});

it('does not recover a genesis alias from removed evidence', async () => {
    const g = new Gatekeeper({ db: new Db('numeric-removed'), ipfs: new MemoryClient() });
    await g.createDID(vector.agent);
    await g.createDID(vector.asset);
    await g.removeDIDs([vector.assetDid]);
    expect((await g.resolveDID(vector.legacyAssetDid, { verify: true })).didResolutionMetadata?.error).toBe('notFound');
});

it('deduplicates numeric-key operations regardless of a peer\'s claimed opid', async () => {
    const db = new Db('numeric-duplicates');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    for (const name of ['agent', 'asset', 'update', 'successor']) await g.importEvent(event(vector[name]));
    for (const opid of [vector.cids.update.legacy, vector.cids.update.canonical, vector.cids.agent.canonical]) {
        expect(await g.importEvent({ ...event(vector.update), opid })).toBe('merged');
    }
    expect(await db.getOperation(vector.cids.agent.canonical)).toEqual(vector.agent);
    expect((await db.getEvents(vector.assetDid)).length).toBe(3);
    expect((await db.getCandidates())[vector.assetDid].length).toBe(3);
});

it.each([false, true])('recovers an asset controlled by a legacy agent DID (asset first: %s)', async assetFirst => {
    const db = new Db('numeric-controller');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    expect(await g.generateDID(vector.numericAgent)).toBe(vector.numericAgentDid);
    if (assetFirst) await g.importEvent(event(vector.legacyControlledAsset));
    await g.importEvent(event(vector.numericAgent));
    if (!assetFirst) await g.importEvent(event(vector.legacyControlledAsset));
    expect((await g.resolveDID(vector.legacyControlledAssetDid, { verify: true })).didDocumentData).toEqual({ legacyController: true });
    expect((await g.resolveDID(vector.legacyAgentDid, { verify: true })).didDocument?.id).toBe(vector.legacyAgentDid);
});

it('recovers a legacy controller referenced only by pending candidates during startup', async () => {
    const db = new Db('numeric-controller-restart');
    await db.setCandidates(vector.numericAgentDid, [event(vector.numericAgent)]);
    await db.setCandidates(vector.legacyControlledAssetDid, [event(vector.legacyControlledAsset)]);
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    expect((await g.resolveDID(vector.legacyControlledAssetDid, { verify: true })).didDocumentData).toEqual({ legacyController: true });
});
