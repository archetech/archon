import { sha256 } from '@noble/hashes/sha256';

/**
 * Concat KDF (Single Step KDF) per NIST SP 800-56A and RFC 7518 §4.6.2.
 *
 * Derives a symmetric key from an ECDH shared secret for use in JWE.
 *
 * @param sharedSecret - The raw ECDH shared secret (Z)
 * @param keyBitLength - Desired key length in bits (e.g. 128, 256)
 * @param algorithmId  - The "enc" value for ECDH-ES or "alg" for ECDH-ES+A*KW
 * @param apu          - Agreement PartyUInfo (typically empty)
 * @param apv          - Agreement PartyVInfo (typically empty)
 * @returns Derived key as Uint8Array
 */
export function concatKdf(
    sharedSecret: Uint8Array,
    keyBitLength: number,
    algorithmId: string,
    apu: Uint8Array = new Uint8Array(0),
    apv: Uint8Array = new Uint8Array(0),
): Uint8Array {
    const algIdBytes = new TextEncoder().encode(algorithmId);

    // Build otherInfo per RFC 7518 §4.6.2:
    //   AlgorithmID  = len(algId) || algId
    //   PartyUInfo   = len(apu)   || apu
    //   PartyVInfo   = len(apv)   || apv
    //   SuppPubInfo  = keydatalen (32-bit BE, in bits)
    const otherInfo = concatBytes(
        uint32BE(algIdBytes.length), algIdBytes,
        uint32BE(apu.length), apu,
        uint32BE(apv.length), apv,
        uint32BE(keyBitLength),
    );

    const hashLength = 256; // SHA-256 output in bits
    const reps = Math.ceil(keyBitLength / hashLength);
    const result = new Uint8Array(reps * 32);

    for (let counter = 1; counter <= reps; counter++) {
        const input = concatBytes(uint32BE(counter), sharedSecret, otherInfo);
        const digest = sha256(input);
        result.set(digest, (counter - 1) * 32);
    }

    return result.slice(0, keyBitLength / 8);
}

function uint32BE(value: number): Uint8Array {
    const buf = new Uint8Array(4);
    buf[0] = (value >>> 24) & 0xff;
    buf[1] = (value >>> 16) & 0xff;
    buf[2] = (value >>> 8) & 0xff;
    buf[3] = value & 0xff;
    return buf;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
    let totalLength = 0;
    for (const arr of arrays) totalLength += arr.length;
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}
