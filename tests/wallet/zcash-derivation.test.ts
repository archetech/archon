import { deriveTransparentAddress, getCoinType, getXpub } from '../../services/mediators/zcash-wallet/src/derivation';
import { validateOpReturnData, zatsToZec, zecToZats } from '../../services/mediators/zcash-wallet/src/zcash-wallet';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('Zcash transparent wallet derivation', () => {
    it('uses Zcash coin type 133 on mainnet', () => {
        expect(getCoinType('mainnet')).toBe(133);
    });

    it('uses test coin type 1 on testnet', () => {
        expect(getCoinType('testnet')).toBe(1);
    });

    it('derives deterministic transparent mainnet addresses', () => {
        expect(deriveTransparentAddress(TEST_MNEMONIC, 'mainnet', 0, 0)).toBe('t1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F');
    });

    it('derives deterministic transparent testnet addresses', () => {
        expect(deriveTransparentAddress(TEST_MNEMONIC, 'testnet', 0, 0)).toBe('tmF1xjfhsSzhy55dmhorzTnKjtHhZmPKzts');
    });

    it('derives account xpubs consistently', () => {
        expect(getXpub(TEST_MNEMONIC, 'mainnet')).toMatch(/^xpub/);
        expect(getXpub(TEST_MNEMONIC, 'testnet')).toMatch(/^tpub/);
    });

    it('converts ZEC to zats without floating point drift', () => {
        expect(zecToZats(0.0001)).toBe(10_000);
        expect(zatsToZec(10_000)).toBe(0.0001);
    });

    it('accepts 80-byte OP_RETURN payloads', () => {
        expect(validateOpReturnData('a'.repeat(80))).toHaveLength(80);
    });

    it('rejects OP_RETURN payloads above 80 bytes', () => {
        expect(() => validateOpReturnData('a'.repeat(81))).toThrow('OP_RETURN data exceeds 80 byte limit');
    });
});
