import canonicalizeModule from 'canonicalize';
import type { JSONEncodingOptions } from './types.js';
import { CID } from 'multiformats';
import * as jsonCodec from 'multiformats/codecs/json';
import * as rawCodec from 'multiformats/codecs/raw';
import * as sha256 from 'multiformats/hashes/sha2';

const canonicalize = canonicalizeModule as unknown as (input: unknown) => string | undefined;

export function isValidCID(cid: any): boolean {
    try {
        CID.parse(cid);
        return true;
    } catch (error) {
        return false;
    }
}

export function isValidDID(did: string): boolean {
    if (typeof did !== 'string') {
        return false;
    }

    if (!did.startsWith('did:')) {
        return false;
    }

    const parts = did.split(':');

    if (parts.length < 3) {
        return false;
    }

    const suffix = parts.pop();
    return isValidCID(suffix);
}

// Canonical JSON must reach the hash/storage unchanged. Parsing it back into
// an object would make JSON.stringify reorder integer-index property names.
export function encodeJSON(data: any, options?: JSONEncodingOptions): Uint8Array {
    if (!options?.canonical) return jsonCodec.encode(data);
    function validateUnicode(value: any): void {
        if (typeof value === 'string' && /[\uD800-\uDFFF]/u.test(value)) {
            throw new Error('RFC 8785 requires well-formed Unicode');
        }
        if (value && typeof value === 'object') {
            for (const key of Object.keys(value)) {
                validateUnicode(key);
                validateUnicode(value[key]);
            }
        }
    }
    validateUnicode(data);
    const canonical = canonicalize(data);
    if (canonical === undefined) {
        throw new Error('Value has no JSON serialization');
    }
    return new TextEncoder().encode(canonical);
}

export async function generateCID(data: any, options?: JSONEncodingOptions): Promise<string> {
    let buf;
    let code;

    if (typeof data === 'string') {
        buf = new TextEncoder().encode(data);
        code = rawCodec.code;
    }
    else if (data instanceof Buffer) {
        buf = data;
        code = rawCodec.code;
    }
    else {
        buf = encodeJSON(data, options);
        code = jsonCodec.code;
    }

    const hash = await sha256.sha256.digest(buf);
    const cid = CID.createV1(code, hash);

    return cid.toString(); // CID v1 default: base32 encoding
}
