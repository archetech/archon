import { mkdtemp, rm } from 'fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import WalletJson from '../../packages/keymaster/src/db/json.ts';
import WalletSQLite from '../../packages/keymaster/src/db/sqlite.ts';
import { openWalletStore } from '../../packages/keymaster/src/db/open.ts';
import type { StoredWallet, WalletBase } from '../../packages/keymaster/src/types.ts';

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
    // ARCHON_WALLET_PATH is commonly absolute, and so is the default. Joining
    // one under dataFolder gives `data//home/you/...`, which is not a wallet
    // anyone asked for (#980).
    it('treats an absolute path as the location, not a name under dataFolder', async () => {
        await withTempDir(async dir => {
            const file = join(dir, 'absolute', 'wallet.db');
            const wallet = await WalletSQLite.create(file);

            try {
                await wallet.saveWallet(walletOne as StoredWallet);
                expect(existsSync(file)).toBe(true);
            } finally {
                await wallet.disconnect();
            }
        });
    });

    // The JSON backend creates its folder; without this the SQLite one fails
    // with SQLITE_CANTOPEN.
    it('creates the directory it was pointed at', async () => {
        await withTempDir(async dir => {
            const wallet = await WalletSQLite.create('wallet.db', join(dir, 'missing', 'deeper'));

            try {
                await expect(wallet.loadWallet()).resolves.toBeNull();
            } finally {
                await wallet.disconnect();
            }
        });
    });

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

describe('openWalletStore', () => {
    // These chdir, because the defect is about what a *relative* path means.
    // cwd is process-global and the unit suite runs --runInBand, so a test that
    // fails to restore it corrupts every later suite in the process.
    const originalCwd = process.cwd();

    afterEach(() => {
        if (process.cwd() !== originalCwd) {
            process.chdir(originalCwd);
        }
    });

    // A path passed whole to the SQLite store was read as a name and hung under
    // the store's own data folder, so one ARCHON_WALLET_PATH meant two
    // different files depending on the backend (#1073).
    it.each(['json', 'sqlite'])('writes a %s wallet to the relative path it was given', async walletType => {
        await withTempDir(async dir => {
            const cwd = process.cwd();
            process.chdir(dir);
            try {
                const wallet = await openWalletStore(walletType, './wallet.db') as WalletBase & { disconnect?: () => Promise<void> };

                try {
                    await expect(wallet.saveWallet(walletOne)).resolves.toBe(true);
                } finally {
                    await wallet.disconnect?.();
                }

                expect(existsSync(join(dir, 'wallet.db'))).toBe(true);
                expect(existsSync(join(dir, 'data', 'wallet.db'))).toBe(false);
            } finally {
                process.chdir(cwd);
            }
        });
    });

    it.each(['json', 'sqlite'])('writes a %s wallet to the absolute path it was given', async walletType => {
        await withTempDir(async dir => {
            const file = join(dir, 'nested', 'wallet.db');
            const wallet = await openWalletStore(walletType, file) as WalletBase & { disconnect?: () => Promise<void> };

            try {
                await expect(wallet.saveWallet(walletOne)).resolves.toBe(true);
            } finally {
                await wallet.disconnect?.();
            }

            expect(existsSync(file)).toBe(true);
        });
    });

    // create-wallet, create-id and the MCP tools behind loadOrCreateWallet all
    // provision without consulting the "no wallet" message, so the only place
    // that can stop them minting a second identity is before the store opens.
    it('refuses to open an empty path while a wallet is stranded under data/', async () => {
        await withTempDir(async dir => {
            const cwd = process.cwd();
            process.chdir(dir);
            try {
                mkdirSync(join(dir, 'data'), { recursive: true });
                const legacy = await WalletSQLite.create('wallet.json', 'data');
                await legacy.saveWallet(walletOne);
                await legacy.disconnect();

                await expect(openWalletStore('sqlite', './wallet.json')).rejects.toThrow('data/wallet.json');
                expect(existsSync(join(dir, 'wallet.json'))).toBe(false);
            } finally {
                process.chdir(cwd);
            }
        });
    });

    // Anything that is not the SQLite backend is the JSON one, which is what
    // every caller's `ARCHON_WALLET_TYPE || 'json'` already assumed.
    it('reads an unset wallet type as JSON', async () => {
        await withTempDir(async dir => {
            const file = join(dir, 'wallet.json');
            const wallet = await openWalletStore('', file);

            await wallet.saveWallet(walletOne);

            expect(JSON.parse(readFileSync(file, 'utf-8'))).toStrictEqual(walletOne);
        });
    });
});
