import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import GatekeeperClient from '@didcid/clients/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import WalletJson from '@didcid/keymaster/wallet/json';
import { createGatekeeperApp } from '../../services/gatekeeper/server/src/gatekeeper-api.ts';
import { addressOwner, readData, startMemepool } from '../../services/memepool/src/service.ts';
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

async function connected() {
    const client = new GatekeeperClient();

    await client.connect({ url: settings.gatekeeperURL, waitUntilReady: true, intervalSeconds: 1, chatty: false });

    return client;
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

it('does not start when told to make its identity on local, and makes no wallet', async () => {
    await expect(start({ registry: 'local' })).rejects.toThrow(/ARCHON_MEMEPOOL_REGISTRY cannot be local/);
    expect(existsSync(join(settings.dataDir, 'wallet.json'))).toBe(false);
});

it('does not start with a wallet whose identity is on local', async () => {
    const wallet = new Keymaster({
        gatekeeper: await connected(), wallet: new WalletJson('wallet.json', settings.dataDir), cipher: new CipherNode(), passphrase: settings.passphrase,
    });

    await wallet.newWallet();
    await wallet.createId(settings.name, { registry: 'local' });

    await expect(start()).rejects.toThrow(/registered on local/);
});

it('does not start with no passphrase, or with the wrong one for its wallet', async () => {
    await expect(start({ passphrase: '' })).rejects.toThrow('ARCHON_MEMEPOOL_WALLET_PASSPHRASE is not set');

    await start();
    await expect(start({ passphrase: 'another passphrase' })).rejects.toThrow();
}, 60_000);

describe('reading bytes a stranger named from the node', () => {
    it('gives the bytes of a CID the node has', async () => {
        const data = Buffer.from('some bytes');
        const cid = await (await connected()).addData(data);

        expect(Buffer.compare((await readData(settings.gatekeeperURL, cid, 100))!, data)).toBe(0);
        // The node's address may be given with a path, as it may be to connect.
        expect(Buffer.compare((await readData(`${settings.gatekeeperURL}/`, cid, 100))!, data)).toBe(0);
    });

    it('gives nothing for more than the limit, for a CID the node cannot have, and for what is no CID', async () => {
        const cid = await (await connected()).addData(Buffer.alloc(101, 1));

        expect(await readData(settings.gatekeeperURL, cid, 100)).toBeNull();
        expect(await readData(settings.gatekeeperURL, '../../version', 100)).toBeNull();
        expect(await readData(settings.gatekeeperURL, 'bafk?x=1', 100)).toBeNull();
        expect(await readData('http://127.0.0.1:1', cid, 1000)).toBeNull();
    });

    it('reads no further than the limit from a node that does not say how much it has', async () => {
        let sent = 0;
        const endless = (async () => new Response(new ReadableStream({
            pull(controller) {
                sent += 1;
                controller.enqueue(new Uint8Array(60));
            },
        }))) as typeof fetch;

        expect(await readData('http://node', 'bafkreiexample', 100, endless)).toBeNull();
        expect(sent).toBeLessThan(10);
    });
});

describe('asking a domain whose an address is', () => {
    const DID = 'did:cid:bagaaieraexample';
    const never = () => new AbortController().signal;
    const answering = (answer: () => Response | Promise<Response>) => {
        const asked: string[] = [];
        const fetcher = (async (target: string, init?: RequestInit) => {
            asked.push(target);
            init?.signal?.throwIfAborted();

            return answer();
        }) as never;

        return { asked, fetcher };
    };

    it('asks the domain for the name, and gives the DID it answers with', async () => {
        const { asked, fetcher } = answering(() => Response.json({ did: DID }));

        expect(await addressOwner('alice+tag@example.org', never(), fetcher)).toBe(DID);
        expect(asked).toStrictEqual(['https://example.org/.well-known/names/alice%2Btag']);
    });

    it('gives nothing when the domain has no such name, answers with no DID, or with what is not JSON', async () => {
        for (const answer of [
            () => Response.json({ error: 'Name not found' }, { status: 404 }),
            () => Response.json({ did: 7 }),
            () => Response.json(null),
            () => new Response('<html>'),
            () => new Response(null, { status: 204 }),
            () => { throw new Error('refusing request to non-public HTTPS target'); },
        ]) {
            expect(await addressOwner('alice@example.org', never(), answering(answer).fetcher)).toBeNull();
        }
    });

    it('reads no further than a short answer needs', async () => {
        let sent = 0;
        const { fetcher } = answering(() => new Response(new ReadableStream({
            pull(controller) {
                sent += 1;
                controller.enqueue(new Uint8Array(4096).fill(32));
            },
        })));

        expect(await addressOwner('alice@example.org', never(), fetcher)).toBeNull();
        expect(sent).toBeLessThan(10);
    });

    it('stops reading an answer that does not end when it is told to', async () => {
        let cancelled = false;
        const asking = new AbortController();
        const { fetcher } = answering(() => new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode('{"did":')); },
            cancel() { cancelled = true; },
        })));
        const owner = addressOwner('alice@example.org', asking.signal, fetcher);

        await new Promise(resolve => setTimeout(resolve, 20));
        asking.abort();

        expect(await owner).toBeNull();
        expect(cancelled).toBe(true);
    });

    it('asks nothing once it has been told to stop', async () => {
        const asking = new AbortController();
        asking.abort();

        expect(await addressOwner('alice@example.org', asking.signal, answering(() => Response.json({ did: DID })).fetcher)).toBeNull();
    });
});
