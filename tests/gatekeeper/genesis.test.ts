import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import Db from '@didcid/gatekeeper/db/json-memory';
import MemoryClient from '@didcid/ipfs/memory';

const fixture = JSON.parse(readFileSync('tests/fixtures/batch-publisher-history.json', 'utf8'));

it('retrieves signed genesis with no publisher history, without importing it', async () => {
    const db = new Db('genesis');
    const ipfs = new MemoryClient();
    const g = new Gatekeeper({ db, ipfs });
    await ipfs.addJSON(fixture.batch, { canonical: true });
    expect(await g.getGenesis(fixture.batchDid)).toEqual(fixture.batch);
    expect(await db.getAllKeys()).toEqual([]);
    expect(await db.getCandidates()).toEqual({});
    expect((await g.resolveDID(fixture.batchDid)).didResolutionMetadata?.error).toBe('notFound');
});

it('rejects unavailable, mismatched, and non-create content', async () => {
    const ipfs = new MemoryClient();
    const g = new Gatekeeper({ db: new Db('genesis'), ipfs });
    await expect(g.getGenesis('invalid')).rejects.toThrow();
    await expect(g.getGenesis(fixture.batchDid)).rejects.toThrow();
    jest.spyOn(ipfs, 'getJSON').mockResolvedValueOnce(fixture.publisher);
    await expect(g.getGenesis(fixture.batchDid)).rejects.toThrow();
    const cid = await ipfs.addJSON(fixture.rotation, { canonical: true });
    await expect(g.getGenesis(`did:cid:${cid}`)).rejects.toThrow();
});

it.each(['proof', 'created', 'registration', 'controller'])('rejects a create missing %s even at its own CID', async field => {
    const ipfs = new MemoryClient();
    const g = new Gatekeeper({ db: new Db('genesis'), ipfs });
    const operation = structuredClone(fixture.batch);
    delete operation[field];
    const cid = await ipfs.addJSON(operation, { canonical: true });
    await expect(g.getGenesis(`did:cid:${cid}`)).rejects.toThrow();
});

it('retrieves agent genesis but rejects malformed embedded keys', async () => {
    const ipfs = new MemoryClient();
    const g = new Gatekeeper({ db: new Db('genesis'), ipfs });
    const cid = await ipfs.addJSON(fixture.publisher, { canonical: true });
    expect(await g.getGenesis(`did:cid:${cid}`)).toEqual(fixture.publisher);
    const malformed = { ...fixture.publisher, publicJwk: null };
    const badCid = await ipfs.addJSON(malformed, { canonical: true });
    await expect(g.getGenesis(`did:cid:${badCid}`)).rejects.toThrow();
});

it('uses cached content without IPFS or accepted history and returns an independent value', async () => {
    const db = new Db('genesis-cache');
    const ipfs = new MemoryClient();
    const g = new Gatekeeper({ db, ipfs });
    const cid = fixture.batchDid.split(':').pop();
    await db.addOperation(cid, structuredClone(fixture.batch));
    const fetch = jest.spyOn(ipfs, 'getJSON');
    const genesis = await g.getGenesis(fixture.batchDid);
    expect(genesis).toEqual(fixture.batch);
    genesis.proof!.proofValue = 'caller edit';
    expect(await g.getGenesis(fixture.batchDid)).toEqual(fixture.batch);
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.getAllKeys()).toEqual([]);
});
