import { jest } from '@jest/globals';

const mockCreate = jest.fn();

jest.unstable_mockModule('kubo-rpc-client', () => ({
    create: mockCreate,
}));

const { default: KuboClient } = await import('../../packages/ipfs/src/kubo-client.ts');
const jsonCodec = await import('multiformats/codecs/json');

const PEER_ID = '12D3KooWTestPeerIdentifier';

/** A stand-in for the kubo RPC surface, with only what the client actually calls. */
function createRpc(overrides: Record<string, any> = {}) {
    return {
        id: jest.fn<any>().mockResolvedValue({
            id: { toString: () => PEER_ID },
            addresses: [],
        }),
        add: jest.fn<any>().mockResolvedValue({ cid: { toString: () => 'bafy-added' } }),
        cat: jest.fn<any>(() => (async function* () { yield Buffer.from('hello'); })()),
        block: {
            put: jest.fn<any>().mockResolvedValue(undefined),
            get: jest.fn<any>().mockResolvedValue(jsonCodec.encode({ hello: 'world' })),
        },
        swarm: {
            connect: jest.fn<any>().mockResolvedValue(['connect success']),
            peers: jest.fn<any>().mockResolvedValue([{ peer: PEER_ID }]),
        },
        config: {
            get: jest.fn<any>().mockResolvedValue([]),
            set: jest.fn<any>().mockResolvedValue(undefined),
        },
        ...overrides,
    };
}

async function connected(overrides: Record<string, any> = {}) {
    const rpc = createRpc(overrides);
    mockCreate.mockReturnValue(rpc);
    const client = await KuboClient.create({ url: 'http://localhost:5001' });
    return { client, rpc };
}

let logSpy: any;
let warnSpy: any;
let errorSpy: any;

beforeEach(() => {
    mockCreate.mockReset();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
});

describe('KuboClient connect', () => {
    it('passes the options straight through to the rpc client', async () => {
        const options = { url: 'http://ipfs.test:5001' };
        mockCreate.mockReturnValue(createRpc());

        await KuboClient.create(options);

        expect(mockCreate).toHaveBeenCalledWith(options);
    });

    it('does not wait for readiness unless asked', async () => {
        const rpc = createRpc();
        mockCreate.mockReturnValue(rpc);

        await KuboClient.create({ url: 'http://ipfs.test:5001' });

        expect(rpc.id).not.toHaveBeenCalled();
    });

    it('waits for readiness when requested', async () => {
        const rpc = createRpc();
        mockCreate.mockReturnValue(rpc);

        await KuboClient.create({ url: 'http://ipfs.test:5001', waitUntilReady: true });

        expect(rpc.id).toHaveBeenCalled();
    });
});

describe('KuboClient isReady', () => {
    it('is true when the node answers id()', async () => {
        const { client } = await connected();

        await expect(client.isReady()).resolves.toBe(true);
    });

    it('is false when id() rejects', async () => {
        const { client } = await connected({
            id: jest.fn<any>().mockRejectedValue(new Error('connection refused')),
        });

        await expect(client.isReady()).resolves.toBe(false);
    });
});

describe('KuboClient waitUntilReady', () => {
    it('gives up after maxRetries when the node never comes up', async () => {
        const { client, rpc } = await connected({
            id: jest.fn<any>().mockRejectedValue(new Error('down')),
        });

        await client.waitUntilReady({ url: 'x', intervalSeconds: 0, maxRetries: 2 });

        // Bounded: it stops rather than looping forever.
        expect(rpc.id.mock.calls.length).toBeLessThanOrEqual(4);
    });

    it('returns as soon as the node reports ready', async () => {
        let attempts = 0;
        const { client } = await connected({
            id: jest.fn<any>(async () => {
                attempts += 1;
                if (attempts < 2) throw new Error('not yet');
                return { id: { toString: () => PEER_ID }, addresses: [] };
            }),
        });

        await client.waitUntilReady({ url: 'x', intervalSeconds: 0 });

        expect(attempts).toBe(2);
    });

    it('announces progress when chatty', async () => {
        const { client } = await connected();

        await client.waitUntilReady({ url: 'http://ipfs.test:5001', intervalSeconds: 0, chatty: true });

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Connecting to IPFS at'));
        expect(logSpy).toHaveBeenCalledWith('IPFS service is ready!');
    });

    it('becomes chatty after the configured number of silent retries', async () => {
        let attempts = 0;
        const { client } = await connected({
            id: jest.fn<any>(async () => {
                attempts += 1;
                if (attempts < 3) throw new Error('not yet');
                return { id: { toString: () => PEER_ID }, addresses: [] };
            }),
        });

        await client.waitUntilReady({
            url: 'http://ipfs.test:5001',
            intervalSeconds: 0,
            becomeChattyAfter: 1,
        });

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Connecting to IPFS at'));
    });
});

describe('KuboClient content', () => {
    it('adds text and data as CIDv1', async () => {
        const { client, rpc } = await connected();

        await expect(client.addText('hello')).resolves.toBe('bafy-added');
        expect(rpc.add).toHaveBeenCalledWith('hello', { cidVersion: 1 });

        const buffer = Buffer.from('bytes');
        await expect(client.addData(buffer)).resolves.toBe('bafy-added');
        expect(rpc.add).toHaveBeenLastCalledWith(buffer, { cidVersion: 1 });
    });

    it('reassembles chunked reads', async () => {
        const { client, rpc } = await connected({
            cat: jest.fn<any>(() => (async function* () {
                yield Buffer.from('hel');
                yield Buffer.from('lo');
            })()),
        });

        await expect(client.getText('bafy-x')).resolves.toBe('hello');
        expect(rpc.cat).toHaveBeenCalledWith('bafy-x', { timeout: 10000 });
    });

    it('returns binary reads as a Buffer', async () => {
        const { client } = await connected({
            cat: jest.fn<any>(() => (async function* () { yield Buffer.from([1, 2, 3]); })()),
        });

        const data = await client.getData('bafy-x');
        expect(Buffer.isBuffer(data)).toBe(true);
        expect([...data]).toEqual([1, 2, 3]);
    });

    it('adds a stream and hands the raw iterable back for reads', async () => {
        const { client, rpc } = await connected();
        const stream = (async function* () { yield new Uint8Array([1]); })();

        await expect(client.addDataStream(stream)).resolves.toBe('bafy-added');
        expect(rpc.add).toHaveBeenCalledWith(stream, { cidVersion: 1 });

        // getDataStream passes the iterable through without buffering it.
        client.getDataStream('bafy-x');
        expect(rpc.cat).toHaveBeenCalledWith('bafy-x');
    });
});

describe('KuboClient JSON blocks', () => {
    it('derives the CID locally and stores the encoded block under it', async () => {
        const { client, rpc } = await connected();

        const cid = await client.addJSON({ hello: 'world' });

        // CIDv1 with the json codec, base32-encoded.
        expect(cid).toMatch(/^bagaaie/);
        const [buf, options] = rpc.block.put.mock.calls[0];
        expect(jsonCodec.decode(buf)).toEqual({ hello: 'world' });
        expect(options.cid.toString()).toBe(cid);
    });

    it('is deterministic for equal payloads', async () => {
        const { client } = await connected();

        const first = await client.addJSON({ a: 1, b: 2 });
        const second = await client.addJSON({ a: 1, b: 2 });
        const different = await client.addJSON({ a: 1, b: 3 });

        expect(first).toBe(second);
        expect(first).not.toBe(different);
    });

    it('decodes a block back into JSON', async () => {
        const { client, rpc } = await connected();

        await expect(client.getJSON('bafy-x')).resolves.toEqual({ hello: 'world' });
        expect(rpc.block.get).toHaveBeenCalledWith('bafy-x', { timeout: 10000 });
    });
});

describe('KuboClient identity and addresses', () => {
    it('exposes the raw id and the peer id', async () => {
        const { client } = await connected();

        await expect(client.getID()).resolves.toMatchObject({ addresses: [] });
        await expect(client.getPeerID()).resolves.toBe(PEER_ID);
    });

    it('filters private addresses out of the advertised set', async () => {
        const addresses = [
            '/ip4/127.0.0.1/tcp/4001',
            '/ip4/192.168.1.10/tcp/4001',
            '/ip4/10.0.0.5/tcp/4001',
            '/ip4/1.2.3.4/tcp/4001',
            '/ip6/::1/tcp/4001',
            '/ip6/2606:4700:4700::1111/tcp/4001',
            '/dns4/example.test/tcp/4001',
        ].map(a => ({ toString: () => a }));
        const { client } = await connected({
            id: jest.fn<any>().mockResolvedValue({ id: { toString: () => PEER_ID }, addresses }),
        });

        const advertised = (await client.getAddresses()).map(a => a.toString());

        expect(advertised).toEqual([
            '/ip4/1.2.3.4/tcp/4001',
            '/ip6/2606:4700:4700::1111/tcp/4001',
        ]);
        // A non-ip multiaddr matches no ip pattern and is skipped entirely.
        expect(advertised).not.toContain('/dns4/example.test/tcp/4001');
    });
});

describe('KuboClient peers', () => {
    const publicPeer = '/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWOther';

    it('connects to a public peer reported as successful', async () => {
        const { client, rpc } = await connected();

        await expect(client.addPeer(publicPeer)).resolves.toBe(true);
        expect(rpc.swarm.connect).toHaveBeenCalledWith(publicPeer);
    });

    it('refuses a malformed address or a private one, without dialling', async () => {
        const { client, rpc } = await connected();

        await expect(client.addPeer('not-a-multiaddr')).resolves.toBe(false);
        await expect(client.addPeer('/ip4/192.168.1.10/tcp/4001')).resolves.toBe(false);
        expect(rpc.swarm.connect).not.toHaveBeenCalled();
    });

    it('treats an unrecognized swarm response as failure', async () => {
        const noSuccess = await connected({
            swarm: { connect: jest.fn<any>().mockResolvedValue(['something else']), peers: jest.fn<any>() },
        });
        await expect(noSuccess.client.addPeer(publicPeer)).resolves.toBe(false);

        const notAList = await connected({
            swarm: { connect: jest.fn<any>().mockResolvedValue({ ok: true }), peers: jest.fn<any>() },
        });
        await expect(notAList.client.addPeer(publicPeer)).resolves.toBe(false);
    });

    it('reports a dial failure as false rather than throwing', async () => {
        const { client } = await connected({
            swarm: { connect: jest.fn<any>().mockRejectedValue(new Error('unreachable')), peers: jest.fn<any>() },
        });

        await expect(client.addPeer(publicPeer)).resolves.toBe(false);
        expect(errorSpy).toHaveBeenCalled();
    });

    it('returns only the peers that were actually added', async () => {
        const { client } = await connected();

        const added = await client.addPeers([
            publicPeer,
            '/ip4/10.0.0.1/tcp/4001',
            'garbage',
        ]);

        expect(added).toEqual([publicPeer]);
    });

    it('lists swarm peers', async () => {
        const { client } = await connected();

        await expect(client.getPeers()).resolves.toEqual([{ peer: PEER_ID }]);
    });
});

describe('KuboClient peering configuration', () => {
    const other = '12D3KooWOtherPeer';

    it('reads the peering list, defaulting to empty', async () => {
        const { client } = await connected({
            config: { get: jest.fn<any>().mockResolvedValue(null), set: jest.fn<any>() },
        });

        await expect(client.getPeeringPeers()).resolves.toEqual([]);
    });

    it('refuses to add itself as a peering peer', async () => {
        const { client, rpc } = await connected();

        await client.addPeeringPeer(PEER_ID, ['/ip4/1.2.3.4/tcp/4001']);

        expect(rpc.config.set).not.toHaveBeenCalled();
    });

    it('keeps only addresses it can actually dial', async () => {
        const { client, rpc } = await connected({
            swarm: {
                connect: jest.fn<any>(async (addr: string) => {
                    if (addr.includes('bad')) throw new Error('unreachable');
                    return ['connect success'];
                }),
                peers: jest.fn<any>(),
            },
        });

        await client.addPeeringPeer(other, ['/ip4/1.2.3.4/tcp/bad', '/ip4/5.6.7.8/tcp/4001']);

        const [key, value, options] = rpc.config.set.mock.calls[0];
        expect(key).toBe('Peering.Peers');
        expect(options).toEqual({ json: true });
        expect(value).toEqual([{ ID: other, Addrs: ['/ip4/5.6.7.8/tcp/4001'] }]);
    });

    it('writes nothing when no address is dialable', async () => {
        const { client, rpc } = await connected({
            swarm: {
                connect: jest.fn<any>().mockRejectedValue(new Error('unreachable')),
                peers: jest.fn<any>(),
            },
        });

        await client.addPeeringPeer(other, ['/ip4/1.2.3.4/tcp/4001']);

        expect(rpc.config.set).not.toHaveBeenCalled();
    });

    it('merges addresses into an existing entry without duplicating', async () => {
        const existing = [{ ID: other, Addrs: ['/ip4/1.1.1.1/tcp/4001'] }];
        const { client, rpc } = await connected({
            config: {
                get: jest.fn<any>().mockResolvedValue(existing),
                set: jest.fn<any>().mockResolvedValue(undefined),
            },
        });

        await client.addPeeringPeer(other, ['/ip4/1.1.1.1/tcp/4001', '/ip4/2.2.2.2/tcp/4001']);

        const [, value] = rpc.config.set.mock.calls[0];
        expect(value).toEqual([
            { ID: other, Addrs: ['/ip4/1.1.1.1/tcp/4001', '/ip4/2.2.2.2/tcp/4001'] },
        ]);
    });

    it('removes a peering peer and leaves the rest', async () => {
        const { client, rpc } = await connected({
            config: {
                get: jest.fn<any>().mockResolvedValue([
                    { ID: other, Addrs: ['/ip4/1.1.1.1/tcp/4001'] },
                    { ID: 'keep-me', Addrs: ['/ip4/2.2.2.2/tcp/4001'] },
                ]),
                set: jest.fn<any>().mockResolvedValue(undefined),
            },
        });

        await client.removePeeringPeer(other);

        const [, value] = rpc.config.set.mock.calls[0];
        expect(value).toEqual([{ ID: 'keep-me', Addrs: ['/ip4/2.2.2.2/tcp/4001'] }]);
    });

    it('resets the peering list to empty', async () => {
        const { client, rpc } = await connected();

        await client.resetPeeringPeers();

        expect(rpc.config.set).toHaveBeenCalledWith('Peering.Peers', [], { json: true });
    });
});
