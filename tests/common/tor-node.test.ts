import { jest } from '@jest/globals';

const destroy = jest.fn();
const createConnection = jest.fn<any>().mockResolvedValue({ socket: { destroy } });
jest.unstable_mockModule('socks', () => ({ SocksClient: { createConnection } }));
const { probeOnion } = await import('../../packages/common/src/tor-node.ts');

const onion = `${'a'.repeat(56)}.onion`;

beforeEach(() => { createConnection.mockClear(); destroy.mockClear(); });

it('opens and closes a bounded SOCKS connection to the advertised hidden service', async () => {
    await probeOnion(onion, 4222, 'tor:9050');
    expect(createConnection).toHaveBeenCalledWith({
        command: 'connect',
        proxy: { type: 5, host: 'tor', port: 9050 },
        destination: { host: onion, port: 4222 },
        timeout: 5000,
    });
    expect(destroy).toHaveBeenCalledTimes(1);
});

it('rejects malformed hostnames and missing proxies before connecting', async () => {
    await expect(probeOnion('example.org', 4222, 'tor:9050')).rejects.toThrow('invalid Tor v3 hostname');
    await expect(probeOnion(onion, 4222, '')).rejects.toThrow('not configured');
    expect(createConnection).not.toHaveBeenCalled();
});
