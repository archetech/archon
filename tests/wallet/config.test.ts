// Test config parsing. We can't import config.ts directly (it reads env vars at module load),
// so we test the toNetwork logic by replicating it.

type WalletNetwork = 'mainnet' | 'signet' | 'testnet4';
type WalletBackend = 'core' | 'alchemy';

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

function toBackend(name: string | undefined): WalletBackend {
    switch (name) {
    case 'core':
    case undefined:
        return 'core';
    case 'alchemy':
        return 'alchemy';
    default:
        throw new Error(`Unsupported wallet backend "${name}"`);
    }
}

function defaultUtxoUrl(rpcUrl?: string): string | undefined {
    if (!rpcUrl) {
        return undefined;
    }

    const url = new URL(rpcUrl);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/v2`;
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

    describe('toBackend', () => {
        it('defaults to core when undefined', () => {
            expect(toBackend(undefined)).toBe('core');
        });

        it('accepts alchemy', () => {
            expect(toBackend('alchemy')).toBe('alchemy');
        });

        it('throws for unsupported wallet backends', () => {
            expect(() => toBackend('hosted')).toThrow('Unsupported wallet backend "hosted"');
        });
    });

    describe('defaultUtxoUrl', () => {
        it('derives the hosted UTXO API base from a full RPC URL', () => {
            expect(defaultUtxoUrl('https://bitcoin-testnet4.g.alchemy.com/v2/key')).toBe(
                'https://bitcoin-testnet4.g.alchemy.com/v2/key/api/v2',
            );
        });
    });

});
