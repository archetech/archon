// DIDComm v2 envelope crypto (pure-JS, runs in browser + node).
//
// Implements the encrypted (JWE) and signed (JWS) envelopes DIDComm requires,
// on top of the ECDH-ES + Concat-KDF + JWE scaffolding already in this package:
//   - anoncrypt: ECDH-ES + A256KW, XC20P content encryption
//   - authcrypt: ECDH-1PU + A256KW, A256CBC-HS512 content encryption
// Header construction (alg/enc/apu/apv/skid/epk) matches didcomm-rust so that
// envelopes interoperate with the `didcomm`/`didcomm-node` reference library.
//
// These are pure functions over raw JWKs — no DID resolution or wallet access.
// Keymaster resolves DIDs to keys and calls these.
import * as secp from '@noble/secp256k1';
import { x25519 } from '@noble/curves/ed25519';
import { ecb, cbc, gcm } from '@noble/ciphers/aes';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { hmac } from '@noble/hashes/hmac';
import { randomBytes } from '@noble/hashes/utils';
import { base64url } from 'multiformats/bases/base64';
import { concatKdf } from './concat-kdf.js';
import { OkpJwkPublic, OkpJwkPrivate, EcdsaJwkPublic, EcdsaJwkPrivate } from './types.js';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export type DidCommEnc = 'A256CBC-HS512' | 'XC20P' | 'A256GCM';

export interface DidCommRecipientKey {
    kid: string;
    publicJwk: OkpJwkPublic;
}

export interface DidCommSenderKey {
    kid: string;
    privateJwk: OkpJwkPrivate;
}

export interface DidCommPrivateKey {
    kid: string;
    privateJwk: OkpJwkPrivate;
}

interface JweProtected {
    typ: string;
    alg: string;
    enc: string;
    skid?: string;
    apu?: string;
    apv?: string;
    epk: { kty: 'OKP'; crv: 'X25519'; x: string };
}

interface JweJson {
    protected: string;
    recipients: Array<{ header: { kid: string }; encrypted_key: string }>;
    iv: string;
    ciphertext: string;
    tag: string;
}

export interface DidCommEnvelopeInfo {
    type: 'encrypted' | 'signed' | 'plaintext';
    alg?: string;
    enc?: string;
    skid?: string;
    kids?: string[];
}

// ---------------------------------------------------------------------------
// byte helpers
// ---------------------------------------------------------------------------

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const a of arrays) total += a.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
}

const b64uEncode = (b: Uint8Array): string => base64url.baseEncode(b);
const b64uDecode = (s: string): Uint8Array => base64url.baseDecode(s);
const b64uJson = (obj: unknown): string => b64uEncode(ENCODER.encode(JSON.stringify(obj)));

function x25519Public(seed: Uint8Array): Uint8Array {
    return x25519.getPublicKey(seed);
}

// ---------------------------------------------------------------------------
// AES Key Wrap (A256KW, RFC 3394) — built on AES-256-ECB single-block ops
// ---------------------------------------------------------------------------

const KW_IV = new Uint8Array([0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6]);

function xorCounter(a: Uint8Array, t: number): void {
    const tb = new Uint8Array(8);
    new DataView(tb.buffer).setUint32(4, t >>> 0, false);
    for (let i = 0; i < 8; i++) a[i] ^= tb[i];
}

export function aesKeyWrap(kek: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (plaintext.length % 8 !== 0) throw new Error('A256KW: key length must be a multiple of 8 bytes');
    const n = plaintext.length / 8;
    const block = ecb(kek, { disablePadding: true });
    let a = KW_IV.slice();
    const r: Uint8Array[] = [];
    for (let i = 0; i < n; i++) r.push(plaintext.slice(i * 8, i * 8 + 8));
    for (let j = 0; j < 6; j++) {
        for (let i = 0; i < n; i++) {
            const b = block.encrypt(concatBytes(a, r[i]));
            a = b.slice(0, 8);
            xorCounter(a, n * j + (i + 1));
            r[i] = b.slice(8, 16);
        }
    }
    return concatBytes(a, ...r);
}

export function aesKeyUnwrap(kek: Uint8Array, wrapped: Uint8Array): Uint8Array {
    if (wrapped.length % 8 !== 0) throw new Error('A256KW: wrapped length must be a multiple of 8 bytes');
    const n = wrapped.length / 8 - 1;
    const block = ecb(kek, { disablePadding: true });
    let a = wrapped.slice(0, 8);
    const r: Uint8Array[] = [];
    for (let i = 0; i < n; i++) r.push(wrapped.slice((i + 1) * 8, (i + 2) * 8));
    for (let j = 5; j >= 0; j--) {
        for (let i = n - 1; i >= 0; i--) {
            xorCounter(a, n * j + (i + 1));
            const b = block.decrypt(concatBytes(a, r[i]));
            a = b.slice(0, 8);
            r[i] = b.slice(8, 16);
        }
    }
    for (let i = 0; i < 8; i++) {
        if (a[i] !== KW_IV[i]) throw new Error('A256KW: integrity check failed');
    }
    return concatBytes(...r);
}

// ---------------------------------------------------------------------------
// Content encryption
// ---------------------------------------------------------------------------

function cekLength(enc: DidCommEnc): number {
    return enc === 'A256CBC-HS512' ? 64 : 32;
}

interface ContentResult { iv: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array; }

function contentEncrypt(enc: DidCommEnc, cek: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): ContentResult {
    if (enc === 'A256CBC-HS512') {
        const macKey = cek.slice(0, 32);
        const encKey = cek.slice(32, 64);
        const iv = randomBytes(16);
        const ciphertext = cbc(encKey, iv).encrypt(plaintext);
        const tag = a256cbcHs512Tag(macKey, aad, iv, ciphertext);
        return { iv, ciphertext, tag };
    }
    if (enc === 'XC20P') {
        const iv = randomBytes(24);
        const out = xchacha20poly1305(cek, iv, aad).encrypt(plaintext);
        return { iv, ciphertext: out.slice(0, out.length - 16), tag: out.slice(out.length - 16) };
    }
    // A256GCM
    const iv = randomBytes(12);
    const out = gcm(cek, iv, aad).encrypt(plaintext);
    return { iv, ciphertext: out.slice(0, out.length - 16), tag: out.slice(out.length - 16) };
}

function contentDecrypt(enc: DidCommEnc, cek: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array, aad: Uint8Array): Uint8Array {
    if (enc === 'A256CBC-HS512') {
        const macKey = cek.slice(0, 32);
        const encKey = cek.slice(32, 64);
        const expected = a256cbcHs512Tag(macKey, aad, iv, ciphertext);
        if (!timingSafeEqual(expected, tag)) throw new Error('A256CBC-HS512: authentication tag mismatch');
        return cbc(encKey, iv).decrypt(ciphertext);
    }
    if (enc === 'XC20P') {
        return xchacha20poly1305(cek, iv, aad).decrypt(concatBytes(ciphertext, tag));
    }
    return gcm(cek, iv, aad).decrypt(concatBytes(ciphertext, tag));
}

// A256CBC-HS512 authentication tag per RFC 7518 §5.2.2.1:
//   AL = 64-bit big-endian bit-length of the AAD
//   T  = HMAC-SHA-512(MAC_KEY, AAD || IV || ciphertext || AL)[0:32]
function a256cbcHs512Tag(macKey: Uint8Array, aad: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    const al = new Uint8Array(8);
    new DataView(al.buffer).setBigUint64(0, BigInt(aad.length) * 8n, false);
    return hmac(sha512, macKey, concatBytes(aad, iv, ciphertext, al)).slice(0, 32);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

// ---------------------------------------------------------------------------
// Key agreement: derive the A256KW key-encryption key
// ---------------------------------------------------------------------------

// apv = base64url(SHA-256(sorted recipient kids joined by ".")) — matches didcomm-rust
function computeApv(kids: string[]): string {
    const sorted = [...kids].sort();
    return b64uEncode(sha256(ENCODER.encode(sorted.join('.'))));
}

// ConcatKDF over the (concatenated, for 1PU) ECDH shared secret(s). For
// ECDH-1PU + key wrapping the JWE Authentication Tag is mixed in as SuppPrivInfo.
function deriveKek(alg: string, sharedSecret: Uint8Array, apu: Uint8Array, apv: Uint8Array, tag?: Uint8Array): Uint8Array {
    return concatKdf(sharedSecret, 256, alg, apu, apv, tag ?? new Uint8Array(0));
}

// ---------------------------------------------------------------------------
// Encrypted envelope (JWE general serialization)
// ---------------------------------------------------------------------------

export function packEncrypted(
    plaintext: Uint8Array,
    recipients: DidCommRecipientKey[],
    sender: DidCommSenderKey | null,
    enc: DidCommEnc,
): string {
    if (recipients.length === 0) throw new Error('packEncrypted: at least one recipient required');

    const alg = sender ? 'ECDH-1PU+A256KW' : 'ECDH-ES+A256KW';
    const apvStr = computeApv(recipients.map(r => r.kid));

    // Ephemeral key shared across recipients
    const ephSeed = x25519.utils.randomPrivateKey();
    const ephPub = x25519Public(ephSeed);

    const header: JweProtected = {
        typ: 'application/didcomm-encrypted+json',
        alg,
        enc,
        ...(sender ? { skid: sender.kid, apu: b64uEncode(ENCODER.encode(sender.kid)) } : {}),
        apv: apvStr,
        epk: { kty: 'OKP', crv: 'X25519', x: b64uEncode(ephPub) },
    };
    const protectedB64 = b64uJson(header);
    const aad = ENCODER.encode(protectedB64);

    const apu = sender ? ENCODER.encode(sender.kid) : new Uint8Array(0);
    const apv = b64uDecode(apvStr);

    // Single CEK shared across recipients, content-encrypted once
    const cek = randomBytes(cekLength(enc));
    const { iv, ciphertext, tag } = contentEncrypt(enc, cek, plaintext, aad);

    const senderSeed = sender ? b64uDecode(sender.privateJwk.d) : null;

    const recipientsOut = recipients.map((r) => {
        const recipPub = b64uDecode(r.publicJwk.x);
        // Ze: ephemeral <-> recipient
        const ze = x25519.getSharedSecret(ephSeed, recipPub);
        // authcrypt (1PU): also Zs = sender static <-> recipient; Z = Ze || Zs
        const z = senderSeed ? concatBytes(ze, x25519.getSharedSecret(senderSeed, recipPub)) : ze;
        // ECDH-1PU + A256KW mixes the content-encryption tag into the KDF
        const kek = deriveKek(alg, z, apu, apv, senderSeed ? tag : undefined);
        const encryptedKey = aesKeyWrap(kek, cek);
        return { header: { kid: r.kid }, encrypted_key: b64uEncode(encryptedKey) };
    });

    const jwe: JweJson = {
        protected: protectedB64,
        recipients: recipientsOut,
        iv: b64uEncode(iv),
        ciphertext: b64uEncode(ciphertext),
        tag: b64uEncode(tag),
    };
    return JSON.stringify(jwe);
}

export function unpackEncrypted(
    packed: string,
    recipient: DidCommPrivateKey,
    senderPublicJwk?: OkpJwkPublic,
): { plaintext: Uint8Array; header: JweProtected } {
    const jwe: JweJson = JSON.parse(packed);
    const header: JweProtected = JSON.parse(DECODER.decode(b64uDecode(jwe.protected)));
    const enc = header.enc as DidCommEnc;

    const isAuthcrypt = header.alg === 'ECDH-1PU+A256KW';
    if (!isAuthcrypt && header.alg !== 'ECDH-ES+A256KW') {
        throw new Error(`Unsupported DIDComm alg: ${header.alg}`);
    }
    if (isAuthcrypt && !senderPublicJwk) {
        throw new Error('authcrypt message requires the sender public key');
    }

    const match = jwe.recipients.find(r => r.header.kid === recipient.kid);
    if (!match) throw new Error(`No recipient entry for kid ${recipient.kid}`);

    const recipSeed = b64uDecode(recipient.privateJwk.d);
    const ephPub = b64uDecode(header.epk.x);
    // Ze: recipient <-> ephemeral
    const ze = x25519.getSharedSecret(recipSeed, ephPub);
    const z = isAuthcrypt
        ? concatBytes(ze, x25519.getSharedSecret(recipSeed, b64uDecode(senderPublicJwk!.x)))
        : ze;

    const apu = header.apu ? b64uDecode(header.apu) : new Uint8Array(0);
    const apv = header.apv ? b64uDecode(header.apv) : new Uint8Array(0);
    const tagBytes = b64uDecode(jwe.tag);
    const kek = deriveKek(header.alg, z, apu, apv, isAuthcrypt ? tagBytes : undefined);
    const cek = aesKeyUnwrap(kek, b64uDecode(match.encrypted_key));

    const aad = ENCODER.encode(jwe.protected);
    const plaintext = contentDecrypt(enc, cek, b64uDecode(jwe.iv), b64uDecode(jwe.ciphertext), tagBytes, aad);
    return { plaintext, header };
}

// ---------------------------------------------------------------------------
// Signed envelope (JWS general serialization), ES256K (secp256k1)
// ---------------------------------------------------------------------------

export interface DidCommSigner {
    kid: string;
    privateJwk: EcdsaJwkPrivate;
}

function secpJwkToCompressed(jwk: EcdsaJwkPublic): Uint8Array {
    const xBytes = b64uDecode(jwk.x);
    const yBytes = b64uDecode(jwk.y);
    const prefix = yBytes[yBytes.length - 1] % 2 === 0 ? 0x02 : 0x03;
    return new Uint8Array([prefix, ...xBytes]);
}

export function signJws(payload: Uint8Array, signer: DidCommSigner): string {
    const protectedB64 = b64uJson({ typ: 'application/didcomm-signed+json', alg: 'ES256K' });
    const payloadB64 = b64uEncode(payload);
    const signingInput = ENCODER.encode(`${protectedB64}.${payloadB64}`);
    const sig = secp.sign(sha256(signingInput), b64uDecode(signer.privateJwk.d));
    return JSON.stringify({
        payload: payloadB64,
        signatures: [{ protected: protectedB64, header: { kid: signer.kid }, signature: b64uEncode(sig.toCompactRawBytes()) }],
    });
}

export function verifyJws(jws: string, publicJwk: EcdsaJwkPublic): { payload: Uint8Array; kid?: string } {
    const obj = JSON.parse(jws);
    const sigEntry = obj.signatures[0];
    const signingInput = ENCODER.encode(`${sigEntry.protected}.${obj.payload}`);
    const ok = secp.verify(b64uDecode(sigEntry.signature), sha256(signingInput), secpJwkToCompressed(publicJwk));
    if (!ok) throw new Error('JWS signature verification failed');
    return { payload: b64uDecode(obj.payload), kid: sigEntry.header?.kid };
}

// ---------------------------------------------------------------------------
// Message-level pack/unpack: serialize JWM -> optional JWS -> JWE
// ---------------------------------------------------------------------------

export interface PackOptions {
    sender?: DidCommSenderKey;   // present => authcrypt, else anoncrypt
    signer?: DidCommSigner;      // present => sign (ES256K) before encrypting
    enc?: DidCommEnc;
}

export interface UnpackKeys {
    senderKey?: OkpJwkPublic;    // required to decrypt authcrypt
    signerKey?: EcdsaJwkPublic;  // required to verify a nested signature
}

export interface UnpackMetadata {
    encrypted: boolean;
    authenticated: boolean;
    nonRepudiation: boolean;
    sender?: string;             // skid (authcrypt)
    signer?: string;             // JWS kid
}

export function packDidCommMessage(message: object, recipients: DidCommRecipientKey[], options: PackOptions = {}): string {
    const jwm = ENCODER.encode(JSON.stringify(message));
    const payload = options.signer ? ENCODER.encode(signJws(jwm, options.signer)) : jwm;
    const enc = options.enc ?? (options.sender ? 'A256CBC-HS512' : 'XC20P');
    return packEncrypted(payload, recipients, options.sender ?? null, enc);
}

export function unpackDidCommMessage(packed: string, recipient: DidCommPrivateKey, keys: UnpackKeys = {}): { message: any; metadata: UnpackMetadata } {
    const { plaintext, header } = unpackEncrypted(packed, recipient, keys.senderKey);
    const text = DECODER.decode(plaintext);
    const inner = JSON.parse(text);

    if (inner && inner.signatures) {
        if (!keys.signerKey) throw new Error('signed message requires the signer public key to verify');
        const { payload, kid } = verifyJws(text, keys.signerKey);
        return {
            message: JSON.parse(DECODER.decode(payload)),
            metadata: { encrypted: true, authenticated: header.alg === 'ECDH-1PU+A256KW', nonRepudiation: true, sender: header.skid, signer: kid },
        };
    }
    return {
        message: inner,
        metadata: { encrypted: true, authenticated: header.alg === 'ECDH-1PU+A256KW', nonRepudiation: false, sender: header.skid },
    };
}

// ---------------------------------------------------------------------------
// Envelope inspection (lets keymaster resolve skid before unpacking)
// ---------------------------------------------------------------------------

export function getEnvelopeInfo(packed: string): DidCommEnvelopeInfo {
    let obj: any;
    try { obj = JSON.parse(packed); } catch { return { type: 'plaintext' }; }
    if (obj.ciphertext && obj.recipients) {
        const header: JweProtected = JSON.parse(DECODER.decode(b64uDecode(obj.protected)));
        return {
            type: 'encrypted',
            alg: header.alg,
            enc: header.enc,
            skid: header.skid,
            kids: obj.recipients.map((r: any) => r.header.kid),
        };
    }
    if (obj.signatures || obj.signature) {
        return { type: 'signed' };
    }
    return { type: 'plaintext' };
}
