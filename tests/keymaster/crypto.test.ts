import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import { EncryptedMessage } from '@didcid/keymaster/types';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import { ExpectedExceptionError } from '@didcid/common/errors';
import HeliaClient from '@didcid/ipfs/helia';

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
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm', 'FTC:testnet5'] });
    wallet = new WalletJsonMemory();
    cipher = new CipherNode();
    keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase: 'passphrase' });
});

function generateRandomString(length: number) {
    let result = '';
    let characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

describe('encryptMessage', () => {
    it('should encrypt a short message', async () => {
        const name = 'Bob';
        const did = await keymaster.createId(name);

        const msg = 'Hi Bob!';
        const encryptDid = await keymaster.encryptMessage(msg, did, { includeHash: true });
        const doc = await keymaster.resolveDID(encryptDid);
        const data = doc.didDocumentData;
        const msgHash = cipher.hashMessage(msg);

        expect((data as { encrypted: EncryptedMessage }).encrypted.cipher_hash).toBe(msgHash);
    });

    it('should encrypt a long message', async () => {

        const name = 'Bob';
        const did = await keymaster.createId(name);

        const msg = generateRandomString(1024);
        const encryptDid = await keymaster.encryptMessage(msg, did, { includeHash: true });
        const doc = await keymaster.resolveDID(encryptDid);
        const data = doc.didDocumentData;
        const msgHash = cipher.hashMessage(msg);

        expect((data as { encrypted: EncryptedMessage }).encrypted.cipher_hash).toBe(msgHash);
    });
});

describe('decryptMessage', () => {
    it('should decrypt a short message encrypted by same ID', async () => {
        const name = 'Bob';
        const did = await keymaster.createId(name);

        const msg = 'Hi Bob!';
        const encryptDid = await keymaster.encryptMessage(msg, did);
        const decipher = await keymaster.decryptMessage(encryptDid);

        expect(decipher).toBe(msg);
    });

    it('should decrypt a short message after rotating keys (confirmed)', async () => {
        const did = await keymaster.createId('Bob', { registry: 'local' });
        const msg = 'Hi Bob!';
        await keymaster.rotateKeys();
        const encryptDid = await keymaster.encryptMessage(msg, did, { encryptForSender: true, registry: 'local' });
        await keymaster.rotateKeys();
        const decipher = await keymaster.decryptMessage(encryptDid);

        expect(decipher).toBe(msg);
    });

    it('should decrypt a short message after rotating keys (unconfirmed)', async () => {
        const did = await keymaster.createId('Bob', { registry: 'hyperswarm' });
        const msg = 'Hi Bob!';
        await keymaster.rotateKeys();
        const encryptDid = await keymaster.encryptMessage(msg, did, { encryptForSender: true, registry: 'hyperswarm' });
        const decipher = await keymaster.decryptMessage(encryptDid);

        expect(decipher).toBe(msg);
    });

    it('should decrypt a short message encrypted by another ID', async () => {
        const name1 = 'Alice';
        await keymaster.createId(name1);

        const name2 = 'Bob';
        const did = await keymaster.createId(name2);

        await keymaster.setCurrentId(name1);

        const msg = 'Hi Bob!';
        const encryptDid = await keymaster.encryptMessage(msg, did);

        await keymaster.setCurrentId(name2);
        const decipher = await keymaster.decryptMessage(encryptDid);

        expect(decipher).toBe(msg);
    });

    it('should decrypt a long message encrypted by another ID', async () => {
        const name1 = 'Alice';
        await keymaster.createId(name1);

        const name2 = 'Bob';
        const did = await keymaster.createId(name2);

        await keymaster.setCurrentId(name1);

        const msg = generateRandomString(1024);
        const encryptDid = await keymaster.encryptMessage(msg, did);

        await keymaster.setCurrentId(name2);
        const decipher = await keymaster.decryptMessage(encryptDid);

        expect(decipher).toBe(msg);
    });

    it('should throw an exception on invalid DID', async () => {
        const name = await keymaster.createId("Alice");

        try {
            await keymaster.decryptMessage(name);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toContain('did not encrypted');
        }
    });
});

const mockJson = {
    key: "value",
    list: [1, 2, 3],
    obj: { name: "some object" }
};

describe('encryptJSON', () => {
    it('should encrypt valid JSON', async () => {
        const bob = await keymaster.createId('Bob');
        await keymaster.resolveDID(bob);

        const did = await keymaster.encryptJSON(mockJson, bob);
        const data = await keymaster.resolveAsset(did);
        expect((data as { encrypted: EncryptedMessage }).encrypted.sender).toStrictEqual(bob);
    });
});

describe('decryptJSON', () => {
    it('should decrypt valid JSON', async () => {
        const bob = await keymaster.createId('Bob');
        const did = await keymaster.encryptJSON(mockJson, bob);
        const decipher = await keymaster.decryptJSON(did);

        expect(decipher).toStrictEqual(mockJson);
    });
});

describe('addProof', () => {
    it('should add a proof to the object', async () => {
        const name = 'Bob';
        const did = await keymaster.createId(name);
        const signed = await keymaster.addProof(mockJson);

        expect(signed.proof.type).toBe('EcdsaSecp256k1Signature2019');
        expect(signed.proof.verificationMethod).toContain(did);
        expect(signed.proof.verificationMethod).toContain('#key-');
        expect(signed.proof.proofPurpose).toBe('assertionMethod');
        expect(signed.proof.proofValue).toBeDefined();
    });

    it('should throw an exception if no ID selected', async () => {
        try {
            await keymaster.addProof(mockJson);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Keymaster: No current ID');
        }
    });

    it('should throw an exception if null parameter', async () => {
        await keymaster.createId('Bob');

        try {
            // @ts-expect-error Testing invalid usage, missing arg
            await keymaster.addProof();
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe('Invalid parameter: obj');
        }
    });
});

describe('verifyProof', () => {
    it('should return true for valid proof', async () => {
        await keymaster.createId('Bob');

        const signed = await keymaster.addProof(mockJson);
        const isValid = await keymaster.verifyProof(signed);

        expect(isValid).toBe(true);
    });

    it('should return false for missing proof', async () => {
        await keymaster.createId('Bob');

        // @ts-expect-error Testing invalid usage, invalid arg
        const isValid = await keymaster.verifyProof(mockJson);

        expect(isValid).toBe(false);
    });

    it('should return false for invalid proofValue', async () => {
        await keymaster.createId('Bob');

        const signed = await keymaster.addProof(mockJson);
        signed.proof.proofValue = signed.proof.proofValue.substring(1);
        const isValid = await keymaster.verifyProof(signed);

        expect(isValid).toBe(false);
    });

    it('should return false for missing verificationMethod', async () => {
        await keymaster.createId('Bob');

        const signed = await keymaster.addProof(mockJson);
        // @ts-expect-error Testing invalid usage
        delete signed.proof.verificationMethod;
        const isValid = await keymaster.verifyProof(signed);

        expect(isValid).toBe(false);
    });

    it('should return false for invalid proof type', async () => {
        await keymaster.createId('Bob');

        const signed = await keymaster.addProof(mockJson);
        // @ts-expect-error Testing invalid usage
        signed.proof.type = "InvalidType";
        const isValid = await keymaster.verifyProof(signed);

        expect(isValid).toBe(false);
    });

    it('should return false for null parameter', async () => {
        // @ts-expect-error Testing invalid usage, missing arg
        const isValid = await keymaster.verifyProof();

        expect(isValid).toBe(false);
    });

    it('should return false for invalid JSON', async () => {
        // @ts-expect-error Testing invalid usage, invalid arg
        const isValid = await keymaster.verifyProof("not JSON");

        expect(isValid).toBe(false);
    });
});
