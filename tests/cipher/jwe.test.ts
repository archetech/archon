import CipherNode from '@didcid/cipher/node';
import { concatKdf } from '../../packages/cipher/src/concat-kdf.ts';
import { buildJweCompact, parseJweCompact, isJweCompact } from '../../packages/cipher/src/jwe.ts';

const cipher = new CipherNode();

describe('concatKdf', () => {
    it('should derive a 256-bit key', () => {
        const sharedSecret = new Uint8Array(32).fill(0xab);
        const key = concatKdf(sharedSecret, 256, 'A256GCM');

        expect(key).toBeInstanceOf(Uint8Array);
        expect(key.length).toBe(32);
    });

    it('should produce deterministic output', () => {
        const sharedSecret = new Uint8Array(32).fill(0xcd);
        const key1 = concatKdf(sharedSecret, 256, 'A256GCM');
        const key2 = concatKdf(sharedSecret, 256, 'A256GCM');

        expect(Buffer.from(key1).toString('hex')).toBe(Buffer.from(key2).toString('hex'));
    });

    it('should produce different output for different algorithm IDs', () => {
        const sharedSecret = new Uint8Array(32).fill(0xef);
        const key1 = concatKdf(sharedSecret, 256, 'A256GCM');
        const key2 = concatKdf(sharedSecret, 256, 'A128GCM');

        expect(Buffer.from(key1).toString('hex')).not.toBe(Buffer.from(key2).toString('hex'));
    });

    it('should produce different output for different shared secrets', () => {
        const ss1 = new Uint8Array(32).fill(0x01);
        const ss2 = new Uint8Array(32).fill(0x02);
        const key1 = concatKdf(ss1, 256, 'A256GCM');
        const key2 = concatKdf(ss2, 256, 'A256GCM');

        expect(Buffer.from(key1).toString('hex')).not.toBe(Buffer.from(key2).toString('hex'));
    });

    it('should support apu and apv parameters', () => {
        const sharedSecret = new Uint8Array(32).fill(0xab);
        const apu = new TextEncoder().encode('Alice');
        const apv = new TextEncoder().encode('Bob');
        const keyWithParties = concatKdf(sharedSecret, 256, 'A256GCM', apu, apv);
        const keyWithout = concatKdf(sharedSecret, 256, 'A256GCM');

        expect(Buffer.from(keyWithParties).toString('hex')).not.toBe(Buffer.from(keyWithout).toString('hex'));
    });
});

describe('isJweCompact', () => {
    it('should detect JWE Compact strings', () => {
        // Needs exactly 5 dot-separated segments starting with eyJ
        expect(isJweCompact('eyJhbGc.enckey.iv.ct.tag')).toBe(true);
    });

    it('should reject non-JWE strings', () => {
        expect(isJweCompact('u2FsdGVkX19...')).toBe(false);
        expect(isJweCompact('eyJhbGc.only.three')).toBe(false);
        expect(isJweCompact('')).toBe(false);
    });
});

describe('JWE Compact Serialization', () => {
    const keypair = cipher.generateRandomJwk();

    it('should produce a valid 5-part JWE Compact string', () => {
        const plaintext = new TextEncoder().encode('Hello, World!');
        const jwe = buildJweCompact(keypair.publicJwk, plaintext);

        const parts = jwe.split('.');
        expect(parts.length).toBe(5);
        // Encrypted key should be empty for ECDH-ES (direct)
        expect(parts[1]).toBe('');
        // Should start with eyJ (base64url-encoded JSON object)
        expect(jwe.startsWith('eyJ')).toBe(true);
    });

    it('should have correct header fields', () => {
        const plaintext = new TextEncoder().encode('test');
        const jwe = buildJweCompact(keypair.publicJwk, plaintext);

        const headerB64 = jwe.split('.')[0];
        const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());

        expect(header.alg).toBe('ECDH-ES');
        expect(header.enc).toBe('A256GCM');
        expect(header.epk).toBeDefined();
        expect(header.epk.kty).toBe('EC');
        expect(header.epk.crv).toBe('secp256k1');
        expect(header.epk.x).toBeDefined();
        expect(header.epk.y).toBeDefined();
    });

    it('should roundtrip encrypt and decrypt', () => {
        const message = 'The quick brown fox jumps over the lazy dog';
        const plaintext = new TextEncoder().encode(message);
        const jwe = buildJweCompact(keypair.publicJwk, plaintext);
        const decrypted = parseJweCompact(keypair.privateJwk, jwe);

        expect(new TextDecoder().decode(decrypted)).toBe(message);
    });

    it('should roundtrip empty payload', () => {
        const plaintext = new Uint8Array(0);
        const jwe = buildJweCompact(keypair.publicJwk, plaintext);
        const decrypted = parseJweCompact(keypair.privateJwk, jwe);

        expect(decrypted.length).toBe(0);
    });

    it('should roundtrip large payload', () => {
        const plaintext = new Uint8Array(100000);
        for (let i = 0; i < plaintext.length; i++) {
            plaintext[i] = i % 256;
        }
        const jwe = buildJweCompact(keypair.publicJwk, plaintext);
        const decrypted = parseJweCompact(keypair.privateJwk, jwe);

        expect(Buffer.from(decrypted).toString('hex')).toBe(Buffer.from(plaintext).toString('hex'));
    });

    it('should produce different ciphertext each time (ephemeral keys)', () => {
        const plaintext = new TextEncoder().encode('same message');
        const jwe1 = buildJweCompact(keypair.publicJwk, plaintext);
        const jwe2 = buildJweCompact(keypair.publicJwk, plaintext);

        // Headers differ (different ephemeral keys)
        expect(jwe1).not.toBe(jwe2);
        // But both decrypt to the same plaintext
        const dec1 = new TextDecoder().decode(parseJweCompact(keypair.privateJwk, jwe1));
        const dec2 = new TextDecoder().decode(parseJweCompact(keypair.privateJwk, jwe2));
        expect(dec1).toBe(dec2);
    });

    it('should fail to decrypt with wrong key', () => {
        const otherKeypair = cipher.generateRandomJwk();
        const plaintext = new TextEncoder().encode('secret');
        const jwe = buildJweCompact(keypair.publicJwk, plaintext);

        expect(() => parseJweCompact(otherKeypair.privateJwk, jwe)).toThrow();
    });

    it('should fail on invalid JWE format', () => {
        expect(() => parseJweCompact(keypair.privateJwk, 'not.a.jwe')).toThrow('expected 5 segments');
    });

    it('should fail on unsupported algorithm', () => {
        const header = Buffer.from(JSON.stringify({ alg: 'RSA-OAEP', enc: 'A256GCM' })).toString('base64url');
        const fakeJwe = `${header}..iv.ct.tag`;
        expect(() => parseJweCompact(keypair.privateJwk, fakeJwe)).toThrow('Unsupported JWE alg');
    });
});

describe('Cipher JWE integration', () => {
    it('should encrypt and decrypt a message via cipher interface', () => {
        const keypair = cipher.generateRandomJwk();
        const message = 'Hello via cipher!';

        const encrypted = cipher.encryptMessage(keypair.publicJwk, message);
        expect(isJweCompact(encrypted)).toBe(true);

        const decrypted = cipher.decryptMessage(keypair.privateJwk, encrypted);
        expect(decrypted).toBe(message);
    });

    it('should encrypt and decrypt bytes via cipher interface', () => {
        const keypair = cipher.generateRandomJwk();
        const data = new Uint8Array([1, 2, 3, 4, 5]);

        const encrypted = cipher.encryptBytes(keypair.publicJwk, data);
        expect(isJweCompact(encrypted)).toBe(true);

        const decrypted = cipher.decryptBytes(keypair.privateJwk, encrypted);
        expect(Buffer.from(decrypted).toString('hex')).toBe(Buffer.from(data).toString('hex'));
    });

    it('should have legacy decryption methods available', () => {
        expect(typeof cipher.decryptMessageLegacy).toBe('function');
        expect(typeof cipher.decryptBytesLegacy).toBe('function');
    });
});
