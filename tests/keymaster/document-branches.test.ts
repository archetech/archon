import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';

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

// The Gatekeeper accepts an agent document that lists only its verification
// methods and capabilityInvocation, as one written by another client may.
async function createBareAgent(name: string) {
    const did = await keymaster.createId(name, { registry: 'local' });
    const { didDocument } = await keymaster.resolveDID(did);
    const bare = { ...didDocument! };
    delete bare['@context'];
    delete bare.authentication;
    delete bare.assertionMethod;
    expect(await keymaster.updateDID(did, { didDocument: bare })).toBe(true);
    return { did, bare };
}

describe('assertion keys on a document with no relationships or context', () => {
    it('publishes the key into fresh relationships and context', async () => {
        const { did } = await createBareAgent('Alice');

        expect(await keymaster.publishAssertionKey()).toBe(true);

        const { didDocument } = await keymaster.resolveDID(did);
        expect(didDocument!.assertionMethod).toEqual([`${did}#key-assertion-1`]);
        expect(didDocument!.authentication).toEqual([`${did}#key-assertion-1`]);
        expect(didDocument!['@context']).toEqual(['https://w3id.org/security/multikey/v1']);
    });

    it('leaves the document as it was once the key is unpublished', async () => {
        const { did, bare } = await createBareAgent('Alice');
        await keymaster.publishAssertionKey();

        expect(await keymaster.unpublishAssertionKey()).toBe(true);

        expect((await keymaster.resolveDID(did)).didDocument).toStrictEqual(bare);
    });
});

describe('rotateKeys on a document with no relationships', () => {
    it('replaces the operation key and the capability that names it', async () => {
        const { did, bare } = await createBareAgent('Alice');

        expect(await keymaster.rotateKeys()).toBe(true);

        const { didDocument } = await keymaster.resolveDID(did);
        expect(didDocument!.verificationMethod!.map(vm => vm.id)).toEqual(['#key-2']);
        expect(didDocument!.verificationMethod![0].publicKeyJwk).not.toEqual(bare.verificationMethod![0].publicKeyJwk);
        expect(didDocument!.capabilityInvocation).toEqual(['#key-2']);
        expect((await keymaster.fetchKeyPair())!.publicJwk).toEqual(didDocument!.verificationMethod![0].publicKeyJwk);
    });
});

describe('verifyProof', () => {
    it('rejects a proof that names a key of an asset', async () => {
        await keymaster.createId('Alice');
        const asset = await keymaster.createAsset({ thing: true });
        const signed = await keymaster.addProof({ claim: 'value' });
        const proof = Array.isArray(signed.proof) ? signed.proof[0] : signed.proof;
        const fragment = proof!.verificationMethod.split('#')[1];

        const renamed = { ...signed, proof: { ...proof, verificationMethod: `${asset}#${fragment}` } };

        expect(await keymaster.verifyProof(renamed)).toBe(false);
    });
});

// Credentials issued before key names were checked were signed with the
// document's first key under whatever name the document gave it then. A
// document can still list such a name for assertion after the method itself
// has gone.
describe('a proof naming an assertion key the document no longer describes', () => {
    async function withStaleAssertionRef() {
        const did = await keymaster.createId('Alice', { registry: 'local' });
        const { didDocument } = await keymaster.resolveDID(did);
        const stale = `${did}#key-0`;
        const updated = { ...didDocument!, assertionMethod: [...didDocument!.assertionMethod!, stale] };
        expect(await keymaster.updateDID(did, { didDocument: updated })).toBe(true);
        return { did, stale };
    }

    it('verifies a legacy proof by the document\'s first key', async () => {
        const { stale } = await withStaleAssertionRef();
        const unsecured = { claim: 'value' };
        const keypair = (await keymaster.fetchKeyPair())!;
        const signature = cipher.signHash(cipher.hashJSON(unsecured), keypair.privateJwk);
        const legacy = {
            ...unsecured,
            proof: {
                type: 'EcdsaSecp256k1Signature2019',
                created: new Date().toISOString(),
                verificationMethod: stale,
                proofPurpose: 'assertionMethod',
                proofValue: Buffer.from(signature, 'hex').toString('base64url'),
            },
        };

        expect(await keymaster.verifyProof(legacy as any)).toBe(true);
        expect(await keymaster.verifyProof({ ...legacy, claim: 'changed' } as any)).toBe(false);
    });

    // This shows only that a proof is tied to the method it was signed under.
    // It does not show that a current proof gets no first-key fallback: the
    // method is part of what is signed, so changing it breaks the signature
    // either way, and signing under a method the document lacks needs the
    // suite's own signing input.
    it('does not verify a current proof whose method was changed after signing', async () => {
        const { stale } = await withStaleAssertionRef();
        const signed = await keymaster.addProof({ claim: 'value' });
        const proof = Array.isArray(signed.proof) ? signed.proof[0] : signed.proof;

        expect(await keymaster.verifyProof({ ...signed, proof: { ...proof, verificationMethod: stale } })).toBe(false);
    });
});

describe('DIDComm signing with an absolute key id', () => {
    it('signs under the id as the document writes it', async () => {
        const alice = await keymaster.createId('Alice', { registry: 'local' });
        const bob = await keymaster.createId('Bob', { registry: 'local' });
        await keymaster.publishDidComm(undefined, 'Alice');
        await keymaster.publishDidComm(undefined, 'Bob');

        const { didDocument } = await keymaster.resolveDID(alice);
        const absolute = `${alice}#key-1`;
        const [first, ...rest] = didDocument!.verificationMethod!;
        const updated = {
            ...didDocument!,
            verificationMethod: [{ ...first, id: absolute }, ...rest],
            authentication: [absolute],
            assertionMethod: [absolute],
            capabilityInvocation: [absolute],
        };
        expect(await keymaster.updateDID(alice, { didDocument: updated })).toBe(true);

        const packed = await keymaster.packDidComm({ type: 'https://x/1/msg', body: { n: 1 } }, bob, {
            name: 'Alice',
            sign: true,
            anoncrypt: true,
        });
        const { message, metadata } = await keymaster.unpackDidComm(packed, { name: 'Bob' });

        expect(message.body).toEqual({ n: 1 });
        expect(metadata.nonRepudiation).toBe(true);
        expect(metadata.signer).toBe(absolute);
    });
});

describe('listDmail', () => {
    it('shows the DIDs of a sender and recipients the reader has no names for', async () => {
        const reader = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher, passphrase: 'reader' });
        await reader.loadOrCreateWallet();
        const bob = await reader.createId('Bob');

        const carol = await keymaster.createId('Carol');
        const dave = await keymaster.createId('Dave');
        const alice = await keymaster.createId('Alice');
        const dmail = await keymaster.createDmail({
            to: [bob, carol],
            cc: [dave],
            subject: 'hello',
            body: 'to people you may not know',
        });
        const notice = await keymaster.sendDmail(dmail);

        expect(await reader.importNotice(notice!)).toBe(true);

        const item = (await reader.listDmail())[dmail];
        expect(item.sender).toBe(alice);
        expect(item.to).toEqual(['Bob', carol]);
        expect(item.cc).toEqual([dave]);
    });
});
