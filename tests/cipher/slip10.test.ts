import { slip10MasterKey, slip10DeriveChild, slip10DerivePath } from '../../packages/cipher/src/slip10.ts';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

// SLIP-0010 test vector 1 for ed25519, seed 000102030405060708090a0b0c0d0e0f.
// https://github.com/satoshilabs/slips/blob/master/slip-0010.md
const SEED = bytes('000102030405060708090a0b0c0d0e0f');

describe('SLIP-0010 ed25519 published vectors', () => {
    it('derives the master node', () => {
        const master = slip10MasterKey(SEED);

        expect(hex(master.chainCode)).toBe('90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb');
        expect(hex(master.key)).toBe('2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
    });

    it("derives m/0'", () => {
        const child = slip10DeriveChild(slip10MasterKey(SEED), 0x80000000);

        expect(hex(child.chainCode)).toBe('8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69');
        expect(hex(child.key)).toBe('68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
    });

    it("derives m/0'/1'/2'/2'/1000000000' by path", () => {
        expect(hex(slip10DerivePath(SEED, "m/0'/1'/2'/2'/1000000000'")))
            .toBe('8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793');
    });
});

describe('hardened-only', () => {
    // On this curve a public key cannot be derived from a parent public key, so
    // an unhardened index is a mistake rather than a variant -- and silently
    // accepting one would produce a key no other SLIP-0010 wallet can find.
    it('refuses an unhardened index', () => {
        expect(() => slip10DeriveChild(slip10MasterKey(SEED), 0)).toThrow('hardened only');
    });

    it('refuses an unhardened path segment', () => {
        expect(() => slip10DerivePath(SEED, "m/44'/0'/0'/2/0")).toThrow('hardened only');
    });

    // setUint32 truncates a fraction and wraps past 2^32, so an unchecked index
    // would silently derive some other node instead of failing.
    it.each([NaN, 2147483648.5, 0x100000000, Infinity])('refuses the out-of-range index %p', (index) => {
        expect(() => slip10DeriveChild(slip10MasterKey(SEED), index)).toThrow('hardened only');
    });

    it('refuses a path that does not start at the master node', () => {
        expect(() => slip10DerivePath(SEED, "44'/0'")).toThrow('master node');
    });
});

describe('curve separation', () => {
    // SLIP-0010 seeds each curve's master with a different HMAC key precisely so
    // one mnemonic cannot yield the same bytes on two curves. This is the
    // property that makes deriving Ed25519 keys from the same mnemonic as the
    // secp256k1 identity keys safe.
    it('does not reproduce the BIP32 secp256k1 master for the same seed', async () => {
        const { HDKey } = await import('@scure/bip32');
        const secp = HDKey.fromMasterSeed(SEED);

        expect(hex(slip10MasterKey(SEED).key)).not.toBe(Buffer.from(secp.privateKey!).toString('hex'));
    });
});
