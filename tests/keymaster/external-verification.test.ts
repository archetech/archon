import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';

import jsigs from 'jsonld-signatures';
import { DataIntegrityProof } from '@digitalbazaar/data-integrity';
import { createVerifyCryptosuite } from '@digitalbazaar/eddsa-jcs-2022-cryptosuite';

// #1089: a credential Archon issues must verify under an eddsa-jcs-2022
// implementation that is not Archon's own. This checks the OUTBOUND direction
// (the W3C-vector tests check inbound) using Digital Bazaar's reference
// cryptosuite -- the spec authors' code -- driving jsonld-signatures. If this
// passes, an external verifier can check an Archon credential; if the payload
// assembly, key encoding, or DID document shape drifted from the spec, it fails.

const { purposes: { AssertionProofPurpose } } = jsigs as any;

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
    const gatekeeper = new Gatekeeper({ db: new DbJsonMemory('t'), ipfs, registries: ['local'] });
    keymaster = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher: new CipherNode(), passphrase: 'p' });
    await keymaster.loadOrCreateWallet();
});

// Resolve did:cid the way an external verifier would -- from the DID document,
// which the gatekeeper's /1.0/identifiers surface serves. Archon lists the
// identity key relatively (#key-1), so references are made absolute for the
// library's proof-purpose check.
async function externalVerify(credential: any, did: string) {
    const doc: any = await keymaster.resolveDID(did);
    const didDocument = doc.didDocument;
    const vm = didDocument.verificationMethod.find((v: any) => v.id.endsWith('#key-assertion-1'));
    const absolute = (ref: string) => (ref.startsWith('#') ? did + ref : ref);
    const controllerDoc = {
        ...didDocument,
        id: did,
        assertionMethod: (didDocument.assertionMethod || []).map(absolute),
    };

    const documentLoader = async (url: string) => {
        if (url === vm.id) {
            return { documentUrl: url, document: { '@context': 'https://w3id.org/security/multikey/v1', ...vm }, contextUrl: null };
        }
        if (url === did) {
            return { documentUrl: url, document: controllerDoc, contextUrl: null };
        }
        // eddsa-jcs-2022 canonicalizes with JCS, so no JSON-LD expansion is
        // needed; a permissive empty context satisfies the library for the
        // credential's own @context URLs.
        if (url.startsWith('http')) {
            return { documentUrl: url, document: { '@context': {} }, contextUrl: null };
        }
        throw new Error(`unresolvable: ${url}`);
    };

    const suite = new DataIntegrityProof({ cryptosuite: createVerifyCryptosuite() });
    return jsigs.verify(credential, { suite, purpose: new AssertionProofPurpose(), documentLoader });
}

async function issueCredential(name = 'Alice') {
    const did = await keymaster.createId(name, { registry: 'local' });
    await keymaster.publishAssertionKey(name);
    const document = {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
        issuer: did,
        credentialSubject: { id: did },
    };
    const signed: any = await keymaster.addProof(document, name, 'assertionMethod');
    const proofs = Array.isArray(signed.proof) ? signed.proof : [signed.proof];
    const eddsa = proofs.find((p: any) => p.cryptosuite === 'eddsa-jcs-2022');

    // An external verifier checks the standards-based proof; ship that one.
    return { did, credential: { ...document, proof: eddsa } };
}

describe('external verification (eddsa-jcs-2022)', () => {
    it('a third-party implementation verifies a credential Archon issued', async () => {
        const { did, credential } = await issueCredential();

        const result: any = await externalVerify(credential, did);

        expect(result.verified).toBe(true);
    });

    it('the third-party implementation rejects a tampered credential', async () => {
        const { did, credential } = await issueCredential();
        const tampered = { ...credential, credentialSubject: { id: 'did:cid:someone-else' } };

        const result: any = await externalVerify(tampered, did);

        expect(result.verified).toBe(false);
    });
});
