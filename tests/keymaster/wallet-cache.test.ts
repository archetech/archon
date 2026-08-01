import { jest } from '@jest/globals';

import WalletCache from '../../packages/keymaster/src/db/cache.ts';
import type { StoredWallet, WalletBase } from '../../packages/keymaster/src/types.ts';

const wallet = { version: 2, seed: {}, counter: 0, current: 'Alice', ids: {} } as StoredWallet;
const other = { version: 2, seed: {}, counter: 1, current: 'Bob', ids: {} } as StoredWallet;

function baseWallet(stored: StoredWallet | null = null) {
    return {
        saveWallet: jest.fn<any>().mockResolvedValue(true),
        loadWallet: jest.fn<any>().mockResolvedValue(stored),
    } as unknown as WalletBase;
}

describe('WalletCache', () => {
    it('reads through to the base wallet only once', async () => {
        const base = baseWallet(wallet);
        const cache = new WalletCache(base);

        await expect(cache.loadWallet()).resolves.toEqual(wallet);
        await expect(cache.loadWallet()).resolves.toEqual(wallet);

        expect(base.loadWallet).toHaveBeenCalledTimes(1);
    });

    it('keeps asking the base wallet while it has nothing to cache', async () => {
        const base = baseWallet(null);
        const cache = new WalletCache(base);

        await expect(cache.loadWallet()).resolves.toBeNull();
        await expect(cache.loadWallet()).resolves.toBeNull();

        // A null result is not cached, so each call re-reads.
        expect(base.loadWallet).toHaveBeenCalledTimes(2);
    });

    it('writes through and serves the saved wallet from cache', async () => {
        const base = baseWallet(wallet);
        const cache = new WalletCache(base);

        await expect(cache.saveWallet(other)).resolves.toBe(true);
        expect(base.saveWallet).toHaveBeenCalledWith(other, false);

        // The save populated the cache, so no read reaches the base wallet.
        await expect(cache.loadWallet()).resolves.toEqual(other);
        expect(base.loadWallet).not.toHaveBeenCalled();
    });

    it('passes the overwrite flag through', async () => {
        const base = baseWallet();
        const cache = new WalletCache(base);

        await cache.saveWallet(wallet, true);

        expect(base.saveWallet).toHaveBeenCalledWith(wallet, true);
    });

    it('reports a base-wallet save failure', async () => {
        const base = {
            saveWallet: jest.fn<any>().mockResolvedValue(false),
            loadWallet: jest.fn<any>().mockResolvedValue(null),
        } as unknown as WalletBase;
        const cache = new WalletCache(base);

        await expect(cache.saveWallet(wallet)).resolves.toBe(false);
    });
});
