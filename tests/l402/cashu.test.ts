import { isTrustedMint } from '../../packages/l402/src/cashu.js';
import { MOCK_CASHU_CONFIG } from './helper.js';
import type { CashuConfig } from '../../packages/l402/src/types.js';

describe('L402 Cashu', () => {

    describe('isTrustedMint', () => {
        it('should return true for a trusted mint', () => {
            expect(isTrustedMint(MOCK_CASHU_CONFIG, 'https://mint.example.com')).toBe(true);
        });

        it('should return true for a trusted mint with trailing slash', () => {
            expect(isTrustedMint(MOCK_CASHU_CONFIG, 'https://mint.example.com/')).toBe(true);
        });

        it('should return false for an untrusted mint', () => {
            expect(isTrustedMint(MOCK_CASHU_CONFIG, 'https://evil-mint.example.com')).toBe(false);
        });

        it('should handle trusted mints with trailing slashes', () => {
            const config: CashuConfig = {
                mintUrl: 'https://mint.example.com/',
                trustedMints: ['https://mint.example.com/'],
            };
            expect(isTrustedMint(config, 'https://mint.example.com')).toBe(true);
        });

        it('should return true for second trusted mint', () => {
            expect(isTrustedMint(MOCK_CASHU_CONFIG, 'https://mint2.example.com')).toBe(true);
        });
    });
});
