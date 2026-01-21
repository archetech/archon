import { BlockInfo } from '@didcid/gatekeeper/types';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import { ExpectedExceptionError } from '@didcid/common/errors';
import HeliaClient from '@didcid/ipfs/helia';
import { generateCID } from '@didcid/ipfs/utils';

const mockConsole = {
    log: (): void => { },
    error: (): void => { },
    time: (): void => { },
    timeEnd: (): void => { },
} as unknown as typeof console;

const db = new DbJsonMemory('test');
const ipfs = new HeliaClient();
const gatekeeper = new Gatekeeper({ db, ipfs, console: mockConsole, registries: ['local', 'hyperswarm', 'FTC:testnet5'] });

beforeAll(async () => {
    await ipfs.start();
});

afterAll(async () => {
    await ipfs.stop();
});

beforeEach(async () => {
    await gatekeeper.resetDb();  // Reset database for each test to ensure isolation
});

describe('addJSON', () => {
    const data = { key: 'mock' };

    it('should create CID from data', async () => {
        const hash = await generateCID(data);
        const cid = await gatekeeper.addJSON(data);

        expect(cid).toBe(hash);
    });
});

describe('getJSON', () => {
    const mockData = { key: 'mock' };

    it('should return JSON data from CID', async () => {
        const cid = await gatekeeper.addJSON(mockData);
        const data = await gatekeeper.getJSON(cid);

        expect(data).toStrictEqual(mockData);
    });
});

describe('addText', () => {
    const mockData = 'mock text data';

    it('should create CID from text data', async () => {
        const hash = await generateCID(mockData);
        const cid = await gatekeeper.addText(mockData);

        expect(cid).toBe(hash);
    });
});

describe('getText', () => {
    const mockData = 'mock text data';

    it('should return text data from CID', async () => {
        const cid = await gatekeeper.addText(mockData);
        const data = await gatekeeper.getText(cid);

        expect(data).toBe(mockData);
    });
});

describe('addData', () => {
    const mockData = Buffer.from('mock data');

    it('should create CID from text data', async () => {
        const hash = await generateCID(mockData);
        const cid = await gatekeeper.addData(mockData);

        expect(cid).toBe(hash);
    });
});

describe('getData', () => {
    const mockData = Buffer.from('mock data');

    it('should return text data from CID', async () => {
        const cid = await gatekeeper.addData(mockData);
        const data = await gatekeeper.getData(cid);

        expect(data).toStrictEqual(mockData);
    });
});

const mockBlock: BlockInfo = {
    height: 100,
    hash: 'mockHash',
    time: 100,
};

const mockBlock2: BlockInfo = {
    height: 200,
    hash: 'mockHash2',
    time: 200,
};

describe('addBlock', () => {
    it('should add a new block', async () => {
        const ok = await gatekeeper.addBlock('local', mockBlock);

        expect(ok).toStrictEqual(true);
    });

    it('should throw exception on invalid registry', async () => {
        try {
            await gatekeeper.addBlock('mock', mockBlock);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: registry=mock');
        }
    });
});

describe('getBlock', () => {
    it('should get a block by height', async () => {
        await gatekeeper.addBlock('local', mockBlock);
        const block = await gatekeeper.getBlock('local', mockBlock.height);

        expect(block).toStrictEqual(mockBlock);
    });

    it('should get a block by hash', async () => {
        await gatekeeper.addBlock('local', mockBlock);
        const block = await gatekeeper.getBlock('local', mockBlock.hash);

        expect(block).toStrictEqual(mockBlock);
    });

    it('should get max height block', async () => {
        await gatekeeper.addBlock('local', mockBlock2);
        await gatekeeper.addBlock('local', mockBlock);
        const block = await gatekeeper.getBlock('local');

        expect(block).toStrictEqual(mockBlock2);
    });

    it('should return null when no blocks', async () => {
        const block = await gatekeeper.getBlock('local');

        expect(block).toStrictEqual(null);
    });

    it('should return null for unknown block height', async () => {
        await gatekeeper.addBlock('local', mockBlock);
        const block = await gatekeeper.getBlock('local', 0);

        expect(block).toStrictEqual(null);
    });

    it('should return null for unknown block hash', async () => {
        await gatekeeper.addBlock('local', mockBlock);
        const block = await gatekeeper.getBlock('local', 'zero');

        expect(block).toStrictEqual(null);
    });

    it('should throw exception on invalid registry', async () => {
        try {
            await gatekeeper.addBlock('local', mockBlock);
            await gatekeeper.getBlock('mock', mockBlock.height);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: registry=mock');
        }
    });
});
