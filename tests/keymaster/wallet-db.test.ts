import { mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import WalletJson from '../../packages/keymaster/src/db/json.ts';
import WalletSQLite from '../../packages/keymaster/src/db/sqlite.ts';
import type { StoredWallet } from '../../packages/keymaster/src/types.ts';

const walletOne = {
    version: 2,
    seed: {},
    counter: 1,
    current: 'Alice',
    ids: {
        Alice: {
            did: 'did:cid:alice',
            account: 0,
            index: 0,
        },
    },
} as StoredWallet;

const walletTwo = {
    version: 2,
    seed: {},
    counter: 2,
    current: 'Bob',
    ids: {
        Bob: {
            did: 'did:cid:bob',
            account: 0,
            index: 1,
        },
    },
} as StoredWallet;

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'archon-wallet-db-test-'));
    try {
        await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe('WalletJson', () => {
    it('loads null when the wallet file is missing', async () => {
        await withTempDir(async dir => {
            const wallet = new WalletJson('wallet.json', dir);

            await expect(wallet.loadWallet()).resolves.toBeNull();
        });
    });

    it('creates the data folder and preserves existing wallets unless overwrite is set', async () => {
        await withTempDir(async dir => {
            const dataFolder = join(dir, 'nested', 'wallets');
            const wallet = new WalletJson('wallet.json', dataFolder);

            expect(existsSync(dataFolder)).toBe(false);
            await expect(wallet.saveWallet(walletOne)).resolves.toBe(true);
            expect(existsSync(dataFolder)).toBe(true);
            await expect(wallet.loadWallet()).resolves.toStrictEqual(walletOne);

            await expect(wallet.saveWallet(walletTwo)).resolves.toBe(false);
            await expect(wallet.loadWallet()).resolves.toStrictEqual(walletOne);

            await expect(wallet.saveWallet(walletTwo, true)).resolves.toBe(true);
            await expect(wallet.loadWallet()).resolves.toStrictEqual(walletTwo);
        });
    });
});

describe('WalletSQLite', () => {
    it('loads null when the wallet table is empty', async () => {
        await withTempDir(async dir => {
            const wallet = await WalletSQLite.create('wallet.db', dir);
            try {
                await expect(wallet.loadWallet()).resolves.toBeNull();
            } finally {
                await wallet.disconnect();
            }
        });
    });

    it('preserves existing wallets unless overwrite is set', async () => {
        await withTempDir(async dir => {
            const wallet = new WalletSQLite('wallet.db', dir);
            try {
                await expect(wallet.saveWallet(walletOne)).resolves.toBe(true);
                await expect(wallet.loadWallet()).resolves.toStrictEqual(walletOne);

                await expect(wallet.saveWallet(walletTwo)).resolves.toBe(false);
                await expect(wallet.loadWallet()).resolves.toStrictEqual(walletOne);

                await expect(wallet.saveWallet(walletTwo, true)).resolves.toBe(true);
                await expect(wallet.loadWallet()).resolves.toStrictEqual(walletTwo);
            } finally {
                await wallet.disconnect();
            }
        });
    });

    it('allows repeated connect and disconnect calls', async () => {
        await withTempDir(async dir => {
            const wallet = new WalletSQLite('wallet.db', dir);

            await expect(wallet.connect()).resolves.toBeUndefined();
            await expect(wallet.connect()).resolves.toBeUndefined();
            await expect(wallet.disconnect()).resolves.toBeUndefined();
            await expect(wallet.disconnect()).resolves.toBeUndefined();
        });
    });
});
