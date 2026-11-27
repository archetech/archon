import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { mockSchema } from './helper.ts';

let ipfs: MemoryClient;
let gatekeeper: Gatekeeper;
let cipher: CipherNode;
let keymaster: Keymaster;

beforeAll(async () => {
    ipfs = new MemoryClient();
    await ipfs.start();
});

afterAll(async () => {
    if (ipfs) {
        await ipfs.stop();
    }
});

beforeEach(async () => {
    const db = new DbJsonMemory('test');
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm'] });
    cipher = new CipherNode();
    keymaster = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher, passphrase: 'passphrase' });
    await keymaster.loadOrCreateWallet();
});

async function streamOf(data: Buffer): Promise<AsyncIterable<Uint8Array>> {
    return (async function* () {
        yield data;
    })();
}

describe('bindCredential', () => {
    it('binds a credential with no options', async () => {
        const issuer = await keymaster.createId('Issuer');
        const subject = await keymaster.createId('Subject');
        await keymaster.setCurrentId('Issuer');

        const vc = await keymaster.bindCredential(subject);

        expect(vc.issuer).toBe(issuer);
        expect(vc.credentialSubject).toStrictEqual({ id: subject });
        expect(vc.credentialSchema).toBeUndefined();
        expect(Number.isNaN(Date.parse(vc.validFrom!))).toBe(false);
    });
});

describe('publishCredential', () => {
    it('refuses to publish a credential for someone other than its subject', async () => {
        await keymaster.createId('Issuer');
        const subject = await keymaster.createId('Subject');
        await keymaster.setCurrentId('Issuer');
        const schema = await keymaster.createSchema(mockSchema);
        const bound = await keymaster.bindCredential(subject, { schema });
        const credential = await keymaster.issueCredential(bound);
        const before = (await keymaster.resolveDID('Issuer')).didDocumentData;

        // The issuer can read what it issued, but the credential is not its own.
        await expect(keymaster.publishCredential(credential))
            .rejects.toThrow('Invalid parameter: only subject can publish a credential');
        expect((await keymaster.resolveDID('Issuer')).didDocumentData).toStrictEqual(before);
    });
});

describe('sendCredentialDidComm', () => {
    it('refuses an encrypted message that is not a credential', async () => {
        await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');
        await keymaster.setCurrentId('Alice');
        const message = await keymaster.encryptJSON({ note: 'not a credential' }, bob);

        await expect(keymaster.sendCredentialDidComm(message, bob)).rejects.toThrow('Invalid parameter: did');
    });
});

describe('sendCredential', () => {
    it('sends nothing for an encrypted message that is not a credential', async () => {
        await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');
        await keymaster.setCurrentId('Alice');
        const message = await keymaster.encryptJSON({ note: 'not a credential' }, bob);

        expect(await keymaster.sendCredential(message)).toBeNull();
    });
});

describe('decryptMessage', () => {
    it('reads a legacy message that keeps its ciphertexts at the top level', async () => {
        await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');
        await keymaster.setCurrentId('Alice');
        const bobKey = (await keymaster.resolveDID(bob)).didDocument!.verificationMethod![0].publicKeyJwk!;
        const legacy = await keymaster.createAsset({
            cipher_hash: cipher.hashMessage('from the old days'),
            cipher_sender: null,
            cipher_receiver: cipher.encryptMessage(bobKey as any, 'from the old days'),
        });

        await keymaster.setCurrentId('Bob');
        expect(await keymaster.decryptMessage(legacy)).toBe('from the old days');
    });
});

describe('addProof', () => {
    it('refuses an object that cannot be serialized', async () => {
        await keymaster.createId('Alice');

        await expect(keymaster.addProof({ amount: BigInt(1) })).rejects.toThrow('Invalid parameter: obj');
    });
});

describe('verifyResponse', () => {
    it('refuses an encrypted message that does not wrap a response', async () => {
        await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');
        await keymaster.setCurrentId('Alice');
        const message = await keymaster.encryptJSON('just a string', bob);

        await keymaster.setCurrentId('Bob');
        await expect(keymaster.verifyResponse(message))
            .rejects.toThrow('Invalid parameter: responseDID not a valid challenge response');
    });
});

describe('a challenge answered with a credential signed by both of its issuer\'s keys', () => {
    it('verifies', async () => {
        await keymaster.createId('Issuer', { registry: 'local' });
        const holder = await keymaster.createId('Holder');
        await keymaster.createId('Verifier');

        await keymaster.setCurrentId('Issuer');
        await keymaster.publishAssertionKey();
        const schema = await keymaster.createSchema(mockSchema);
        const credential = await keymaster.issueCredential(await keymaster.bindCredential(holder, { schema }));
        expect((await keymaster.getCredential(credential))!.proof).toHaveLength(2);

        await keymaster.setCurrentId('Holder');
        await keymaster.acceptCredential(credential);

        await keymaster.setCurrentId('Verifier');
        const challenge = await keymaster.createChallenge({ credentials: [{ schema }] });

        await keymaster.setCurrentId('Holder');
        const response = await keymaster.createResponse(challenge);

        await keymaster.setCurrentId('Verifier');
        const verified = await keymaster.verifyResponse(response);
        expect(verified).toMatchObject({ match: true, requested: 1, fulfilled: 1, responder: holder });
    });
});

describe('file streams with no options', () => {
    it('stores a stream under default metadata', async () => {
        await keymaster.createId('Alice');
        const data = Buffer.from('some bytes');

        const did = await keymaster.createFileStream(await streamOf(data));

        expect(await keymaster.getFile(did)).toMatchObject({
            filename: 'file',
            type: 'application/octet-stream',
        });
    });

    it('replaces a stream under default metadata', async () => {
        await keymaster.createId('Alice');
        const did = await keymaster.createFileStream(await streamOf(Buffer.from('v1')), {
            filename: 'notes.txt',
            contentType: 'text/plain',
            bytes: 2,
        });

        expect(await keymaster.updateFileStream(did, await streamOf(Buffer.from('v2')))).toBe(true);

        expect(await keymaster.getFile(did)).toMatchObject({
            filename: 'file',
            type: 'application/octet-stream',
        });
    });
});
