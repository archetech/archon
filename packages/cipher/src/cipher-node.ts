import { base64url } from 'multiformats/bases/base64';
import { createPublicKey, randomBytes, verify, KeyObject } from 'crypto';
import { Signature } from '@noble/secp256k1';
import CipherBase from './cipher-base.js';
import { Cipher, EcdsaJwkPublic } from './types.js';

// SubjectPublicKeyInfo for id-ecPublicKey / secp256k1, with a compressed point.
const SECP256K1_SPKI = Buffer.from('3036301006072a8648ce3d020106052b8104000a032200', 'hex');

export default class CipherNode extends CipherBase implements Cipher {
    private readonly verificationKeys = new Map<string, KeyObject>();

    // The message before SHA-256, unlike verifySig which accepts a digest.
    // OpenSSL hashes these bytes once and verifies the existing compact ECDSA proof.
    async verifyMessage(message: string | Uint8Array, sigHex: string, publicJwk: EcdsaJwkPublic): Promise<boolean> {
        const compressed = this.convertJwkToCompressedBytes(publicJwk);
        const signature = Signature.fromCompact(sigHex);
        // OpenSSL accepts high-S signatures; Archon's existing verifier does not.
        if (signature.hasHighS()) return false;
        try {
            const id = Buffer.from(compressed).toString('hex');
            let key = this.verificationKeys.get(id);
            if (!key) {
                // Use x plus y parity, exactly as verifySig does. Importing the
                // original JWK would change validation of its supplied y coordinate.
                key = createPublicKey({
                    key: Buffer.concat([SECP256K1_SPKI, compressed]),
                    format: 'der',
                    type: 'spki',
                });
                if (this.verificationKeys.size >= 1024) {
                    this.verificationKeys.delete(this.verificationKeys.keys().next().value!);
                }
                this.verificationKeys.set(id, key);
            }
            return await new Promise<boolean>(resolve => {
                verify('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }, signature.toCompactRawBytes(),
                    (error, valid) => resolve(!error && valid));
            });
        } catch {
            return false;
        }
    }

    generateRandomSalt(): string {
        return base64url.encode(randomBytes(32));
    }
}
