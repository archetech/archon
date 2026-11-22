import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { createGatekeeperApp } from '../../services/gatekeeper/server/src/gatekeeper-api.ts';
import { startMemepool } from '../../services/memepool/src/service.ts';
import type { MemepoolSettings } from '../../services/memepool/src/service.ts';

// The service's start: it reaches a Gatekeeper over HTTP, keeps its key in a
// wallet of its own, and is the same client at every start.

let node: Server;
let settings: MemepoolSettings;
let dirs: string[];
let running: Server[];
let warned: string[];
let logged: string[];

const dataDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'memepool-'));
    dirs.push(dir);
    return dir;
};

async function start(overrides: Partial<MemepoolSettings> = {}) {
    const started = await startMemepool({ ...settings, ...overrides }, { version: 'test', commit: 'test' }, {
        log: (message: string) => { logged.push(message); },
        warn: (message: string) => { warned.push(message); },
    });

    running.push(started.server);

    return { ...started, url: `http://127.0.0.1:${(started.server.address() as AddressInfo).port}` };
}

beforeEach(async () => {
    dirs = [];
    running = [];
    const gatekeeper = new Gatekeeper({
        db: new DbJsonMemory('memepool-service'), ipfs: new MemoryClient(), registries: ['local', 'hyperswarm', 'BTC:mainnet'],
        console: { log: () => undefined, error: () => undefined, time: () => undefined, timeEnd: () => undefined } as never,
    });

    warned = [];
    logged = [];
    const { app } = createGatekeeperApp({ gatekeeper, httpLogging: false, ready: true });

    node = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    settings = {
        gatekeeperURL: `http://127.0.0.1:${(node.address() as AddressInfo).port}`,
        port: 0,
        bindAddress: '127.0.0.1',
        name: 'memepool',
        publicURL: '',
        pagesDir: '',
        dataDir: dataDir(),
        passphrase: 'a passphrase',
        registry: 'hyperswarm',
        challengesPerMinute: 60,
        sessionHours: 24,
        trustedProxies: 0,
        gatekeeperTimeout: 30,
    };
});

afterEach(async () => {
    for (const server of [...running, node]) {
        await new Promise(resolve => server.close(resolve));
    }
    for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

it('makes its wallet and identity on a first start, and serves as that identity', async () => {
    const { did, url } = await start();

    expect(did).toMatch(/^did:/);
    expect((await request(url).get('/api/v1/config')).body).toStrictEqual({ name: 'memepool', did });
    expect((await request(url).get('/api/v1/version')).body).toStrictEqual({ version: 'test', commit: 'test' });
    expect((await request(url).get('/api/v1/challenge')).body.challenge).toMatch(/^did:/);
    expect(warned).toStrictEqual([expect.stringContaining('creating one')]);
    // Of the registries its node has, the ones a grant may be on.
    expect(logged).toContain('Memepool can publish on BTC:mainnet');
}, 60_000);

it('is the same client at the next start, and another with another data directory', async () => {
    const first = await start();
    const again = await start();
    const elsewhere = await start({ dataDir: dataDir() });

    expect(again.did).toBe(first.did);
    expect(warned).toHaveLength(2);
    expect(elsewhere.did).not.toBe(first.did);
}, 60_000);

it('does not start as an identity registered on local, which could publish on no grant\'s registry', async () => {
    await expect(start({ registry: 'local' })).rejects.toThrow(/registered on local/);
});

it('does not start with no passphrase, or with the wrong one for its wallet', async () => {
    await expect(start({ passphrase: '' })).rejects.toThrow('ARCHON_MEMEPOOL_WALLET_PASSPHRASE is not set');

    await start();
    await expect(start({ passphrase: 'another passphrase' })).rejects.toThrow();
}, 60_000);
