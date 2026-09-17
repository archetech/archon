import CipherNode from '@didcid/cipher/node';
import { base64url } from 'multiformats/bases/base64';

const cipher = new CipherNode();
const order = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

describe('native ECDSA message verification', () => {
    it('matches digest verification for valid and altered messages, keys, and signatures', async () => {
        for (let seed = 1; seed <= 16; seed++) {
            const { publicJwk, privateJwk } = cipher.generateJwk(new Uint8Array(32).fill(seed));
            const other = cipher.generateJwk(new Uint8Array(32).fill(seed + 1)).publicJwk;
            for (const message of ['canonical JSON: café 🌍', '', new Uint8Array(64).fill(seed)]) {
                const digest = cipher.hashMessage(message);
                const signature = cipher.signHash(digest, privateJwk);
                expect(await cipher.verifyMessage(message, signature, publicJwk)).toBe(true);
                const altered = Buffer.from(signature, 'hex');
                altered[seed] ^= 1;
                for (const sig of [signature, altered.toString('hex')]) {
                    for (const key of [publicJwk, other]) {
                        expect(await cipher.verifyMessage(message, sig, key))
                            .toBe(cipher.verifySig(digest, sig, key));
                    }
                }
                expect(await cipher.verifyMessage('changed message', signature, publicJwk)).toBe(false);
                // Supplying the digest as the message would hash twice.
                expect(await cipher.verifyMessage(Buffer.from(digest, 'hex'), signature, publicJwk)).toBe(false);
            }
        }
    });

    it('preserves low-S, compact encoding, and scalar-range requirements', async () => {
        const { publicJwk, privateJwk } = cipher.generateJwk(new Uint8Array(32).fill(1));
        const message = 'low-S';
        const digest = cipher.hashMessage(message);
        const signature = cipher.signHash(digest, privateJwk);
        const highS = (order - BigInt('0x' + signature.slice(64))).toString(16).padStart(64, '0');
        for (const sig of [signature.slice(0, 64) + highS]) {
            expect(cipher.verifySig(digest, sig, publicJwk)).toBe(false);
            expect(await cipher.verifyMessage(message, sig, publicJwk)).toBe(false);
        }
        for (const sig of ['', '00', '00'.repeat(64), 'ff'.repeat(64), signature + '00']) {
            expect(() => cipher.verifySig(digest, sig, publicJwk)).toThrow();
            await expect(cipher.verifyMessage(message, sig, publicJwk)).rejects.toThrow();
        }
    });

    it('preserves compressed-key interpretation and rejects invalid curve points', async () => {
        const { publicJwk, privateJwk } = cipher.generateJwk(new Uint8Array(32).fill(3));
        const message = 'compressed-key compatibility';
        const digest = cipher.hashMessage(message);
        const signature = cipher.signHash(digest, privateJwk);
        const y = base64url.baseDecode(publicJwk.y);
        y[0] ^= 1; // The existing verifier uses x and y parity, not the full y.
        const sameParity = { ...publicJwk, y: base64url.baseEncode(y) };
        expect(await cipher.verifyMessage(message, signature, sameParity)).toBe(true);
        expect(cipher.verifySig(digest, signature, sameParity)).toBe(true);
        y[y.length - 1] ^= 1;
        const oppositeParity = { ...publicJwk, y: base64url.baseEncode(y) };
        const invalidX = { ...publicJwk, x: base64url.baseEncode(new Uint8Array(32).fill(255)) };
        for (const key of [oppositeParity, invalidX]) {
            expect(await cipher.verifyMessage(message, signature, key)).toBe(false);
            expect(cipher.verifySig(digest, signature, key)).toBe(false);
        }
    });
});
