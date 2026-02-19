import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha512 } from '@noble/hashes/sha512';
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/hashes/utils';

const ENC_ITER_DEFAULT = 100_000;
const IV_LEN = 12;
const SALT_LEN = 16;

function getIterations(): number {
    if (typeof process !== 'undefined' && process.env?.PBKDF2_ITERATIONS) {
        const parsed = parseInt(process.env.PBKDF2_ITERATIONS, 10);
        if (!isNaN(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return ENC_ITER_DEFAULT;
}

export async function encryptWithPassphrase(plaintext: string, pass: string) {
    const salt = randomBytes(SALT_LEN);
    const iv = randomBytes(IV_LEN);
    const key = await deriveKey(pass, salt);

    const cipher = gcm(key, iv);
    const ct = cipher.encrypt(new TextEncoder().encode(plaintext));

    return { salt: b64(salt), iv: b64(iv), data: b64(ct) };
}

export async function decryptWithPassphrase(blob: { salt: string; iv: string; data: string }, pass: string) {
    const salt = ub64(blob.salt);
    const iv = ub64(blob.iv);
    const data = ub64(blob.data);
    const key = await deriveKey(pass, salt);

    const cipher = gcm(key, iv);
    const pt = cipher.decrypt(data);

    return new TextDecoder().decode(pt);
}

const b64 = (buf: Uint8Array) => {
    return Buffer.from(buf).toString('base64');
}

const ub64 = (b64: string) => {
    return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function deriveKey(pass: string, salt: Uint8Array): Promise<Uint8Array> {
    const enc = new TextEncoder();
    return pbkdf2Async(sha512, enc.encode(pass), salt, { c: getIterations(), dkLen: 32 });
}
