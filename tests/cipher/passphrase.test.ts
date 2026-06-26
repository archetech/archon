import { decryptWithPassphrase, encryptWithPassphrase } from '../../packages/cipher/src/passphrase.ts';

describe('passphrase encryption helpers', () => {
    const originalIterations = process.env.PBKDF2_ITERATIONS;

    beforeEach(() => {
        process.env.PBKDF2_ITERATIONS = '1';
    });

    afterEach(() => {
        if (originalIterations === undefined) {
            delete process.env.PBKDF2_ITERATIONS;
        }
        else {
            process.env.PBKDF2_ITERATIONS = originalIterations;
        }
    });

    it('encrypts and decrypts text with a passphrase', async () => {
        const encrypted = await encryptWithPassphrase('wallet secret', 'pass');

        expect(encrypted.salt).toBeTruthy();
        expect(encrypted.iv).toBeTruthy();
        expect(encrypted.data).toBeTruthy();
        await expect(decryptWithPassphrase(encrypted, 'pass')).resolves.toBe('wallet secret');
    });

    it('rejects decryption with the wrong passphrase', async () => {
        const encrypted = await encryptWithPassphrase('wallet secret', 'pass');

        await expect(decryptWithPassphrase(encrypted, 'wrong')).rejects.toThrow();
    });

    it('falls back to default iterations when the env override is invalid', async () => {
        process.env.PBKDF2_ITERATIONS = 'invalid';
        const encrypted = await encryptWithPassphrase('fallback secret', 'pass');

        await expect(decryptWithPassphrase(encrypted, 'pass')).resolves.toBe('fallback secret');
    });
});
