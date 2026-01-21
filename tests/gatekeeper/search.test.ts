import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import HeliaClient from '@didcid/ipfs/helia';
import TestHelper from './helper.ts';

const mockConsole = {
    log: (): void => { },
    error: (): void => { },
    time: (): void => { },
    timeEnd: (): void => { },
} as unknown as typeof console;

const cipher = new CipherNode();
const db = new DbJsonMemory('test');
const ipfs = new HeliaClient();
const gatekeeper = new Gatekeeper({ db, ipfs, console: mockConsole, registries: ['local', 'hyperswarm'] });
const helper = new TestHelper(gatekeeper, cipher);

beforeAll(async () => {
    await ipfs.start();
});

afterAll(async () => {
    await ipfs.stop();
});

beforeEach(async () => {
    await gatekeeper.resetDb();
});

describe('searchDocs', () => {
    it('should return empty array when no DIDs exist', async () => {
        const results = await gatekeeper.searchDocs('test');
        expect(results).toEqual([]);
    });

    it('should find DID by text in didDocumentData', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        // Create asset with searchable data
        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { title: 'UniqueSearchTerm123', content: 'some content' }
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        const results = await gatekeeper.searchDocs('UniqueSearchTerm123');
        expect(results).toContain(assetDid);
    });

    it('should not find DID when search term is not in didDocumentData', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { title: 'hello', content: 'world' }
        });
        await gatekeeper.createDID(assetOp);

        const results = await gatekeeper.searchDocs('nonexistent');
        expect(results).toEqual([]);
    });

    it('should find multiple DIDs matching search term', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const asset1Op = await helper.createAssetOp(agentDid, keypair, {
            data: { category: 'SharedCategory' }
        });
        const asset1Did = await gatekeeper.createDID(asset1Op);

        const asset2Op = await helper.createAssetOp(agentDid, keypair, {
            data: { category: 'SharedCategory' }
        });
        const asset2Did = await gatekeeper.createDID(asset2Op);

        const results = await gatekeeper.searchDocs('SharedCategory');
        expect(results).toContain(asset1Did);
        expect(results).toContain(asset2Did);
        expect(results.length).toBe(2);
    });

    it('should not search in didDocument metadata fields', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        // Search for the DID itself - should not find it since we only index didDocumentData
        const results = await gatekeeper.searchDocs(agentDid);
        expect(results).toEqual([]);
    });
});

describe('queryDocs', () => {
    it('should return empty array when no DIDs match query', async () => {
        const results = await gatekeeper.queryDocs({
            'type': { $in: ['nonexistent'] }
        });
        expect(results).toEqual([]);
    });

    it('should find DID by exact field match', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { type: 'credential', issuer: agentDid }
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        const results = await gatekeeper.queryDocs({
            'type': { $in: ['credential'] }
        });
        expect(results).toContain(assetDid);
    });

    it('should find DID by nested field match', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { notice: { to: [agentDid], message: 'hello' } }
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        const results = await gatekeeper.queryDocs({
            'notice.to[*]': { $in: [agentDid] }
        });
        expect(results).toContain(assetDid);
    });

    it('should return empty for array wildcard when no match', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { notice: { to: ['did:cid:other'], message: 'hello' } }
        });
        await gatekeeper.createDID(assetOp);

        const results = await gatekeeper.queryDocs({
            'notice.to[*]': { $in: [agentDid] }
        });
        expect(results).toEqual([]);
    });

    it('should throw error for unsupported query operators', async () => {
        await expect(gatekeeper.queryDocs({
            'field': { $eq: 'value' }
        })).rejects.toThrow('Only {$in:[...]} supported');
    });

    it('should return empty array for empty where clause', async () => {
        const results = await gatekeeper.queryDocs({});
        expect(results).toEqual([]);
    });

    it('should support key wildcard queries', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { properties: { color: 'red', size: 'large' } }
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        const results = await gatekeeper.queryDocs({
            'properties.*': { $in: ['color'] }
        });
        expect(results).toContain(assetDid);
    });

    it('should support value wildcard queries', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { items: { item1: { name: 'apple' }, item2: { name: 'banana' } } }
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        const results = await gatekeeper.queryDocs({
            'items.*.name': { $in: ['apple'] }
        });
        expect(results).toContain(assetDid);
    });

    it('should support array mid wildcard queries', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { users: [{ role: 'admin' }, { role: 'user' }] }
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        const results = await gatekeeper.queryDocs({
            'users[*].role': { $in: ['admin'] }
        });
        expect(results).toContain(assetDid);
    });
});

describe('search index lifecycle', () => {
    it('should update search index when DID is updated', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { title: 'OriginalTitle' }
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        // Verify original title is searchable
        let results = await gatekeeper.searchDocs('OriginalTitle');
        expect(results).toContain(assetDid);

        // Update the asset
        const updateOp = await helper.createUpdateOp(keypair, assetDid, {
            didDocumentData: { title: 'UpdatedTitle' }
        });
        await gatekeeper.updateDID(updateOp);

        // Original title should no longer be found
        results = await gatekeeper.searchDocs('OriginalTitle');
        expect(results).toEqual([]);

        // Updated title should be found
        results = await gatekeeper.searchDocs('UpdatedTitle');
        expect(results).toContain(assetDid);
    });

    it('should remove DID from search index when deleted', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { title: 'ToBeDeleted' }
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        // Verify it's searchable
        let results = await gatekeeper.searchDocs('ToBeDeleted');
        expect(results).toContain(assetDid);

        // Delete the DID
        const deleteOp = await helper.createDeleteOp(keypair, assetDid);
        await gatekeeper.deleteDID(deleteOp);

        // Should no longer be found
        results = await gatekeeper.searchDocs('ToBeDeleted');
        expect(results).toEqual([]);
    });

    it('should remove DID from search index via removeDIDs', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { title: 'ToBeRemoved' }
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        // Verify it's searchable
        let results = await gatekeeper.searchDocs('ToBeRemoved');
        expect(results).toContain(assetDid);

        // Remove via removeDIDs
        await gatekeeper.removeDIDs([assetDid]);

        // Should no longer be found
        results = await gatekeeper.searchDocs('ToBeRemoved');
        expect(results).toEqual([]);
    });

    it('should clear search index on resetDb', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { title: 'BeforeReset' }
        });
        await gatekeeper.createDID(assetOp);

        // Verify it's searchable
        let results = await gatekeeper.searchDocs('BeforeReset');
        expect(results.length).toBe(1);

        // Reset DB
        await gatekeeper.resetDb();

        // Should be empty
        results = await gatekeeper.searchDocs('BeforeReset');
        expect(results).toEqual([]);
    });
});

describe('initSearchIndex', () => {
    it('should rebuild index from existing DIDs', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { title: 'IndexRebuild' }
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        // Manually clear and rebuild the index
        await gatekeeper.resetDb();

        // Re-create the DIDs
        await gatekeeper.createDID(agentOp);
        await gatekeeper.createDID(assetOp);

        // Re-init the search index
        await gatekeeper.initSearchIndex();

        // Should find the DID
        const results = await gatekeeper.searchDocs('IndexRebuild');
        expect(results).toContain(assetDid);
    });
});

describe('store edge cases', () => {
    it('should store empty object when didDocumentData is primitive', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        // Create asset with primitive data (string instead of object)
        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: 'just a string'
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        // Should not find the string since primitive data becomes empty object
        const results = await gatekeeper.searchDocs('just a string');
        expect(results).not.toContain(assetDid);
    });
});

describe('queryDocs path edge cases', () => {
    it('should handle array index in path', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { items: ['first', 'second', 'third'] }
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        // Query for specific array index
        const results = await gatekeeper.queryDocs({
            'items.1': { $in: ['second'] }
        });
        expect(results).toContain(assetDid);
    });

    it('should handle $.prefix in path', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { name: 'test' }
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        // Query with $. prefix (JSONPath style)
        const results = await gatekeeper.queryDocs({
            '$.name': { $in: ['test'] }
        });
        expect(results).toContain(assetDid);
    });

    it('should handle $ prefix without dot in path', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { name: 'test' }
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        // Query with $ prefix (root reference)
        const results = await gatekeeper.queryDocs({
            '$name': { $in: ['test'] }
        });
        expect(results).toContain(assetDid);
    });

    it('should return empty when path traverses primitive', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { name: 'test' }
        });
        await gatekeeper.createDID(assetOp);

        // Try to traverse through a string (primitive)
        const results = await gatekeeper.queryDocs({
            'name.nested': { $in: ['anything'] }
        });
        expect(results).toEqual([]);
    });

    it('should handle nested array access', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const agentDid = await gatekeeper.createDID(agentOp);

        const assetOp = await helper.createAssetOp(agentDid, keypair, {
            data: { matrix: [[1, 2], [3, 4]] }
        });
        const assetDid = await gatekeeper.createDID(assetOp);

        // Query nested array index
        const results = await gatekeeper.queryDocs({
            'matrix.0.1': { $in: [2] }
        });
        expect(results).toContain(assetDid);
    });
});
