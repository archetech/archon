import { mkdtemp, rm } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
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

describe('WalletSQLite defaults and guards', () => {
    // Two tests below chdir, because WalletSQLite's default path is relative to
    // the working directory and that is the thing under test. cwd is
    // process-global and the unit suite runs --runInBand, so a test that fails to
    // restore it corrupts every later suite in the process. The paired finally
    // covers a thrown assertion but NOT a jest timeout, which abandons the
    // pending body and moves on -- hence this backstop, which jest runs either
    // way.
    const originalCwd = process.cwd();

    afterEach(() => {
        if (process.cwd() !== originalCwd) {
            process.chdir(originalCwd);
        }
    });

    // NOTE: unlike WalletJson.saveWallet, which does mkdirSync(dataFolder,
    // {recursive:true}), WalletSQLite.connect never creates its folder — it opens
    // `${dataFolder}/${file}` directly and sqlite cannot open the file if the
    // directory is absent. These tests therefore create `data/` first.
    it('does not create its data folder, unlike WalletJson', async () => {
        await withTempDir(async dir => {
            const folder = join(dir, 'missing');
            const wallet = new WalletSQLite('wallet.db', folder);

            // The guarantee is that the folder is not created, so that is what
            // is asserted; matching the driver's wording would break on a Node
            // rephrasing even while the behaviour held.
            await expect(wallet.saveWallet(walletOne)).rejects.toThrow();
            expect(existsSync(folder)).toBe(false);
        });
    });

    it('defaults to data/wallet.db when constructed with no arguments', async () => {
        await withTempDir(async dir => {
            // The default path is relative to the working directory, so run from a
            // temp dir rather than writing data/wallet.db into the repo.
            const cwd = process.cwd();
            process.chdir(dir);
            mkdirSync(join(dir, 'data'), { recursive: true });
            try {
                const wallet = new WalletSQLite();
                try {
                    await expect(wallet.saveWallet(walletOne)).resolves.toBe(true);
                    await expect(wallet.loadWallet()).resolves.toStrictEqual(walletOne);
                    expect(existsSync(join(dir, 'data', 'wallet.db'))).toBe(true);
                } finally {
                    await wallet.disconnect();
                }
            } finally {
                process.chdir(cwd);
            }
        });
    });

    it('leaves the working directory as it found it', () => {
        // Regression guard for the cascade this backstop prevents: when this
        // suite leaked cwd, the failure surfaced in cli-parity.test.ts as an
        // ENOENT naming a temp directory, which points at the wrong file.
        expect(process.cwd()).toBe(originalCwd);
    });

    it('create() applies the same defaults', async () => {
        await withTempDir(async dir => {
            const cwd = process.cwd();
            process.chdir(dir);
            mkdirSync(join(dir, 'data'), { recursive: true });
            try {
                const wallet = await WalletSQLite.create();
                try {
                    await expect(wallet.loadWallet()).resolves.toBeNull();
                    expect(existsSync(join(dir, 'data', 'wallet.db'))).toBe(true);
                } finally {
                    await wallet.disconnect();
                }
            } finally {
                process.chdir(cwd);
            }
        });
    });

    it('reports a failed connection rather than dereferencing a null handle', async () => {
        await withTempDir(async dir => {
            const wallet = new WalletSQLite('wallet.db', dir);
            // Both methods call connect() first and then re-check the handle. Stub
            // connect to a no-op so the handle stays null and the guard is reached —
            // it is otherwise unreachable, since a successful connect always sets it.
            (wallet as any).connect = async () => {};

            await expect(wallet.saveWallet(walletOne)).rejects.toThrow('DB failed to connect.');
            await expect(wallet.loadWallet()).rejects.toThrow('DB failed to connect.');
        });
    });
});
