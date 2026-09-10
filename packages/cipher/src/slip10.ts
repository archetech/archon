import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';

// SLIP-0010 hierarchical derivation for the Ed25519 curve.
//
// BIP32 covers secp256k1 only. SLIP-0010 extends the same idea to other curves
// and keeps their key material apart by seeding each curve's master node with a
// different HMAC key, which is why an Ed25519 key derived here can never
// collide with a secp256k1 one derived from the same mnemonic.
//
// Only hardened derivation exists for Ed25519: a public key cannot be derived
// from a parent public key on this curve, so every index is hardened and an
// unhardened one is a mistake rather than a variant.

const ED25519_CURVE = new TextEncoder().encode('ed25519 seed');
const HARDENED = 0x80000000;

export interface Slip10Node {
    key: Uint8Array;
    chainCode: Uint8Array;
}

function split(digest: Uint8Array): Slip10Node {
    return { key: digest.slice(0, 32), chainCode: digest.slice(32) };
}

export function slip10MasterKey(seed: Uint8Array): Slip10Node {
    return split(hmac(sha512, ED25519_CURVE, seed));
}

const MAX_INDEX = 0xffffffff;

export function slip10DeriveChild(parent: Slip10Node, index: number): Slip10Node {
    // The whole uint32 range is checked, not just the hardened floor: setUint32
    // truncates a fraction and wraps anything above 2^32, so an out-of-range
    // index would silently derive some other node rather than fail.
    if (!Number.isInteger(index) || index < HARDENED || index > MAX_INDEX) {
        throw new Error(`SLIP-0010 Ed25519 derivation is hardened only, got index ${index}`);
    }

    // 0x00 || parent key || index, big-endian, per SLIP-0010.
    const data = new Uint8Array(37);
    data.set(parent.key, 1);
    new DataView(data.buffer).setUint32(33, index, false);

    return split(hmac(sha512, parent.chainCode, data));
}

/**
 * Derive an Ed25519 private key from a BIP39 seed along a SLIP-0010 path.
 *
 * The path is written the way BIP32 paths are (`m/44'/0'/0'/2'/0'`), and every
 * level must carry the hardened marker.
 */
export function slip10DerivePath(seed: Uint8Array, path: string): Uint8Array {
    const segments = path.split('/');

    if (segments.shift() !== 'm') {
        throw new Error(`Derivation path must start at the master node, got ${path}`);
    }

    let node = slip10MasterKey(seed);

    for (const segment of segments) {
        if (!/^\d+'$/.test(segment)) {
            throw new Error(`SLIP-0010 Ed25519 derivation is hardened only, got segment ${segment}`);
        }

        node = slip10DeriveChild(node, parseInt(segment, 10) + HARDENED);
    }

    return node.key;
}
