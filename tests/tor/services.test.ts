import { execFileSync } from 'child_process';

// docker/tor/services.sh decides which onion services the Tor container
// serves and writes its torrc. It runs under busybox sh in the image; these
// run it under the host's POSIX sh with the resolver stubbed, so the parsing
// and torrc generation are checked without starting Tor.

const ADDRESSES: Record<string, string> = {
    drawbridge: '172.18.0.5',
    'cln-mainnet-node': '172.18.0.9',
};

function run(script: string, env: Record<string, string> = {}): string {
    const resolver = Object.entries(ADDRESSES)
        .map(([host, address]) => `${host}) echo ${address} ;;`)
        .join(' ');
    return execFileSync('sh', ['-c', `
        set -eu
        . docker/tor/services.sh
        resolve() { case "$1" in ${resolver} *) return 0 ;; esac; }
        ${script}
    `], {
        encoding: 'utf-8',
        env: { PATH: process.env.PATH, HS_ROOT: '/hs', DATA_DIR: '/data', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

const services = (env: Record<string, string> = {}) => run('tor_services', env);
const torrc = (env: Record<string, string> = {}) => run('tor_services | resolve_services | write_torrc', env);

describe('tor_services', () => {
    it('serves Drawbridge alone by default', () => {
        expect(services()).toBe('drawbridge drawbridge 4222\n');
    });

    it('accepts the port range limits', () => {
        expect(services({ TOR_SERVICES: 'a:drawbridge:1 b:drawbridge:65535' }))
            .toBe('a drawbridge 1\nb drawbridge 65535\n');
    });

    it('serves every listed entry', () => {
        expect(services({ TOR_SERVICES: 'drawbridge:drawbridge:4222 cln:cln-mainnet-node:9736:tor' }))
            .toBe('drawbridge drawbridge 4222\ncln cln-mainnet-node 9736\n');
    });

    it('serves hybrid entries and leaves out clearnet ones', () => {
        expect(services({ TOR_SERVICES: 'drawbridge:drawbridge:4222 cln:cln-mainnet-node:9736:clearnet' }))
            .toBe('drawbridge drawbridge 4222\n');
        expect(services({ TOR_SERVICES: 'cln:cln-mainnet-node:9736:hybrid' }))
            .toBe('cln cln-mainnet-node 9736\n');
    });

    it('stops serving an entry switched from tor to clearnet', () => {
        const list = (mode: string) => `drawbridge:drawbridge:4222 cln:cln-mainnet-node:9736:${mode}`;

        expect(services({ TOR_SERVICES: list('tor') })).toContain('cln ');
        expect(services({ TOR_SERVICES: list('clearnet') })).not.toContain('cln ');
    });

    it('lets TOR_SERVICE_HOST and TOR_SERVICE_PORT override the drawbridge entry only', () => {
        expect(services({
            TOR_SERVICES: 'drawbridge:drawbridge:4222 cln:cln-mainnet-node:9736',
            TOR_SERVICE_HOST: 'gateway',
            TOR_SERVICE_PORT: '8080',
        })).toBe('drawbridge gateway 8080\ncln cln-mainnet-node 9736\n');
    });

    it.each([
        ['a name with invalid characters', 'Draw_bridge:drawbridge:4222'],
        ['a missing host', 'drawbridge::4222'],
        ['a non-numeric port', 'drawbridge:drawbridge:http'],
        ['port 0', 'drawbridge:drawbridge:0'],
        ['port 65536', 'drawbridge:drawbridge:65536'],
        ['an over-long port', 'drawbridge:drawbridge:000004222'],
        ['a repeated name', 'cln:cln-mainnet-node:9736 cln:cln-mainnet-node:9737'],
        ['a repeated name in clearnet mode', 'cln:cln-mainnet-node:9736 cln:cln-mainnet-node:9737:clearnet'],
        ['an unknown mode', 'cln:cln-mainnet-node:9736:onion'],
    ])('rejects %s', (_case, entry) => {
        expect(() => services({ TOR_SERVICES: entry })).toThrow();
    });
});

describe('write_torrc', () => {
    it('serves Drawbridge at its existing hidden-service directory', () => {
        expect(torrc()).toBe([
            'DataDirectory /data',
            'SocksPort 0.0.0.0:9050',
            'HiddenServiceDir /hs/drawbridge',
            'HiddenServicePort 4222 172.18.0.5:4222',
            '',
        ].join('\n'));
    });

    it('adds a service per resolved target, each with its own directory', () => {
        expect(torrc({ TOR_SERVICES: 'drawbridge:drawbridge:4222 cln:cln-mainnet-node:9736' })).toBe([
            'DataDirectory /data',
            'SocksPort 0.0.0.0:9050',
            'HiddenServiceDir /hs/drawbridge',
            'HiddenServicePort 4222 172.18.0.5:4222',
            'HiddenServiceDir /hs/cln',
            'HiddenServicePort 9736 172.18.0.9:9736',
            '',
        ].join('\n'));
    });

    it('leaves out a target that does not resolve yet', () => {
        expect(torrc({ TOR_SERVICES: 'drawbridge:drawbridge:4222 cln:absent:9736' })).toBe([
            'DataDirectory /data',
            'SocksPort 0.0.0.0:9050',
            'HiddenServiceDir /hs/drawbridge',
            'HiddenServicePort 4222 172.18.0.5:4222',
            '',
        ].join('\n'));
    });

    it('keeps the SOCKS proxy when no target resolves', () => {
        expect(torrc({ TOR_SERVICES: 'drawbridge:absent:4222' }))
            .toBe('DataDirectory /data\nSocksPort 0.0.0.0:9050\n');
    });
});
