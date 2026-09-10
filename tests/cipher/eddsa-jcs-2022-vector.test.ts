import CipherNode from '@didcid/cipher/node';
import { multikeyToEd25519PublicKey, multibaseToBytes } from '@didcid/cipher/multikey';
import canonicalizeModule from 'canonicalize';
import { sha256 } from '@noble/hashes/sha256';

const canonicalize = canonicalizeModule as unknown as (input: unknown) => string;
const cipher = new CipherNode();

// The published test vectors for eddsa-jcs-2022, from W3C's Verifiable
// Credential Data Integrity ECDSA/EdDSA cryptosuites:
// https://www.w3.org/TR/vc-di-eddsa/ examples 29, 30, 33 and 38.
//
// This is the only check here that is not Archon verifying Archon. The proof
// was produced by the specification's own implementation, so it fails if our
// payload assembly differs from the spec in any respect -- key encoding,
// canonicalization, digest order, or signature encoding.

const UNSIGNED = {
    '@context': [
        'https://www.w3.org/ns/credentials/v2',
        'https://www.w3.org/ns/credentials/examples/v2',
    ],
    id: 'urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33',
    type: ['VerifiableCredential', 'AlumniCredential'],
    name: 'Alumni Credential',
    description: 'A minimum viable example of an Alumni Credential.',
    issuer: 'https://vc.example/issuers/5678',
    validFrom: '2023-01-01T00:00:00Z',
    credentialSubject: {
        id: 'did:example:abcdefgh',
        alumniOf: 'The School of Examples',
    },
};

const PROOF_CONFIG = {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: '2023-02-24T23:36:38Z',
    verificationMethod: 'did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2#z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2',
    proofPurpose: 'assertionMethod',
    '@context': [
        'https://www.w3.org/ns/credentials/v2',
        'https://www.w3.org/ns/credentials/examples/v2',
    ],
};

const PUBLIC_KEY_MULTIBASE = 'z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2';
const PROOF_VALUE = 'z2HnFSSPPBzR36zdDgK8PbEHeXbR56YF24jwMpt3R1eHXQzJDMWS93FCzpvJpwTWd3GAVFuUfjoJdcnTMuVor51aX';

// sha256 of the canonical proof config, then of the canonical document.
const payload = (config: unknown, document: unknown) =>
    new Uint8Array([...sha256(canonicalize(config)), ...sha256(canonicalize(document))]);

describe('the W3C eddsa-jcs-2022 test vector', () => {
    const publicJwk = {
        kty: 'OKP' as const,
        crv: 'Ed25519' as const,
        x: Buffer.from(multikeyToEd25519PublicKey(PUBLIC_KEY_MULTIBASE)).toString('base64url'),
    };

    it('verifies a proof this codebase did not produce', () => {
        expect(cipher.verifyEd25519(
            payload(PROOF_CONFIG, UNSIGNED),
            multibaseToBytes(PROOF_VALUE),
            publicJwk,
        )).toBe(true);
    });

    // Each of these is a way the payload could be assembled wrong while still
    // round-tripping against itself.
    it('fails if the document is altered', () => {
        const altered = { ...UNSIGNED, credentialSubject: { ...UNSIGNED.credentialSubject, alumniOf: 'Elsewhere' } };

        expect(cipher.verifyEd25519(payload(PROOF_CONFIG, altered), multibaseToBytes(PROOF_VALUE), publicJwk)).toBe(false);
    });

    it('fails if the proof config is dropped from the payload', () => {
        const documentOnly = new Uint8Array([...sha256(canonicalize(UNSIGNED))]);

        expect(cipher.verifyEd25519(documentOnly, multibaseToBytes(PROOF_VALUE), publicJwk)).toBe(false);
    });

    it('fails if the two digests are concatenated the other way round', () => {
        expect(cipher.verifyEd25519(payload(UNSIGNED, PROOF_CONFIG), multibaseToBytes(PROOF_VALUE), publicJwk)).toBe(false);
    });

    it('fails if the config keeps a proofValue that was not signed', () => {
        expect(cipher.verifyEd25519(
            payload({ ...PROOF_CONFIG, proofValue: PROOF_VALUE }, UNSIGNED),
            multibaseToBytes(PROOF_VALUE),
            publicJwk,
        )).toBe(false);
    });
});
