import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import HeliaClient from '@didcid/ipfs/helia';
import { generateCID } from '@didcid/ipfs/utils';

let ipfs: HeliaClient;
let gatekeeper: Gatekeeper;
let wallet: WalletJsonMemory;
let cipher: CipherNode;
let keymaster: Keymaster;

beforeAll(async () => {
    ipfs = new HeliaClient();
    await ipfs.start();
});

afterAll(async () => {
    if (ipfs) {
        await ipfs.stop();
    }
});

beforeEach(() => {
    const db = new DbJsonMemory('test');
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm', 'BTC:signet'] });
    wallet = new WalletJsonMemory();
    cipher = new CipherNode();
    keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase: 'passphrase' });
});

describe('createFile', () => {
    it('should create DID from text data', async () => {
        const mockFile = Buffer.from('This is a mock text document.', 'utf-8');
        const cid = await generateCID(mockFile);
        const filename = 'mockFile.txt';

        const ownerDid = await keymaster.createId('Bob');
        const dataDid = await keymaster.createFile(mockFile, { filename });
        const doc = await keymaster.resolveDID(dataDid);

        expect(doc.didDocument!.id).toBe(dataDid);
        expect(doc.didDocument!.controller).toBe(ownerDid);

        const expected = {
            file: {
                cid,
                filename,
                bytes: 29,
                // eslint-disable-next-line
                type: 'text/plain',
            }
        };

        expect(doc.didDocumentData).toStrictEqual(expected);
    });

    it('should create DID from binary data', async () => {
        const mockFile = Buffer.from([0x00, 0xFF, 0xAB, 0xCD, 0x01, 0x02, 0x03, 0x04]);
        const cid = await generateCID(mockFile);
        const filename = 'mockFile.bin';

        const ownerDid = await keymaster.createId('Bob');
        const dataDid = await keymaster.createFile(mockFile, { filename });
        const doc = await keymaster.resolveDID(dataDid);

        expect(doc.didDocument!.id).toBe(dataDid);
        expect(doc.didDocument!.controller).toBe(ownerDid);

        const expected = {
            file: {
                cid,
                filename,
                bytes: 8,
                type: 'application/octet-stream',
            }
        };

        expect(doc.didDocumentData).toStrictEqual(expected);
    });

    it('should handle case where no filename is provided', async () => {
        const mockFile = Buffer.from('This is another mock binary document.', 'utf-8');
        const cid = await generateCID(mockFile);

        const ownerDid = await keymaster.createId('Bob');
        const dataDid = await keymaster.createFile(mockFile);
        const doc = await keymaster.resolveDID(dataDid);

        expect(doc.didDocument!.id).toBe(dataDid);
        expect(doc.didDocument!.controller).toBe(ownerDid);

        const expected = {
            file: {
                cid,
                filename: 'file',
                bytes: 37,
                type: 'text/plain',
            }
        };

        expect(doc.didDocumentData).toStrictEqual(expected);
    });

    it('should handle case where filename has no extension', async () => {
        const mockFile = Buffer.from('This is another mock document.', 'utf-8');
        const cid = await generateCID(mockFile);
        const filename = 'mockFile';

        const ownerDid = await keymaster.createId('Bob');
        const dataDid = await keymaster.createFile(mockFile, { filename });
        const doc = await keymaster.resolveDID(dataDid);

        expect(doc.didDocument!.id).toBe(dataDid);
        expect(doc.didDocument!.controller).toBe(ownerDid);

        const expected = {
            file: {
                cid,
                filename,
                bytes: 30,
                type: 'text/plain',
            }
        };

        expect(doc.didDocumentData).toStrictEqual(expected);
    });
});

describe('updateFile', () => {
    it('should update named DID from file data', async () => {
        const mockFile_v1 = Buffer.from('This is the first version.', 'utf-8');
        const mockFile_v2 = Buffer.from('This is the second version.', 'utf-8');
        const cid = await generateCID(mockFile_v2);
        const name = 'mockFile';
        const filename = 'mockFile.txt';

        await keymaster.createId('Bob');
        await keymaster.createFile(mockFile_v1, { alias: name, filename });
        const ok = await keymaster.updateFile(name, mockFile_v2, { filename });
        const doc = await keymaster.resolveDID(name);

        const expected = {
            file: {
                cid,
                filename,
                bytes: 27,
                type: 'text/plain',
            }
        };

        expect(ok).toBe(true);
        expect(doc.didDocumentData).toStrictEqual(expected);
        expect(doc.didDocumentMetadata!.versionSequence).toBe("2");
    });

    it('should handle case where no filename is provided', async () => {
        const mockFile_v1 = Buffer.from('This is another first version.', 'utf-8');
        const mockFile_v2 = Buffer.from('This is another second version.', 'utf-8');
        const cid = await generateCID(mockFile_v2);
        const name = 'mockFile';

        await keymaster.createId('Bob');
        await keymaster.createFile(mockFile_v1, { alias: name });
        const ok = await keymaster.updateFile(name, mockFile_v2);
        const doc = await keymaster.resolveDID(name);

        const expected = {
            file: {
                cid,
                filename: 'file',
                bytes: 31,
                type: 'text/plain',
            }
        };

        expect(ok).toBe(true);
        expect(doc.didDocumentData).toStrictEqual(expected);
        expect(doc.didDocumentMetadata!.versionSequence).toBe("2");
    });

    it('should handle case where filename has no extension', async () => {
        const mockFile_v1 = Buffer.from('This is yet another first version.', 'utf-8');
        const mockFile_v2 = Buffer.from('This is yet another second version.', 'utf-8');
        const cid = await generateCID(mockFile_v2);
        const name = 'mockFile';
        const filename = 'mockFile';

        await keymaster.createId('Bob');
        await keymaster.createFile(mockFile_v1, { alias: name, filename });
        const ok = await keymaster.updateFile(name, mockFile_v2, { filename });
        const doc = await keymaster.resolveDID(name);

        const expected = {
            file: {
                cid,
                filename,
                bytes: 35,
                type: 'text/plain',
            }
        };

        expect(ok).toBe(true);
        expect(doc.didDocumentData).toStrictEqual(expected);
        expect(doc.didDocumentMetadata!.versionSequence).toBe("2");
    });
});

describe('getFile', () => {
    it('should return the file asset', async () => {
        const mockFile = Buffer.from('This is a mock binary document.', 'utf-8');
        const cid = await generateCID(mockFile);
        const filename = 'mockFile.txt';

        await keymaster.createId('Bob');
        const did = await keymaster.createFile(mockFile, { filename });
        const asset = await keymaster.getFile(did);

        const file = {
            cid,
            filename,
            bytes: 31,
            type: 'text/plain',
        };

        expect(asset).toStrictEqual(file);
    });
});

describe('testFile', () => {
    it('should return true for file DID', async () => {
        const mockFile = Buffer.from('This is a test document.', 'utf-8');

        await keymaster.createId('Bob');
        const did = await keymaster.createFile(mockFile);
        const isFile = await keymaster.testFile(did);

        expect(isFile).toBe(true);
    });

    it('should return true for file name', async () => {
        const mockFile = Buffer.from('This is another test document.', 'utf-8');

        await keymaster.createId('Bob');
        const name = 'mockFile';
        await keymaster.createFile(mockFile, { alias: name });
        const isFile = await keymaster.testFile(name);

        expect(isFile).toBe(true);
    });

    it('should return false for non-file DID', async () => {
        await keymaster.createId('Bob');
        const did = await keymaster.createAsset({ name: 'mockAnchor' });
        const isFile = await keymaster.testFile(did);

        expect(isFile).toBe(false);
    });

    it('should return false if no DID specified', async () => {
        // @ts-expect-error Testing invalid usage, missing arg
        const isFile = await keymaster.testFile();
        expect(isFile).toBe(false);
    });

    it('should return false if invalid DID specified', async () => {
        const isFile = await keymaster.testFile('mock');
        expect(isFile).toBe(false);
    });
});
