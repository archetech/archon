import { jest } from '@jest/globals';

// Guards the property SECURITY.md calls the most important one to preserve:
// key material comes from the platform CSPRNG, and the code throws rather than
// quietly substituting something weaker.
//
// This is not hypothetical. The July 2026 Coldcard incident was exactly this
// failure — a build-configuration error silently bound seed generation to a
// deterministic fallback PRNG instead of the hardware RNG, cutting real entropy
// to roughly 40 bits. It went unnoticed for five years because degraded output
// still looks random. Statistical tests would not have caught it, and neither
// would any assertion about the shape of a generated mnemonic. The only useful
// things to assert are where the bytes come from, and that there is no fallback
// to fall into.
//
// Note there are TWO independent RNG implementations behind these calls:
// mnemonics and salts go through `@noble/hashes` `randomBytes`, while vault
// keypairs go through `@noble/secp256k1`, which ships its own. They are
// separate packages on separate version lines, so a bump can change one and not
// the other — hence a test for each.

describe('key material comes from the platform CSPRNG', () => {
    it('draws mnemonic entropy from crypto.getRandomValues', async () => {
        const { default: CipherNode } = await import('@didcid/cipher/node');
        const cipher = new CipherNode();
        const spy = jest.spyOn(globalThis.crypto, 'getRandomValues');

        try {
            const mnemonic = cipher.generateMnemonic();

            // Read the count before restoring — mockRestore() clears the record.
            expect(spy.mock.calls.length).toBeGreaterThan(0);
            // 12 words is 128 bits, the strength SECURITY.md documents.
            expect(mnemonic.split(' ')).toHaveLength(12);
        }
        finally {
            spy.mockRestore();
        }
    });

    it('draws vault keypair entropy from crypto.getRandomValues', async () => {
        const { default: CipherNode } = await import('@didcid/cipher/node');
        const cipher = new CipherNode();
        const spy = jest.spyOn(globalThis.crypto, 'getRandomValues');

        try {
            cipher.generateRandomJwk();

            expect(spy.mock.calls.length).toBeGreaterThan(0);
        }
        finally {
            spy.mockRestore();
        }
    });
});

describe('there is no weak RNG to fall back to', () => {
    it('vault keypair generation throws when no platform CSPRNG is available', async () => {
        const { default: CipherNode } = await import('@didcid/cipher/node');
        const cipher = new CipherNode();
        // @noble/secp256k1 reads globalThis.crypto at call time, so removing it
        // here exercises the real code path rather than a mocked module.
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;

        delete (globalThis as any).crypto;

        try {
            // The failure mode to prevent is this returning a key instead of
            // throwing. A silent fallback is undetectable in production.
            expect(() => cipher.generateRandomJwk()).toThrow();
        }
        finally {
            Object.defineProperty(globalThis, 'crypto', descriptor);
        }
    });

    // Kept last and nested: the module mock replaces the crypto module for any
    // subsequent import in this file's registry.
    describe('hashes RNG', () => {
        afterAll(() => {
            jest.resetModules();
        });

        it('throws instead of degrading when no platform CSPRNG is available', async () => {
            jest.unstable_mockModule('@noble/hashes/crypto', () => ({ crypto: undefined }));
            jest.resetModules();

            const { randomBytes } = await import('@noble/hashes/utils');

            expect(() => randomBytes(32)).toThrow(/getRandomValues must be defined/);
        });
    });
});
