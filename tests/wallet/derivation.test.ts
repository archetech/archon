import { getXpub, getMasterFingerprint, getCoinType, getHDKeyVersions, buildDescriptors } from '../../services/satoshi-wallet/server/src/derivation';

// BIP-39 test mnemonic (DO NOT use for real funds)
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('Wallet derivation', () => {
    describe('getCoinType', () => {
        it('returns 0 for mainnet', () => {
            expect(getCoinType('mainnet')).toBe(0);
        });

        it('returns 1 for signet', () => {
            expect(getCoinType('signet')).toBe(1);
        });

        it('returns 1 for testnet4', () => {
            expect(getCoinType('testnet4')).toBe(1);
        });
    });

    describe('getHDKeyVersions', () => {
        it('returns mainnet version bytes for mainnet', () => {
            const versions = getHDKeyVersions('mainnet');
            expect(versions.public).toBe(0x0488B21E);  // xpub
            expect(versions.private).toBe(0x0488ADE4);  // xprv
        });

        it('returns testnet version bytes for signet', () => {
            const versions = getHDKeyVersions('signet');
            expect(versions.public).toBe(0x043587CF);  // tpub
            expect(versions.private).toBe(0x04358394);  // tprv
        });

        it('returns testnet version bytes for testnet4', () => {
            const versions = getHDKeyVersions('testnet4');
            expect(versions.public).toBe(0x043587CF);
            expect(versions.private).toBe(0x04358394);
        });
    });

    describe('getXpub', () => {
        it('derives mainnet xpub starting with "xpub"', () => {
            const xpub = getXpub(TEST_MNEMONIC, 'mainnet');
            expect(xpub).toMatch(/^xpub/);
        });

        it('derives signet tpub starting with "tpub"', () => {
            const tpub = getXpub(TEST_MNEMONIC, 'signet');
            expect(tpub).toMatch(/^tpub/);
        });

        it('derives testnet4 tpub starting with "tpub"', () => {
            const tpub = getXpub(TEST_MNEMONIC, 'testnet4');
            expect(tpub).toMatch(/^tpub/);
        });

        it('signet and testnet4 derive the same tpub (same coin type)', () => {
            const signet = getXpub(TEST_MNEMONIC, 'signet');
            const testnet4 = getXpub(TEST_MNEMONIC, 'testnet4');
            expect(signet).toBe(testnet4);
        });

        it('mainnet and signet derive different keys', () => {
            const mainnet = getXpub(TEST_MNEMONIC, 'mainnet');
            const signet = getXpub(TEST_MNEMONIC, 'signet');
            expect(mainnet).not.toBe(signet);
        });

        // BIP-84 test vector for "abandon..." mnemonic
        // m/84'/0'/0' — known xpub for this mnemonic
        it('matches BIP-84 test vector for mainnet', () => {
            const xpub = getXpub(TEST_MNEMONIC, 'mainnet');
            expect(xpub).toBe('xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V');
        });

        // m/84'/1'/0' — known tpub for this mnemonic
        it('matches BIP-84 test vector for signet/testnet', () => {
            const tpub = getXpub(TEST_MNEMONIC, 'signet');
            expect(tpub).toBe('tpubDC8msFGeGuwnKG9Upg7DM2b4DaRqg3CUZa5g8v2SRQ6K4NSkxUgd7HsL2XVWbVm39yBA4LAxysQAm397zwQSQoQgewGiYZqrA9DsP4zbQ1M');
        });

        it('is deterministic across calls', () => {
            const first = getXpub(TEST_MNEMONIC, 'mainnet');
            const second = getXpub(TEST_MNEMONIC, 'mainnet');
            expect(first).toBe(second);
        });
    });

    describe('getMasterFingerprint', () => {
        it('returns 8-character hex string', () => {
            const fp = getMasterFingerprint(TEST_MNEMONIC, 'mainnet');
            expect(fp).toMatch(/^[0-9a-f]{8}$/);
        });

        it('is the same regardless of network', () => {
            const mainnet = getMasterFingerprint(TEST_MNEMONIC, 'mainnet');
            const signet = getMasterFingerprint(TEST_MNEMONIC, 'signet');
            expect(mainnet).toBe(signet);
        });

        // Known fingerprint for "abandon..." mnemonic
        it('matches known fingerprint for test mnemonic', () => {
            const fp = getMasterFingerprint(TEST_MNEMONIC, 'mainnet');
            expect(fp).toBe('73c5da0a');
        });

        it('different mnemonic produces different fingerprint', () => {
            const other = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
            const fp1 = getMasterFingerprint(TEST_MNEMONIC, 'mainnet');
            const fp2 = getMasterFingerprint(other, 'mainnet');
            expect(fp1).not.toBe(fp2);
        });
    });

    describe('buildDescriptors', () => {
        it('builds wpkh descriptors with key origin info for mainnet', () => {
            const { external, internal } = buildDescriptors(TEST_MNEMONIC, 'mainnet');
            const fp = getMasterFingerprint(TEST_MNEMONIC, 'mainnet');
            const xpub = getXpub(TEST_MNEMONIC, 'mainnet');

            expect(external).toBe(`wpkh([${fp}/84h/0h/0h]${xpub}/0/*)`);
            expect(internal).toBe(`wpkh([${fp}/84h/0h/0h]${xpub}/1/*)`);
        });

        it('builds wpkh descriptors with coin type 1 for signet', () => {
            const { external, internal } = buildDescriptors(TEST_MNEMONIC, 'signet');
            const fp = getMasterFingerprint(TEST_MNEMONIC, 'signet');
            const tpub = getXpub(TEST_MNEMONIC, 'signet');

            expect(external).toBe(`wpkh([${fp}/84h/1h/0h]${tpub}/0/*)`);
            expect(internal).toBe(`wpkh([${fp}/84h/1h/0h]${tpub}/1/*)`);
        });

        it('external uses /0/* and internal uses /1/*', () => {
            const { external, internal } = buildDescriptors(TEST_MNEMONIC, 'mainnet');
            expect(external).toContain('/0/*)');
            expect(internal).toContain('/1/*)');
        });

        it('includes key origin fingerprint in brackets', () => {
            const { external } = buildDescriptors(TEST_MNEMONIC, 'mainnet');
            const fp = getMasterFingerprint(TEST_MNEMONIC, 'mainnet');
            expect(external).toMatch(new RegExp(`\\[${fp}/`));
        });
    });
});
