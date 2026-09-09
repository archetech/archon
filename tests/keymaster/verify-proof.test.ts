import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { bytesToMultibase } from '@didcid/cipher/multikey';
import canonicalizeModule from 'canonicalize';
import { sha256 } from '@noble/hashes/sha256';

const canonicalize = canonicalizeModule as unknown as (input: unknown) => string;

let ipfs: MemoryClient;
let keymaster: Keymaster;
let cipher: CipherNode;

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
    cipher = new CipherNode();
    keymaster = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher, passphrase: 'passphrase' });
    await keymaster.loadOrCreateWallet();
});

// Built here rather than through the implementation, so a wrong payload fails
// instead of agreeing with itself. Per vc-di-eddsa: the proof config is the
// proof without proofValue, carrying the document's @context; the signed
// payload is sha256(canonical config) || sha256(canonical document).
async function signEddsaJcs2022(document: any, did: string, name?: string, proofPurpose = 'assertionMethod') {
    const keypair = await keymaster.fetchAssertionKeyPair(name);
    const { proof, ...unsecured } = document;
    void proof;

    const config: any = {
        '@context': unsecured['@context'],
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        created: new Date().toISOString(),
        verificationMethod: `${did}#key-assertion-1`,
        proofPurpose,
    };

    const payload = new Uint8Array([
        ...sha256(canonicalize(config)),
        ...sha256(canonicalize(unsecured)),
    ]);

    return { ...config, proofValue: bytesToMultibase(cipher.signEd25519(payload, keypair.privateJwk)) };
}

async function credential(name = 'Alice') {
    const did = await keymaster.createId(name, { registry: 'local' });
    await keymaster.publishAssertionKey(name);
    return { did, document: { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential'], issuer: did, credentialSubject: { id: did } } };
}

describe('eddsa-jcs-2022', () => {
    it('verifies a proof built to the spec by hand', async () => {
        const { did, document } = await credential();
        const secured = { ...document, proof: await signEddsaJcs2022(document, did) };

        expect(await keymaster.verifyProof(secured)).toBe(true);
    });

    it('rejects it once the document changes', async () => {
        const { did, document } = await credential();
        const proof = await signEddsaJcs2022(document, did);

        expect(await keymaster.verifyProof({ ...document, credentialSubject: { id: 'did:cid:someone-else' }, proof })).toBe(false);
    });

    it('rejects a tampered proofValue', async () => {
        const { did, document } = await credential();
        const proof: any = await signEddsaJcs2022(document, did);
        const bytes = Uint8Array.from(Buffer.from('deadbeef'.repeat(16), 'hex'));

        expect(await keymaster.verifyProof({ ...document, proof: { ...proof, proofValue: bytesToMultibase(bytes) } })).toBe(false);
    });

    // Signed over a context the document does not declare, so the signature is
    // genuinely valid and only the agreement check can reject it. Create Proof
    // sets the proof's @context from the document, so a mismatch is a proof
    // built outside the suite -- and one a verifier that rebuilds the config
    // from the document would reject while this one, canonicalizing the config
    // as given, would not.
    it('rejects a proof signed over a context the document does not declare', async () => {
        const { did, document } = await credential();
        const keypair = await keymaster.fetchAssertionKeyPair();
        const config: any = {
            '@context': ['https://example.test/other/v1'],
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod: `${did}#key-assertion-1`,
            proofPurpose: 'assertionMethod',
        };
        const payload = new Uint8Array([
            ...sha256(canonicalize(config)),
            ...sha256(canonicalize(document)),
        ]);
        const proof = { ...config, proofValue: bytesToMultibase(cipher.signEd25519(payload, keypair.privateJwk)) };

        expect(await keymaster.verifyProof({ ...document, proof } as any)).toBe(false);
    });

    // The @context is inside the signed config, so swapping it after signing
    // has to invalidate the proof.
    it('rejects a proof whose context was changed after signing', async () => {
        const { did, document } = await credential();
        const proof: any = await signEddsaJcs2022(document, did);

        expect(await keymaster.verifyProof({ ...document, proof: { ...proof, '@context': ['https://example.test/v1'] } })).toBe(false);
    });

    // The key is not verificationMethod[0], so this only passes if selection is
    // by the fragment the proof names.
    it('selects the key the proof names rather than the first one', async () => {
        const { did, document } = await credential();
        const doc: any = await keymaster.resolveDID(did);

        expect(doc.didDocument.verificationMethod[0].id).toBe('#key-1');
        expect(doc.didDocument.verificationMethod[1].id).toBe(`${did}#key-assertion-1`);
        expect(await keymaster.verifyProof({ ...document, proof: await signEddsaJcs2022(document, did) })).toBe(true);
    });
});

describe('proof sets', () => {
    it('accepts a set where one proof verifies and another is a suite we do not implement', async () => {
        const { did, document } = await credential();
        const foreign = { type: 'DataIntegrityProof', cryptosuite: 'ecdsa-rdfc-2019', created: new Date().toISOString(), verificationMethod: `${did}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zNotOurs' };

        expect(await keymaster.verifyProof({ ...document, proof: [foreign, await signEddsaJcs2022(document, did)] } as any)).toBe(true);
    });

    it('rejects a set holding only a suite we do not implement', async () => {
        const { did, document } = await credential();
        const foreign = { type: 'DataIntegrityProof', cryptosuite: 'ecdsa-rdfc-2019', created: new Date().toISOString(), verificationMethod: `${did}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zNotOurs' };

        expect(await keymaster.verifyProof({ ...document, proof: [foreign] } as any)).toBe(false);
    });

    it('rejects an empty set and a missing proof', async () => {
        const { document } = await credential();

        expect(await keymaster.verifyProof({ ...document, proof: [] } as any)).toBe(false);
        expect(await keymaster.verifyProof(document as any)).toBe(false);
    });
});

describe('proofPurpose authorization', () => {
    // The signature checks out either way -- the key really is the subject's --
    // so without this a key published only for key agreement, or only for
    // authentication, can sign a credential claiming assertionMethod.
    it('rejects a proof naming a key the document does not authorize for that purpose', async () => {
        const { did, document } = await credential();

        // The key moves out of assertionMethod and under keyAgreement, and the
        // proof is signed afterwards. Order matters: verifyProof resolves at
        // the proof's own created time, so a document changed after a proof was
        // made cannot retroactively invalidate it -- which is what makes key
        // rotation survivable, and is asserted separately below.
        const doc: any = await keymaster.resolveDID(did);
        const didDocument = { ...doc.didDocument };
        didDocument.assertionMethod = didDocument.assertionMethod.filter((r: string) => !r.endsWith('#key-assertion-1'));
        didDocument.keyAgreement = [`${did}#key-assertion-1`];
        await keymaster.updateDID(did, { didDocument });

        const proof: any = await signEddsaJcs2022(document, did);

        expect(await keymaster.verifyProof({ ...document, proof })).toBe(false);
    });

    // The other half of the same rule: a proof made while the key was
    // authorized keeps verifying after the document moves on.
    it('accepts a proof made while the key was still authorized', async () => {
        const { did, document } = await credential();
        const proof: any = await signEddsaJcs2022(document, did);

        const doc: any = await keymaster.resolveDID(did);
        const didDocument = { ...doc.didDocument };
        didDocument.assertionMethod = didDocument.assertionMethod.filter((r: string) => !r.endsWith('#key-assertion-1'));
        await keymaster.updateDID(did, { didDocument });

        expect(await keymaster.verifyProof({ ...document, proof })).toBe(true);
    });

    it('rejects an authentication proof from a key listed only for assertion', async () => {
        const { did, document } = await credential();
        const proof: any = await signEddsaJcs2022(document, did);

        expect(await keymaster.verifyProof({ ...document, proof: { ...proof, proofPurpose: 'authentication' } })).toBe(false);
    });

    // #key-1 is in both relationships, so the ordinary case keeps working.
    it('accepts the identity key, which the document lists under both', async () => {
        await keymaster.createId('Bob', { registry: 'local' });
        const signed = await keymaster.addProof({ hello: 'world' });

        expect(await keymaster.verifyProof(signed)).toBe(true);
    });
});

describe('untrusted proof fields', () => {
    // proofPurpose arrives as JSON. Anything not one of the two relationships
    // used to fall through to assertionMethod, so an unsupported purpose passed
    // on an assertion key.
    // Signed *with* the bad purpose, so the signature is genuinely valid and
    // only the authorization check can reject it. Editing the purpose after
    // signing invalidates the signature instead, which passes for the wrong
    // reason and would hold even with the check removed.
    it.each(['capabilityInvocation', 'keyAgreement', ''])('rejects the purpose %p', async (proofPurpose) => {
        const { did, document } = await credential();
        const proof = await signEddsaJcs2022(document, did, undefined, proofPurpose);

        expect(await keymaster.verifyProof({ ...document, proof } as any)).toBe(false);
    });

    it('rejects a proof with no purpose at all', async () => {
        const { did, document } = await credential();
        const { proofPurpose, ...proof } = await signEddsaJcs2022(document, did) as any;
        void proofPurpose;

        expect(await keymaster.verifyProof({ ...document, proof } as any)).toBe(false);
    });

    // A proof naming a DID method this node cannot resolve used to throw out of
    // verifyProof, so a valid Archon proof beside it was never reached.
    it('checks a valid proof beside one whose issuer cannot be resolved', async () => {
        const { did, document } = await credential();
        const unresolvable = {
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod: 'did:web:example.test#key-1',
            proofPurpose: 'assertionMethod',
            proofValue: 'zNotOurs',
        };

        expect(await keymaster.verifyProof({ ...document, proof: [unresolvable, await signEddsaJcs2022(document, did)] } as any)).toBe(true);
    });

    it('does not throw when every proof names an unresolvable issuer', async () => {
        const { document } = await credential();
        const unresolvable = {
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod: 'did:web:example.test#key-1',
            proofPurpose: 'assertionMethod',
            proofValue: 'zNotOurs',
        };

        await expect(keymaster.verifyProof({ ...document, proof: [unresolvable] } as any)).resolves.toBe(false);
    });
});

describe('the legacy label', () => {
    // Every credential issued so far carries it, and they are immutable, so it
    // is accepted for good rather than deprecated.
    it('still verifies a single EcdsaSecp256k1Signature2019 proof', async () => {
        await keymaster.createId('Alice', { registry: 'local' });
        const signed = await keymaster.addProof({ hello: 'world' });

        expect((signed.proof as any).type).toBe('EcdsaSecp256k1Signature2019');
        expect(await keymaster.verifyProof(signed)).toBe(true);
    });
});

describe('issuing', () => {
    // An identity that never publishes an assertion key emits exactly what it
    // emitted before this feature, so nothing downstream changes shape until
    // somebody opts in.
    it('emits a single proof while no assertion key is published', async () => {
        await keymaster.createId('Alice', { registry: 'local' });
        const signed = await keymaster.addProof({ hello: 'world' });

        expect(Array.isArray(signed.proof)).toBe(false);
        expect((signed.proof as any).type).toBe('EcdsaSecp256k1Signature2019');
        expect(await keymaster.verifyProof(signed)).toBe(true);
    });

    it('emits both proofs once the key is published, and each verifies alone', async () => {
        const { document } = await credential();
        const signed: any = await keymaster.addProof(document);
        const [secp, eddsa] = signed.proof;

        expect(signed.proof).toHaveLength(2);
        expect(secp.type).toBe('EcdsaSecp256k1Signature2019');
        expect(eddsa.type).toBe('DataIntegrityProof');
        expect(eddsa.cryptosuite).toBe('eddsa-jcs-2022');
        expect(eddsa.proofValue.startsWith('z')).toBe(true);

        expect(await keymaster.verifyProof({ ...document, proof: [secp] })).toBe(true);
        expect(await keymaster.verifyProof({ ...document, proof: [eddsa] })).toBe(true);
        expect(await keymaster.verifyProof(signed)).toBe(true);
    });

    // Create Proof step 2: the proof carries the context of the document it
    // secures, which the agreement check then requires on the way back in.
    it('gives the Data Integrity proof the document context', async () => {
        const { document } = await credential();
        const signed: any = await keymaster.addProof(document);

        expect(signed.proof[1]['@context']).toStrictEqual(document['@context']);
    });

    it('omits the context for a document that declares none', async () => {
        await keymaster.createId('Alice', { registry: 'local' });
        await keymaster.publishAssertionKey();
        const signed: any = await keymaster.addProof({ hello: 'world' });

        expect(signed.proof[1]['@context']).toBeUndefined();
        expect(await keymaster.verifyProof(signed)).toBe(true);
    });

    // The published key is what a verifier resolves, so signing with a
    // derivation that no longer matches it would emit a proof nobody can
    // check. Skipped rather than fatal: the secp256k1 proof still stands.
    it('attaches nothing when the published key is not the one it derives', async () => {
        const did = await keymaster.createId('Alice', { registry: 'local' });
        await keymaster.publishAssertionKey();

        const doc: any = await keymaster.resolveDID(did);
        const didDocument = { ...doc.didDocument };
        didDocument.verificationMethod = didDocument.verificationMethod.map((vm: any) =>
            vm.id === `${did}#key-assertion-1`
                ? { ...vm, publicKeyMultibase: 'z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp' }
                : vm);
        await keymaster.updateDID(did, { didDocument });

        const signed: any = await keymaster.addProof({ hello: 'world' });

        expect(Array.isArray(signed.proof)).toBe(false);
        expect(signed.proof.type).toBe('EcdsaSecp256k1Signature2019');
    });

    // Both gatekeeper ports require an operation proof to be a single object
    // whose type is the literal EcdsaSecp256k1Signature2019, so an operation
    // must never pick up the second proof however many keys its signer has.
    it('leaves DID operations carrying one legacy proof', async () => {
        const did = await keymaster.createId('Alice', { registry: 'local' });
        await keymaster.publishAssertionKey();

        // updateDID and revokeDID both sign operations; a rejected one throws.
        const doc: any = await keymaster.resolveDID(did);
        const didDocument = { ...doc.didDocument, alsoKnownAs: ['https://example.test/alice'] };

        expect(await keymaster.updateDID(did, { didDocument })).toBe(true);

        const asset = await keymaster.createAsset({ note: 'after publishing' });

        expect(asset).toBeDefined();
    });
});
