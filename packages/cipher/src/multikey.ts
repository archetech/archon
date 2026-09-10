import { base58btc } from 'multiformats/bases/base58';

// Multibase and Multikey encoding, as Controlled Identifiers v1.0 defines them.
//
// Two different things here use base58-btc, and only one of them is prefixed:
//
//   - A *Multikey* verification method's `publicKeyMultibase` carries a
//     multicodec-prefixed public key. `eddsa-jcs-2022` requires this form, and
//     did:key identifiers use the same encoding.
//   - A Data Integrity `proofValue` carries the raw signature with no prefix.
//
// base58btc.encode prepends the `z` header, and decode expects it.

// Multicodec varint prefixes for key material, each followed by 0x01.
export const MULTICODEC_X25519_PUB = 0xec;
export const MULTICODEC_ED25519_PUB = 0xed;

export function bytesToMultibase(bytes: Uint8Array): string {
    return base58btc.encode(bytes);
}

export function multibaseToBytes(multibase: string): Uint8Array {
    return base58btc.decode(multibase);
}

export function keyToMultikey(codec: number, key: Uint8Array): string {
    return base58btc.encode(new Uint8Array([codec, 0x01, ...key]));
}

export function multikeyToKey(multibase: string): { codec: number, key: Uint8Array } {
    const decoded = base58btc.decode(multibase);

    if (decoded.length < 3 || decoded[1] !== 0x01) {
        throw new Error('Unsupported multibase key material');
    }

    return { codec: decoded[0], key: decoded.slice(2) };
}

export function ed25519PublicKeyToMultikey(key: Uint8Array): string {
    return keyToMultikey(MULTICODEC_ED25519_PUB, key);
}

export const ED25519_PUBLIC_KEY_BYTES = 32;

export function multikeyToEd25519PublicKey(multibase: string): Uint8Array {
    const { codec, key } = multikeyToKey(multibase);

    if (codec !== MULTICODEC_ED25519_PUB) {
        throw new Error(`Expected an Ed25519 key, got multicodec 0x${codec.toString(16)}`);
    }

    // Rejected here rather than deeper in: a wrong-length key reaches the curve
    // code as something that merely fails to verify, which reads as a bad
    // signature rather than a malformed document.
    if (key.length !== ED25519_PUBLIC_KEY_BYTES) {
        throw new Error(`An Ed25519 key is ${ED25519_PUBLIC_KEY_BYTES} bytes, got ${key.length}`);
    }

    return key;
}
