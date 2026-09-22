import { jest } from '@jest/globals';
import { createServer } from 'node:net';
import type { LookupAddress } from 'node:dns';

const lookup = jest.fn<any>();
jest.unstable_mockModule('node:dns', () => ({ lookup }));
const { publicLookup, fetchPublicHttps, fetchPublicHttpsOnce } = await import('../../packages/common/src/net-node.ts');
const realFetch = global.fetch;

afterEach(() => { global.fetch = realFetch; lookup.mockReset(); });

function resolve(answers: LookupAddress[], all = true, family?: number) {
    lookup.mockImplementation((_host: string, _options: unknown, cb: any) => cb(null, answers));
    return new Promise((done, reject) => publicLookup('names.example', { all, family } as any,
        (error, address, resultFamily) => error ? reject(error) : done({ address, family: resultFamily })));
}

it.each(['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1', 'fc00::1', '::ffff:127.0.0.1'])(
    'rejects private DNS answer %s, including mixed results', async address => {
        await expect(resolve([{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }]))
            .rejects.toThrow('private address');
    },
);

it('returns only the validated answers to the socket, without resolving again', async () => {
    const answers = [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
    await expect(resolve(answers)).resolves.toEqual({ address: answers, family: 0 });
    expect(lookup).toHaveBeenCalledTimes(1);
    await expect(resolve(answers, false, 6)).resolves.toEqual({ address: answers[1].address, family: 6 });
});

it('rejects empty DNS results and propagates DNS errors', async () => {
    await expect(resolve([])).rejects.toThrow('private address');
    lookup.mockImplementation((_host: string, _options: unknown, cb: any) => cb(new Error('DNS unavailable')));
    await expect(new Promise((done, reject) => publicLookup('names.example', {},
        (error, address) => error ? reject(error) : done(address)))).rejects.toThrow('DNS unavailable');
});

it('blocks a real fetch before it connects to a private DNS destination', async () => {
    const connected = jest.fn();
    const server = createServer(socket => { connected(); socket.destroy(); });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    try {
        const port = (server.address() as { port: number }).port;
        lookup.mockImplementation((_host: string, _options: unknown, cb: any) => cb(null, [{ address: '127.0.0.1', family: 4 }]));
        await expect(fetchPublicHttps(`https://names.invalid:${port}/`, { signal: AbortSignal.timeout(2000) }))
            .rejects.toMatchObject({ cause: { message: expect.stringContaining('private address') } });
        expect(lookup).toHaveBeenCalled();
        expect(connected).not.toHaveBeenCalled();
    } finally {
        await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    }
});

it('keeps the hostname URL and applies the protected dispatcher on every redirect hop', async () => {
    const mocked = jest.fn<any>()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://other.example/result' } }))
        .mockResolvedValueOnce(new Response('{}'));
    global.fetch = mocked;
    await fetchPublicHttps('https://names.example/start');
    expect(mocked.mock.calls.map(call => call[0])).toEqual(['https://names.example/start', 'https://other.example/result']);
    for (const [, options] of mocked.mock.calls) {
        expect(options).toMatchObject({ redirect: 'manual', dispatcher: expect.anything() });
    }
});

it('rejects literals before fetch, since socket lookups skip IP literals', async () => {
    global.fetch = jest.fn<any>();
    await expect(fetchPublicHttpsOnce('https://[::ffff:127.0.0.1]/')).rejects.toThrow('non-public');
    expect(global.fetch).not.toHaveBeenCalled();
});

it('rejects a rebound answer on a later connection lookup', async () => {
    lookup.mockImplementationOnce((_host: string, _options: unknown, cb: any) => cb(null, [{ address: '8.8.8.8', family: 4 }]))
        .mockImplementationOnce((_host: string, _options: unknown, cb: any) => cb(null, [{ address: '169.254.169.254', family: 4 }]));
    const connectLookup = () => new Promise((done, reject) => publicLookup('same.example', {},
        (error, address) => error ? reject(error) : done(address)));
    await expect(connectLookup()).resolves.toBe('8.8.8.8');
    await expect(connectLookup()).rejects.toThrow('private address');
});
