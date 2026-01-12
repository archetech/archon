import mockFs from 'mock-fs';
import HeliaClient from '@didcid/ipfs/helia';
import { ExpectedExceptionError } from '@didcid/common/errors';
import { generateCID } from '@didcid/ipfs/utils';

describe('start', () => {
    it('should ignore a second call to start', async () => {
        const ipfs = await HeliaClient.create();
        await ipfs.start();
        await ipfs.stop();
    });
});

describe('stop', () => {
    it('should ignore a second call to stop', async () => {
        const ipfs = await HeliaClient.create();
        await ipfs.stop();
        await ipfs.stop();
    });
});

describe('addJSON', () => {
    const data = { key: 'mock' };

    it('should create CID from data', async () => {
        const hash = await generateCID(data);
        const ipfs = await HeliaClient.create();
        const cid = await ipfs.addJSON(data);
        await ipfs.stop();

        expect(cid).toBe(hash);
    });

    it('should create CID from data without using helia', async () => {
        const hash = await generateCID(data);
        const ipfs = await HeliaClient.create({ minimal: true });
        const cid = await ipfs.addJSON(data);

        expect(cid).toBe(hash);
    });

    it('should create CID from data with fs blockstore', async () => {
        const hash = await generateCID(data);
        mockFs({});
        const ipfs = await HeliaClient.create({ datadir: 'ipfs' });
        const cid = await ipfs.addJSON(data);
        await ipfs.stop();
        mockFs.restore();

        expect(cid).toBe(hash);
    });
});

describe('getJSON', () => {
    const mockData = { key: 'mock' };

    it('should return JSON data from CID', async () => {
        const ipfs = await HeliaClient.create();
        const cid = await ipfs.addJSON(mockData);
        const data = await ipfs.getJSON(cid);
        await ipfs.stop();

        expect(data).toStrictEqual(mockData);
    });

    it('should return JSON data from CID with fs blockstore', async () => {
        mockFs({});

        const ipfs = await HeliaClient.create({ datadir: 'ipfs' });
        const cid = await ipfs.addJSON(mockData);
        const data = await ipfs.getJSON(cid);
        await ipfs.stop();
        mockFs.restore();

        expect(data).toStrictEqual(mockData);
    });

    // eslint-disable-next-line
    it('should return throw exception if not connected', async () => {
        const ipfs = new HeliaClient();
        const cid = await ipfs.addJSON(mockData);

        try {
            await ipfs.getJSON(cid);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            // eslint-disable-next-line
            expect(error.message).toBe('Not connected');
        }
    });
});

describe('addText', () => {
    const mockData = 'mock text data';

    it('should create CID from text data', async () => {
        const hash = await generateCID(mockData);
        const ipfs = await HeliaClient.create();
        const cid = await ipfs.addText(mockData);
        await ipfs.stop();

        expect(cid).toBe(hash);
    });

    it('should create CID from text data without using helia', async () => {
        const hash = await generateCID(mockData);
        const ipfs = await HeliaClient.create({ minimal: true });
        const cid = await ipfs.addText(mockData);

        expect(cid).toBe(hash);
    });

    it('should create CID from text data with fs blockstore', async () => {
        const hash = await generateCID(mockData);
        mockFs({});
        const ipfs = await HeliaClient.create({ datadir: 'ipfs' });
        const cid = await ipfs.addText(mockData);
        await ipfs.stop();
        mockFs.restore();

        expect(cid).toBe(hash);
    });
});

describe('getText', () => {
    const mockData = 'mock text data';

    it('should return text data from CID', async () => {
        const ipfs = await HeliaClient.create();
        const cid = await ipfs.addText(mockData);
        const data = await ipfs.getText(cid);
        await ipfs.stop();

        expect(data).toBe(mockData);
    });

    it('should return text data from CID with fs blockstore', async () => {
        mockFs({});

        const ipfs = await HeliaClient.create({ datadir: 'ipfs' });
        const cid = await ipfs.addText(mockData);
        const data = await ipfs.getText(cid);
        await ipfs.stop();
        mockFs.restore();

        expect(data).toStrictEqual(mockData);
    });

    it('should return throw exception if not connected', async () => {
        const ipfs = new HeliaClient();
        const cid = await ipfs.addText(mockData);

        try {
            await ipfs.getText(cid);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Not connected');
        }
    });
});

describe('addData', () => {
    const mockData = Buffer.from('mock data');

    it('should create CID from text data', async () => {
        const hash = await generateCID(mockData);
        const ipfs = await HeliaClient.create();
        const cid = await ipfs.addData(mockData);
        await ipfs.stop();

        expect(cid).toBe(hash);
    });

    it('should create CID from text data without using helia', async () => {
        const hash = await generateCID(mockData);
        const ipfs = await HeliaClient.create({ minimal: true });
        const cid = await ipfs.addData(mockData);

        expect(cid).toBe(hash);
    });

    it('should create CID from text data with fs blockstore', async () => {
        const hash = await generateCID(mockData);
        mockFs({});
        const ipfs = await HeliaClient.create({ datadir: 'ipfs' });
        const cid = await ipfs.addData(mockData);
        await ipfs.stop();
        mockFs.restore();

        expect(cid).toBe(hash);
    });
});


describe('getData', () => {
    const mockData = Buffer.from('mock data');

    it('should return text data from CID', async () => {
        const ipfs = await HeliaClient.create();
        const cid = await ipfs.addData(mockData);
        const data = await ipfs.getData(cid);
        await ipfs.stop();

        expect(data).toStrictEqual(mockData);
    });

    it('should return text data from CID with fs blockstore', async () => {
        mockFs({});

        const ipfs = await HeliaClient.create({ datadir: 'ipfs' });
        const cid = await ipfs.addData(mockData);
        const data = await ipfs.getData(cid);
        await ipfs.stop();
        mockFs.restore();

        expect(data).toStrictEqual(mockData);
    });

    it('should return throw exception if not connected', async () => {
        const ipfs = new HeliaClient();
        const cid = await ipfs.addData(mockData);

        try {
            await ipfs.getData(cid);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Not connected');
        }
    });
});
