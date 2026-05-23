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
const gatekeeper = new Gatekeeper({ db, ipfs, console: mockConsole, registries: ['local', 'hyperswarm', 'BTC:signet'] });
const helper = new TestHelper(gatekeeper, cipher);

function newGatekeeper(registries: string[]): Gatekeeper {
    return new Gatekeeper({
        db: new DbJsonMemory('test'),
        ipfs,
        console: mockConsole,
        registries,
    });
}

beforeAll(async () => {
    await ipfs.start();
});

afterAll(async () => {
    await ipfs.stop();
});

beforeEach(async () => {
    await gatekeeper.resetDb();  // Reset database for each test to ensure isolation
});

describe('getQueue', () => {

    it('should return empty list when no events in queue', async () => {
        const registry = 'BTC:signet';

        const queue = await gatekeeper.getQueue(registry);

        expect(queue).toStrictEqual([]);
    });

    it('should return events in queue', async () => {
        const registry = 'BTC:signet';
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair, { version: 1, registry });
        const did = await gatekeeper.createDID(agentOp);
        const doc = await gatekeeper.resolveDID(did);
        doc.didDocumentData = { mock: 1 };
        const updateOp = await helper.createUpdateOp(keypair, did, doc);
        await gatekeeper.updateDID(updateOp);

        const queue = await gatekeeper.getQueue(registry);

        expect(queue).toStrictEqual([agentOp, updateOp]);
    });

    it('should throw an exception if invalid registry', async () => {
        try {
            await gatekeeper.getQueue('mock registry');
            throw new ExpectedExceptionError();
        } catch (error: any) {
            // eslint-disable-next-line
            expect(error.message).toBe('Invalid parameter: registry=mock registry');
        }
    });
});

describe('filecoin queue', () => {

    it('should queue non-local operations to filecoin when supported', async () => {
        const gk = newGatekeeper(['local', 'hyperswarm', 'BTC:signet', 'filecoin']);
        await gk.resetDb();
        const testHelper = new TestHelper(gk, cipher);
        const registry = 'BTC:signet';
        const keypair = cipher.generateRandomJwk();
        const agentOp = await testHelper.createAgentOp(keypair, { version: 1, registry });

        await gk.createDID(agentOp);

        expect(await gk.getQueue(registry)).toStrictEqual([agentOp]);
        expect(await gk.getQueue('hyperswarm')).toStrictEqual([agentOp]);
        expect(await gk.getQueue('filecoin')).toStrictEqual([agentOp]);
    });

    it('should queue non-local operations to filecoin after mediator self-registers', async () => {
        const gk = newGatekeeper(['local', 'hyperswarm', 'BTC:signet']);
        await gk.resetDb();
        const testHelper = new TestHelper(gk, cipher);
        const registry = 'BTC:signet';
        const keypair = cipher.generateRandomJwk();
        const agentOp = await testHelper.createAgentOp(keypair, { version: 1, registry });

        expect(await gk.getQueue('filecoin')).toStrictEqual([]);
        await gk.createDID(agentOp);

        expect(await gk.getQueue(registry)).toStrictEqual([agentOp]);
        expect(await gk.getQueue('filecoin')).toStrictEqual([agentOp]);
    });

    it('should not queue operations to filecoin when unsupported', async () => {
        const gk = newGatekeeper(['local', 'hyperswarm', 'BTC:signet']);
        await gk.resetDb();
        const testHelper = new TestHelper(gk, cipher);
        const registry = 'BTC:signet';
        const keypair = cipher.generateRandomJwk();
        const agentOp = await testHelper.createAgentOp(keypair, { version: 1, registry });

        await gk.createDID(agentOp);

        expect(await gk.getQueue(registry)).toStrictEqual([agentOp]);
        expect(await gk.getQueue('filecoin')).toStrictEqual([]);
    });

    it('should not queue local operations to filecoin', async () => {
        const gk = newGatekeeper(['local', 'hyperswarm', 'filecoin']);
        await gk.resetDb();
        const testHelper = new TestHelper(gk, cipher);
        const keypair = cipher.generateRandomJwk();
        const agentOp = await testHelper.createAgentOp(keypair, { version: 1, registry: 'local' });

        await gk.createDID(agentOp);

        expect(await gk.getQueue('hyperswarm')).toStrictEqual([]);
        expect(await gk.getQueue('filecoin')).toStrictEqual([]);
    });

    it('should reject filecoin as a DID registry', async () => {
        const gk = newGatekeeper(['local', 'hyperswarm', 'filecoin']);
        await gk.resetDb();
        const testHelper = new TestHelper(gk, cipher);
        const keypair = cipher.generateRandomJwk();
        const agentOp = await testHelper.createAgentOp(keypair, { version: 1, registry: 'filecoin' });

        await expect(gk.createDID(agentOp)).rejects.toThrow('Invalid operation: registry filecoin is auxiliary storage only');
    });
});

describe('clearQueue', () => {

    it('should clear non-empty queue', async () => {
        const registry = 'BTC:signet';
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair, { version: 1, registry });
        const did = await gatekeeper.createDID(agentOp);
        const doc = await gatekeeper.resolveDID(did);
        doc.didDocumentData = { mock: 1 };
        const updateOp = await helper.createUpdateOp(keypair, did, doc);
        await gatekeeper.updateDID(updateOp);
        const queue = await gatekeeper.getQueue(registry);

        await gatekeeper.clearQueue(registry, queue);
        const queue2 = await gatekeeper.getQueue(registry);

        expect(queue2).toStrictEqual([]);
    });

    it('should clear only specified events', async () => {
        const registry = 'BTC:signet';
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair, { version: 1, registry });
        const did = await gatekeeper.createDID(agentOp);
        const queue1 = [agentOp];

        for (let i = 0; i < 5; i++) {
            const doc = await gatekeeper.resolveDID(did);
            doc.didDocumentData = { mock: i };
            const updateOp = await helper.createUpdateOp(keypair, did, doc);
            await gatekeeper.updateDID(updateOp);
            queue1.push(updateOp);
        }

        const queue2 = await gatekeeper.getQueue(registry);
        expect(queue2).toStrictEqual(queue1);

        const queue3 = [];
        for (let i = 0; i < 5; i++) {
            const doc = await gatekeeper.resolveDID(did);
            doc.didDocumentData = { mock: i };
            const updateOp = await helper.createUpdateOp(keypair, did, doc);
            await gatekeeper.updateDID(updateOp);
            queue3.push(updateOp);
        }

        await gatekeeper.clearQueue(registry, queue2);
        const queue4 = await gatekeeper.getQueue(registry);
        expect(queue4).toStrictEqual(queue3);
    });

    it('should return true if queue already empty', async () => {
        const ok = await gatekeeper.clearQueue('BTC:signet', []);
        expect(ok).toBe(true);
    });

    it('should return true if invalid queue specified', async () => {
        const registry = 'BTC:signet';
        const keypair = cipher.generateRandomJwk();
        const agentOp = await helper.createAgentOp(keypair, { version: 1, registry });
        const did = await gatekeeper.createDID(agentOp);
        const doc = await gatekeeper.resolveDID(did);
        doc.didDocumentData = { mock: 1 };
        const updateOp = await helper.createUpdateOp(keypair, did, doc);
        await gatekeeper.updateDID(updateOp);
        const queue = await gatekeeper.getQueue(registry);
        await gatekeeper.clearQueue(registry, queue);
        await gatekeeper.getQueue(registry);

        // @ts-expect-error Testing invalid queue
        const ok = await gatekeeper.clearQueue(registry, 'mock');

        expect(ok).toStrictEqual(true);
    });

    it('should throw an exception if invalid registry', async () => {
        try {
            await gatekeeper.clearQueue('mock registry', []);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Invalid parameter: registry=mock registry');
        }
    });
});
