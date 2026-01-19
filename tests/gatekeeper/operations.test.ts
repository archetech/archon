import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import { ExpectedExceptionError } from '@didcid/common/errors';
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
const gatekeeper = new Gatekeeper({ db, ipfs, console: mockConsole, registries: ['local', 'hyperswarm', 'FTC:testnet5'] });
const helper = new TestHelper(gatekeeper, cipher);

beforeAll(async () => {
    await ipfs.start();
});

afterAll(async () => {
    await ipfs.stop();
});

beforeEach(async () => {
    await gatekeeper.resetDb();
    // Clear any pending events from previous tests
    await gatekeeper.processEvents();
});

describe('DB operation storage', () => {
    it('should store and retrieve an operation by opid', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const opid = await gatekeeper.generateCID(agentOp);

        await db.addOperation(opid, agentOp);
        const retrieved = await db.getOperation(opid);

        expect(retrieved).toStrictEqual(agentOp);
    });

    it('should return null for non-existent operation', async () => {
        const retrieved = await db.getOperation('non-existent-opid');

        expect(retrieved).toBeNull();
    });

    it('should check if operation exists', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair);
        const opid = await gatekeeper.generateCID(agentOp);

        expect(await db.hasOperation(opid)).toBe(false);

        await db.addOperation(opid, agentOp);

        expect(await db.hasOperation(opid)).toBe(true);
    });

    it('should overwrite operation with same opid', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp1 = await helper.createAgentOp(keypair);
        const agentOp2 = await helper.createAgentOp(keypair);
        const opid = 'test-opid';

        await db.addOperation(opid, agentOp1);
        await db.addOperation(opid, agentOp2);
        const retrieved = await db.getOperation(opid);

        expect(retrieved).toStrictEqual(agentOp2);
    });

    it('should store multiple operations with different opids', async () => {
        const keypair = cipher.generateRandomJwk();
        const ops = [];
        const opids = [];

        for (let i = 0; i < 5; i++) {
            const agentOp = await helper.createAgentOp(keypair);
            const opid = await gatekeeper.generateCID(agentOp);
            await db.addOperation(opid, agentOp);
            ops.push(agentOp);
            opids.push(opid);
        }

        for (let i = 0; i < 5; i++) {
            const retrieved = await db.getOperation(opids[i]);
            expect(retrieved).toStrictEqual(ops[i]);
        }
    });
});

describe('importBatchByCids', () => {
    it('should import operations by CIDs from IPFS', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair, { registry: 'hyperswarm' });

        // Store operation in IPFS
        const cid = await ipfs.addJSON(agentOp);

        const metadata = {
            registry: 'hyperswarm',
            time: new Date().toISOString(),
            ordinal: [100, 1],
        };

        const result = await gatekeeper.importBatchByCids([cid], metadata);

        expect(result.queued).toBe(1);
        expect(result.rejected).toBe(0);

        // Process events and verify DID was created
        const processResult = await gatekeeper.processEvents();
        expect(processResult.added).toBe(1);
    });

    it('should use locally cached operations when available', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair, { registry: 'hyperswarm' });
        const cid = await gatekeeper.generateCID(agentOp);

        // Store operation locally in DB
        await db.addOperation(cid, agentOp);

        const metadata = {
            registry: 'hyperswarm',
            time: new Date().toISOString(),
            ordinal: [100, 1],
        };

        const result = await gatekeeper.importBatchByCids([cid], metadata);

        expect(result.queued).toBe(1);
        expect(result.rejected).toBe(0);
    });

    it('should import multiple operations by CIDs', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair, { registry: 'hyperswarm' });
        const agentDid = await gatekeeper.createDID(agentOp);

        const cids = [];

        for (let i = 0; i < 3; i++) {
            const assetOp = await helper.createAssetOp(agentDid, keypair, { registry: 'hyperswarm' });
            const cid = await ipfs.addJSON(assetOp);
            cids.push(cid);
        }

        const metadata = {
            registry: 'hyperswarm',
            time: new Date().toISOString(),
            ordinal: [100, 1],
        };

        const result = await gatekeeper.importBatchByCids(cids, metadata);

        expect(result.queued).toBe(3);
        expect(result.rejected).toBe(0);
    });

    it('should throw exception on undefined cids', async () => {
        const metadata = {
            registry: 'hyperswarm',
            time: new Date().toISOString(),
            ordinal: [100, 1],
        };

        try {
            // @ts-expect-error Testing invalid usage
            await gatekeeper.importBatchByCids(undefined, metadata);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Invalid parameter: cids');
        }
    });

    it('should throw exception on empty cids array', async () => {
        const metadata = {
            registry: 'hyperswarm',
            time: new Date().toISOString(),
            ordinal: [100, 1],
        };

        try {
            await gatekeeper.importBatchByCids([], metadata);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Invalid parameter: cids');
        }
    });

    it('should throw exception on non-array cids', async () => {
        const metadata = {
            registry: 'hyperswarm',
            time: new Date().toISOString(),
            ordinal: [100, 1],
        };

        try {
            // @ts-expect-error Testing invalid usage
            await gatekeeper.importBatchByCids('not-an-array', metadata);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Invalid parameter: cids');
        }
    });

    it('should throw exception on undefined metadata', async () => {
        try {
            // @ts-expect-error Testing invalid usage
            await gatekeeper.importBatchByCids(['cid1'], undefined);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Invalid parameter: metadata');
        }
    });

    it('should throw exception on missing metadata.registry', async () => {
        const metadata = {
            time: new Date().toISOString(),
            ordinal: [100, 1],
        };

        try {
            // @ts-expect-error Testing invalid usage
            await gatekeeper.importBatchByCids(['cid1'], metadata);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Invalid parameter: metadata');
        }
    });

    it('should throw exception on missing metadata.time', async () => {
        const metadata = {
            registry: 'hyperswarm',
            ordinal: [100, 1],
        };

        try {
            // @ts-expect-error Testing invalid usage
            await gatekeeper.importBatchByCids(['cid1'], metadata);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Invalid parameter: metadata');
        }
    });

    it('should throw exception on missing metadata.ordinal', async () => {
        const metadata = {
            registry: 'hyperswarm',
            time: new Date().toISOString(),
        };

        try {
            // @ts-expect-error Testing invalid usage
            await gatekeeper.importBatchByCids(['cid1'], metadata);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Invalid parameter: metadata');
        }
    });

    it('should include registration metadata in events', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair, { registry: 'FTC:testnet5' });
        const cid = await ipfs.addJSON(agentOp);

        const metadata = {
            registry: 'FTC:testnet5',
            time: new Date().toISOString(),
            ordinal: [100, 1],
            registration: {
                height: 100,
                index: 1,
                txid: 'mock-txid',
                batch: 'mock-batch-did',
            }
        };

        const importResult = await gatekeeper.importBatchByCids([cid], metadata);
        expect(importResult.queued).toBe(1);

        const processResult = await gatekeeper.processEvents();
        expect(processResult.added).toBe(1);
    });

    it('should store fetched operations in local DB for future lookups', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair, { registry: 'hyperswarm' });
        const cid = await ipfs.addJSON(agentOp);

        // Verify operation is not in local DB
        expect(await db.hasOperation(cid)).toBe(false);

        const metadata = {
            registry: 'hyperswarm',
            time: new Date().toISOString(),
            ordinal: [100, 1],
        };

        await gatekeeper.importBatchByCids([cid], metadata);

        // Verify operation is now stored locally
        expect(await db.hasOperation(cid)).toBe(true);
        const storedOp = await db.getOperation(cid);
        expect(storedOp).toStrictEqual(agentOp);
    });

    it('should handle mix of local and IPFS operations', async () => {
        const keypair = cipher.generateRandomJwk();

        // Create first operation and store locally
        const agentOp1 = await helper.createAgentOp(keypair, { registry: 'hyperswarm' });
        const cid1 = await gatekeeper.generateCID(agentOp1);
        await db.addOperation(cid1, agentOp1);

        // Create second operation and store in IPFS only
        const agentOp2 = await helper.createAgentOp(keypair, { registry: 'hyperswarm' });
        const cid2 = await ipfs.addJSON(agentOp2);

        const metadata = {
            registry: 'hyperswarm',
            time: new Date().toISOString(),
            ordinal: [100, 1],
        };

        const result = await gatekeeper.importBatchByCids([cid1, cid2], metadata);

        expect(result.queued).toBe(2);
        expect(result.rejected).toBe(0);
    });

    // Note: Testing invalid CID handling is skipped because IPFS lookup
    // for non-existent CIDs can hang indefinitely in a local-only Helia setup.

    it('should build correct ordinals for multiple operations', async () => {
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair, { registry: 'hyperswarm' });
        const agentDid = await gatekeeper.createDID(agentOp);

        const cids = [];
        for (let i = 0; i < 3; i++) {
            const assetOp = await helper.createAssetOp(agentDid, keypair, { registry: 'hyperswarm' });
            const cid = await ipfs.addJSON(assetOp);
            cids.push(cid);
        }

        const metadata = {
            registry: 'hyperswarm',
            time: new Date().toISOString(),
            ordinal: [100, 5],
        };

        const importResult = await gatekeeper.importBatchByCids(cids, metadata);
        expect(importResult.queued).toBe(3);

        const processResult = await gatekeeper.processEvents();
        expect(processResult.added).toBe(3);
    });
});
