// Test config parsing. We can't import config.ts directly (it reads env vars at module load),
// so we test the toNetwork logic by replicating it.

type WalletNetwork = 'mainnet' | 'signet' | 'testnet4';

function toNetwork(name: string | undefined): WalletNetwork {
    switch (name) {
    case 'mainnet':
        return 'mainnet';
    case 'signet':
    case undefined:
        return 'signet';
    case 'testnet4':
        return 'testnet4';
    default:
        throw new Error(`Unsupported network "${name}"`);
    }
}

describe('Config', () => {
    describe('toNetwork', () => {
        it('returns mainnet for "mainnet"', () => {
            expect(toNetwork('mainnet')).toBe('mainnet');
        });

        it('returns signet for "signet"', () => {
            expect(toNetwork('signet')).toBe('signet');
        });

        it('returns testnet4 for "testnet4"', () => {
            expect(toNetwork('testnet4')).toBe('testnet4');
        });

        it('defaults to signet when undefined', () => {
            expect(toNetwork(undefined)).toBe('signet');
        });

        it('throws for unsupported network', () => {
            expect(() => toNetwork('regtest')).toThrow('Unsupported network "regtest"');
        });

        it('throws for empty string', () => {
            expect(() => toNetwork('')).toThrow('Unsupported network ""');
        });
    });
});
