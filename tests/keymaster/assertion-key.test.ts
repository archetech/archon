import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { multikeyToEd25519PublicKey } from '@didcid/cipher/multikey';

let ipfs: MemoryClient;
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
    const gatekeeper = new Gatekeeper({ db: new DbJsonMemory('test'), ipfs, registries: ['local'] });
    keymaster = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher: new CipherNode(), passphrase: 'passphrase' });
    await keymaster.loadOrCreateWallet();
});

const assertionMethods = (doc: any) => doc.didDocument.verificationMethod.filter((vm: any) => vm.type === 'Multikey');

describe('fetchAssertionKeyPair', () => {
    // Derived from the wallet seed rather than stored, so a wallet restored
    // from its mnemonic signs with the same key it published.
    it('is deterministic for an identity', async () => {
        await keymaster.createId('Alice', { registry: 'local' });

        expect(await keymaster.fetchAssertionKeyPair()).toStrictEqual(await keymaster.fetchAssertionKeyPair());
    });

    it('differs between identities and from the DIDComm key', async () => {
        await keymaster.createId('Alice', { registry: 'local' });
        await keymaster.createId('Bob', { registry: 'local' });

        const alice = await keymaster.fetchAssertionKeyPair('Alice');
        const bob = await keymaster.fetchAssertionKeyPair('Bob');
        const agreement = await keymaster.fetchDidCommKeyPair('Alice');

        expect(alice.publicJwk.x).not.toBe(bob.publicJwk.x);
        expect(alice.publicJwk.x).not.toBe(agreement.publicJwk.x);
        expect(alice.publicJwk.crv).toBe('Ed25519');
    });
});

describe('publishAssertionKey', () => {
    it('publishes a Multikey the derived key round-trips through', async () => {
        const did = await keymaster.createId('Alice', { registry: 'local' });

        expect(await keymaster.publishAssertionKey()).toBe(true);

        const doc: any = await keymaster.resolveDID(did);
        const [vm] = assertionMethods(doc);
        const keypair = await keymaster.fetchAssertionKeyPair();

        expect(vm.id).toBe(`${did}#key-assertion-1`);
        expect(vm.type).toBe('Multikey');
        expect(vm.publicKeyMultibase.startsWith('z')).toBe(true);
        expect(Buffer.from(multikeyToEd25519PublicKey(vm.publicKeyMultibase)).toString('base64url'))
            .toBe(keypair.publicJwk.x);
    });

    // assertionMethod already names #key-1, and dropping it would unpublish the
    // key everything Archon verifies today is signed with.
    it('adds to assertionMethod rather than replacing it', async () => {
        const did = await keymaster.createId('Alice', { registry: 'local' });
        await keymaster.publishAssertionKey();

        const doc: any = await keymaster.resolveDID(did);

        expect(doc.didDocument.assertionMethod).toStrictEqual(['#key-1', `${did}#key-assertion-1`]);
    });

    it('declares the Multikey context', async () => {
        const did = await keymaster.createId('Alice', { registry: 'local' });
        await keymaster.publishAssertionKey();

        const doc: any = await keymaster.resolveDID(did);

        expect(doc.didDocument['@context']).toContain('https://w3id.org/security/multikey/v1');
    });

    // A document may name the method relatively. Filtering on the raw string
    // keeps that entry and appends the absolute form beside it, leaving two
    // verification methods and two references for one key.
    it('replaces a relative reference rather than duplicating it', async () => {
        const did = await keymaster.createId('Alice', { registry: 'local' });
        await keymaster.publishAssertionKey();

        const doc: any = await keymaster.resolveDID(did);
        const didDocument = { ...doc.didDocument };
        didDocument.verificationMethod = didDocument.verificationMethod.map(
            (vm: any) => vm.id === `${did}#key-assertion-1` ? { ...vm, id: '#key-assertion-1' } : vm);
        didDocument.assertionMethod = didDocument.assertionMethod.map(
            (ref: string) => ref === `${did}#key-assertion-1` ? '#key-assertion-1' : ref);
        await keymaster.updateDID(did, { didDocument });

        await keymaster.publishAssertionKey();

        const after: any = await keymaster.resolveDID(did);

        expect(assertionMethods(after)).toHaveLength(1);
        expect(after.didDocument.assertionMethod.filter((r: string) => r.endsWith('#key-assertion-1'))).toHaveLength(1);
    });

    it('is idempotent', async () => {
        const did = await keymaster.createId('Alice', { registry: 'local' });
        await keymaster.publishAssertionKey();
        await keymaster.publishAssertionKey();

        const doc: any = await keymaster.resolveDID(did);

        expect(assertionMethods(doc)).toHaveLength(1);
        expect(doc.didDocument.assertionMethod.filter((r: string) => r.endsWith('#key-assertion-1'))).toHaveLength(1);
    });

    // The key is not stored, so a rotation that dropped it would leave every
    // credential it signed unverifiable.
    it('survives a key rotation', async () => {
        const did = await keymaster.createId('Alice', { registry: 'local' });
        await keymaster.publishAssertionKey();

        await keymaster.rotateKeys();

        const doc: any = await keymaster.resolveDID(did);

        expect(assertionMethods(doc)).toHaveLength(1);
        expect(doc.didDocument.assertionMethod).toContain(`${did}#key-assertion-1`);
    });
});

describe('unpublishAssertionKey', () => {
    // The Multikey context defines the terms of every Multikey in the document,
    // so removing it while one remains leaves that method's terms undefined.
    it('keeps the Multikey context while another Multikey remains', async () => {
        const did = await keymaster.createId('Alice', { registry: 'local' });
        await keymaster.publishAssertionKey();

        const doc: any = await keymaster.resolveDID(did);
        const didDocument = { ...doc.didDocument };
        didDocument.verificationMethod = [...didDocument.verificationMethod, {
            id: `${did}#key-other-1`,
            controller: did,
            type: 'Multikey',
            publicKeyMultibase: 'z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp',
        }];
        await keymaster.updateDID(did, { didDocument });

        await keymaster.unpublishAssertionKey();

        const after: any = await keymaster.resolveDID(did);

        expect(after.didDocument.verificationMethod.map((vm: any) => vm.id)).toContain(`${did}#key-other-1`);
        expect(after.didDocument['@context']).toContain('https://w3id.org/security/multikey/v1');
    });

    it('removes the key and its reference, keeping the identity key', async () => {
        const did = await keymaster.createId('Alice', { registry: 'local' });
        await keymaster.publishAssertionKey();

        expect(await keymaster.unpublishAssertionKey()).toBe(true);

        const doc: any = await keymaster.resolveDID(did);

        expect(assertionMethods(doc)).toHaveLength(0);
        expect(doc.didDocument.assertionMethod).toStrictEqual(['#key-1']);
        expect(doc.didDocument.verificationMethod.map((vm: any) => vm.id)).toStrictEqual(['#key-1']);
        expect(doc.didDocument['@context']).not.toContain('https://w3id.org/security/multikey/v1');
    });
});
