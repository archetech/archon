import * as secp from '@noble/secp256k1';
import { gcm } from '@noble/ciphers/aes';
import { base64url } from 'multiformats/bases/base64';
import { concatKdf } from './concat-kdf.js';
import { EcdsaJwkPublic, EcdsaJwkPrivate } from './types.js';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

interface JweHeader {
    alg: string;
    enc: string;
    epk: {
        kty: string;
        crv: string;
        x: string;
        y: string;
    };
}

/**
 * Build a JWE Compact Serialization string using ECDH-ES + A256GCM.
 *
 * Uses an ephemeral secp256k1 keypair for key agreement.
 * The sender's identity key is NOT involved — only the recipient's public key.
 *
 * @param recipientPubKey - Recipient's public key (secp256k1 JWK)
 * @param plaintext       - Data to encrypt
 * @returns JWE Compact string: header.encryptedKey.iv.ciphertext.tag
 */
export function buildJweCompact(
    recipientPubKey: EcdsaJwkPublic,
    plaintext: Uint8Array,
): string {
    // 1. Generate ephemeral keypair
    const ephemeralPrivKey = secp.utils.randomPrivateKey();
    const ephemeralPubKeyBytes = secp.getPublicKey(ephemeralPrivKey);

    // Get uncompressed public key coordinates for the JWE header
    const ephemeralPubHex = secp.etc.bytesToHex(ephemeralPubKeyBytes);
    const curvePoints = secp.ProjectivePoint.fromHex(ephemeralPubHex);
    const uncompressed = curvePoints.toRawBytes(false);
    const epkX = base64url.baseEncode(uncompressed.subarray(1, 33));
    const epkY = base64url.baseEncode(uncompressed.subarray(33, 65));

    // 2. Build protected header
    const header: JweHeader = {
        alg: 'ECDH-ES',
        enc: 'A256GCM',
        epk: {
            kty: 'EC',
            crv: 'secp256k1',
            x: epkX,
            y: epkY,
        },
    };
    const headerJson = JSON.stringify(header);
    const headerB64 = base64url.baseEncode(ENCODER.encode(headerJson));

    // 3. ECDH key agreement: ephemeral private + recipient public
    const recipientPubBytes = jwkToCompressedBytes(recipientPubKey);
    const sharedSecret = secp.getSharedSecret(ephemeralPrivKey, recipientPubBytes);

    // 4. Derive CEK via Concat KDF (RFC 7518 §4.6.2)
    // For ECDH-ES (direct), algorithmId = enc value
    const cek = concatKdf(sharedSecret.slice(1), 256, 'A256GCM');

    // 5. Generate random 96-bit IV
    const iv = secp.utils.randomPrivateKey().slice(0, 12);

    // 6. Encrypt with AES-256-GCM
    // AAD = ASCII bytes of the base64url-encoded protected header
    const aad = ENCODER.encode(headerB64);
    const cipher = gcm(cek, iv, aad);
    const encrypted = cipher.encrypt(plaintext); // returns ciphertext || tag

    // 7. Split ciphertext and tag (tag is last 16 bytes)
    const ciphertext = encrypted.slice(0, encrypted.length - 16);
    const tag = encrypted.slice(encrypted.length - 16);

    // 8. Assemble JWE Compact: header.encryptedKey.iv.ciphertext.tag
    // For ECDH-ES (direct), encrypted key is empty
    return [
        headerB64,
        '',                                      // empty encrypted key
        base64url.baseEncode(iv),
        base64url.baseEncode(ciphertext),
        base64url.baseEncode(tag),
    ].join('.');
}

/**
 * Parse and decrypt a JWE Compact Serialization string.
 *
 * @param recipientPrivKey - Recipient's private key (secp256k1 JWK)
 * @param jweCompact       - The JWE Compact string to decrypt
 * @returns Decrypted plaintext
 */
export function parseJweCompact(
    recipientPrivKey: EcdsaJwkPrivate,
    jweCompact: string,
): Uint8Array {
    // 1. Split into 5 parts
    const parts = jweCompact.split('.');
    if (parts.length !== 5) {
        throw new Error('Invalid JWE Compact: expected 5 segments');
    }
    const [headerB64, , ivB64, ciphertextB64, tagB64] = parts;

    // 2. Parse protected header
    const headerJson = DECODER.decode(base64url.baseDecode(headerB64));
    const header: JweHeader = JSON.parse(headerJson);

    if (header.alg !== 'ECDH-ES') {
        throw new Error(`Unsupported JWE alg: ${header.alg}`);
    }
    if (header.enc !== 'A256GCM') {
        throw new Error(`Unsupported JWE enc: ${header.enc}`);
    }

    // 3. Reconstruct ephemeral public key from header
    const epk = header.epk;
    const ephemeralPubBytes = jwkToCompressedBytes(epk as EcdsaJwkPublic);

    // 4. ECDH key agreement: recipient private + ephemeral public
    const recipientPrivBytes = base64url.baseDecode(recipientPrivKey.d);
    const sharedSecret = secp.getSharedSecret(recipientPrivBytes, ephemeralPubBytes);

    // 5. Derive CEK via Concat KDF
    const cek = concatKdf(sharedSecret.slice(1), 256, 'A256GCM');

    // 6. Decrypt with AES-256-GCM
    const iv = base64url.baseDecode(ivB64);
    const ciphertext = base64url.baseDecode(ciphertextB64);
    const tag = base64url.baseDecode(tagB64);

    // Reassemble ciphertext || tag for @noble/ciphers GCM
    const encrypted = new Uint8Array(ciphertext.length + tag.length);
    encrypted.set(ciphertext, 0);
    encrypted.set(tag, ciphertext.length);

    const aad = ENCODER.encode(headerB64);
    const cipher = gcm(cek, iv, aad);
    return cipher.decrypt(encrypted);
}

/**
 * Detect whether a string is a JWE Compact Serialization.
 */
export function isJweCompact(ciphertext: string): boolean {
    return ciphertext.startsWith('eyJ') && ciphertext.split('.').length === 5;
}

/**
 * Convert a JWK public key to compressed secp256k1 bytes.
 */
function jwkToCompressedBytes(jwk: EcdsaJwkPublic): Uint8Array {
    const xBytes = base64url.baseDecode(jwk.x);
    const yBytes = base64url.baseDecode(jwk.y);
    const prefix = yBytes[yBytes.length - 1] % 2 === 0 ? 0x02 : 0x03;
    return new Uint8Array([prefix, ...xBytes]);
}
