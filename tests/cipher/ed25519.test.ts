import CipherNode from '@didcid/cipher/node';
import { ed25519PublicKeyToMultikey, multikeyToEd25519PublicKey, bytesToMultibase, multibaseToBytes } from '@didcid/cipher/multikey';

const cipher = new CipherNode();

const seed = (byte: number) => new Uint8Array(32).fill(byte);
const bytes = (text: string) => new TextEncoder().encode(text);

describe('generateEd25519Jwk', () => {
    // The key is derived from an HD branch, so a wallet restored from its
    // mnemonic has to arrive at the same key or every credential it ever
    // signed becomes unverifiable.
    it('is deterministic in the seed', () => {
        expect(cipher.generateEd25519Jwk(seed(7))).toStrictEqual(cipher.generateEd25519Jwk(seed(7)));
        expect(cipher.generateEd25519Jwk(seed(7)).publicJwk.x)
            .not.toBe(cipher.generateEd25519Jwk(seed(8)).publicJwk.x);
    });

    it('produces an Ed25519 OKP JWK carrying the seed as its private key', () => {
        const { publicJwk, privateJwk } = cipher.generateEd25519Jwk(seed(1));

        expect(publicJwk.kty).toBe('OKP');
        expect(publicJwk.crv).toBe('Ed25519');
        expect(privateJwk.x).toBe(publicJwk.x);
        expect(privateJwk.d).toBeDefined();
    });

    // 32 bytes is the Ed25519 private key size; anything else silently means a
    // different key than the caller intended.
    it('refuses a seed that is not 32 bytes', () => {
        expect(() => cipher.generateEd25519Jwk(new Uint8Array(31))).toThrow('32 bytes');
    });
});

describe('signEd25519', () => {
    it('round-trips a signature', () => {
        const { publicJwk, privateJwk } = cipher.generateEd25519Jwk(seed(2));
        const signature = cipher.signEd25519(bytes('a credential'), privateJwk);

        expect(signature.length).toBe(64);
        expect(cipher.verifyEd25519(bytes('a credential'), signature, publicJwk)).toBe(true);
    });

    it('rejects a different message, a different key, and a mangled signature', () => {
        const { publicJwk, privateJwk } = cipher.generateEd25519Jwk(seed(3));
        const other = cipher.generateEd25519Jwk(seed(4)).publicJwk;
        const signature = cipher.signEd25519(bytes('a credential'), privateJwk);

        expect(cipher.verifyEd25519(bytes('another credential'), signature, publicJwk)).toBe(false);
        expect(cipher.verifyEd25519(bytes('a credential'), signature, other)).toBe(false);

        const mangled = Uint8Array.from(signature);
        mangled[0] ^= 0xff;
        expect(cipher.verifyEd25519(bytes('a credential'), mangled, publicJwk)).toBe(false);
    });

    // A caller that hands over garbage should get `false`, not an exception it
    // has to catch to decide a signature is bad.
    it('reports malformed input as unverified rather than throwing', () => {
        const { publicJwk } = cipher.generateEd25519Jwk(seed(5));

        expect(cipher.verifyEd25519(bytes('x'), new Uint8Array(3), publicJwk)).toBe(false);
    });
});

describe('multikey encoding', () => {
    // eddsa-jcs-2022 requires the verification method's publicKeyMultibase to
    // be the multicodec-prefixed key in base58-btc, which always starts `z`.
    it('encodes an Ed25519 public key as a prefixed multibase value', () => {
        const { publicJwk } = cipher.generateEd25519Jwk(seed(6));
        const key = Buffer.from(publicJwk.x, 'base64url');
        const multikey = ed25519PublicKeyToMultikey(key);

        expect(multikey.startsWith('z')).toBe(true);
        expect(Buffer.from(multikeyToEd25519PublicKey(multikey))).toStrictEqual(key);
    });

    it('refuses key material under another multicodec', () => {
        // 0xec is X25519 -- a key agreement key, which cannot verify anything.
        const x25519 = bytesToMultibase(new Uint8Array([0xec, 0x01, ...new Uint8Array(32)]));

        expect(() => multikeyToEd25519PublicKey(x25519)).toThrow('Ed25519');
    });

    // A proofValue is the bare signature in base58-btc, with no multicodec
    // prefix -- unlike a Multikey. Conflating the two produces a proof whose
    // signature is two bytes longer than it should be.
    it('round-trips an unprefixed value for proofValue', () => {
        const signature = new Uint8Array(64).fill(9);
        const encoded = bytesToMultibase(signature);

        expect(encoded.startsWith('z')).toBe(true);
        expect(Buffer.from(multibaseToBytes(encoded))).toStrictEqual(Buffer.from(signature));
    });
});

// The did:key form the DIDComm code already produces uses the same encoding, so
// a mismatch between the two would be a silent interop break.
describe('cross-check against the existing did:key encoding', () => {
    it('agrees with the W3C Ed25519 did:key vector', async () => {
        const { didKeyToX25519 } = await import('@didcid/cipher/didcomm');
        const didKey = 'did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG';

        // Resolving it proves the multicodec prefix this module writes is the
        // one the did:key reader expects to find.
        expect(() => didKeyToX25519(didKey)).not.toThrow();
        expect(multikeyToEd25519PublicKey(didKey.slice('did:key:'.length)).length).toBe(32);
    });
});

// A zero seed, with the values the Python port produces for it. Both suites
// pin the same constants, so a change to either implementation's encoding
// fails here rather than surfacing as a credential one side cannot verify.
describe('cross-language vector', () => {
    const SEED = new Uint8Array(32);
    const PUBLIC_X = 'O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik';
    const MULTIKEY = 'z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp';
    const SIGNATURE = '4lyHI9A5_o9F1snWqJF_qRvHVJE81Zb9NYpJOiGjy1kKZTe6vH3wQAq2GgVYnJw2tloUOHjLA0HU6eSEGcQ3DQ';

    it('matches the Python keymaster byte for byte', () => {
        const { publicJwk, privateJwk } = cipher.generateEd25519Jwk(SEED);

        expect(publicJwk.x).toBe(PUBLIC_X);
        expect(ed25519PublicKeyToMultikey(Buffer.from(publicJwk.x, 'base64url'))).toBe(MULTIKEY);
        expect(Buffer.from(cipher.signEd25519(bytes('hello'), privateJwk)).toString('base64url')).toBe(SIGNATURE);
    });
});
