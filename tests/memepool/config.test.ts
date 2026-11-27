import { jest } from '@jest/globals';

// What the Memepool service and the Memeplex indexer read from their
// environment. Each module reads it once, when it is loaded, so each case
// loads it anew.

// The indexer loads a .env file from the working directory. A developer's own
// would otherwise decide what these cases see.
jest.unstable_mockModule('dotenv', () => ({ default: { config: () => ({}) } }));

const saved = { ...process.env };

async function loaded(path: string, env: Record<string, string>) {
    for (const name of Object.keys(process.env)) {
        if (name.startsWith('ARCHON_')) {
            delete process.env[name];
        }
    }
    Object.assign(process.env, env);
    jest.resetModules();

    return (await import(path)).default;
}

afterEach(() => {
    for (const name of Object.keys(process.env)) {
        if (!(name in saved)) {
            delete process.env[name];
        }
    }
    Object.assign(process.env, saved);
});

describe('the Memepool service\'s settings', () => {
    const memepool = (env: Record<string, string> = {}) => loaded('../../services/memepool/src/config.ts', env);

    it('has a default for everything but the passphrase', async () => {
        expect(await memepool()).toStrictEqual({
            gatekeeperURL: 'http://localhost:4224',
            port: 4237,
            bindAddress: '0.0.0.0',
            name: 'memepool',
            publicURL: '',
            indexerURL: '',
            pagesDir: 'public',
            dataDir: 'data',
            passphrase: '',
            registry: 'hyperswarm',
            challengesPerMinute: 60,
            sessionHours: 24,
            trustedProxies: 0,
            gatekeeperTimeout: 120,
        });
    });

    it('takes each setting from its variable', async () => {
        expect(await memepool({
            ARCHON_GATEKEEPER_URL: 'http://gatekeeper:4224',
            ARCHON_MEMEPOOL_PORT: '8080',
            ARCHON_BIND_ADDRESS: '127.0.0.1',
            ARCHON_MEMEPOOL_NAME: 'publisher',
            ARCHON_MEMEPOOL_PUBLIC_URL: 'https://node.example/memepool',
            ARCHON_MEMEPLEX_INDEXER_URL: 'http://indexer:4233',
            ARCHON_MEMEPOOL_PAGES_DIR: '',
            ARCHON_MEMEPOOL_DATA_DIR: '/var/memepool',
            ARCHON_MEMEPOOL_WALLET_PASSPHRASE: 'a passphrase',
            ARCHON_MEMEPOOL_REGISTRY: 'BTC:mainnet',
            ARCHON_MEMEPOOL_CHALLENGES_PER_MINUTE: '5',
            ARCHON_MEMEPOOL_SESSION_HOURS: '1',
            ARCHON_MEMEPOOL_TRUSTED_PROXIES: '2',
            ARCHON_MEMEPOOL_GATEKEEPER_TIMEOUT: '30',
        })).toStrictEqual({
            gatekeeperURL: 'http://gatekeeper:4224',
            port: 8080,
            bindAddress: '127.0.0.1',
            name: 'publisher',
            publicURL: 'https://node.example/memepool',
            indexerURL: 'http://indexer:4233',
            // Set and empty: the service serves no pages.
            pagesDir: '',
            dataDir: '/var/memepool',
            passphrase: 'a passphrase',
            registry: 'BTC:mainnet',
            challengesPerMinute: 5,
            sessionHours: 1,
            trustedProxies: 2,
            gatekeeperTimeout: 30,
        });
    });

    it('finds the node\'s indexer from its profiles, and none on a node that runs none', async () => {
        expect((await memepool({ ARCHON_COMPOSE_PROFILES: 'react-wallet, memeplex ,memepool' })).indexerURL).toBe('http://memeplex-indexer:4233');
        expect((await memepool({ ARCHON_COMPOSE_PROFILES: 'react-wallet,memepool' })).indexerURL).toBe('');
        // A profile whose name only contains the word is another profile.
        expect((await memepool({ ARCHON_COMPOSE_PROFILES: 'memeplex-test' })).indexerURL).toBe('');
        // An address that is given is the one used.
        expect((await memepool({ ARCHON_COMPOSE_PROFILES: 'memeplex', ARCHON_MEMEPLEX_INDEXER_URL: 'http://elsewhere:9' })).indexerURL).toBe('http://elsewhere:9');
    });

    it.each([
        ['ARCHON_MEMEPOOL_PORT', '0', /ARCHON_MEMEPOOL_PORT must be a positive integer, not "0"/],
        ['ARCHON_MEMEPOOL_PORT', '80.5', /must be a positive integer/],
        ['ARCHON_MEMEPOOL_SESSION_HOURS', 'a day', /ARCHON_MEMEPOOL_SESSION_HOURS must be a positive integer, not "a day"/],
        ['ARCHON_MEMEPOOL_CHALLENGES_PER_MINUTE', '-1', /must be a positive integer/],
        ['ARCHON_MEMEPOOL_GATEKEEPER_TIMEOUT', '0', /must be a positive integer/],
        ['ARCHON_MEMEPOOL_TRUSTED_PROXIES', '-1', /ARCHON_MEMEPOOL_TRUSTED_PROXIES must be a whole number, not "-1"/],
        ['ARCHON_MEMEPOOL_TRUSTED_PROXIES', '1.5', /must be a whole number/],
    ])('does not load with %s set to %s', async (name, value, message) => {
        await expect(memepool({ [name]: value })).rejects.toThrow(message);
    });

    it('trusts no proxy when told so with a zero', async () => {
        expect((await memepool({ ARCHON_MEMEPOOL_TRUSTED_PROXIES: '0' })).trustedProxies).toBe(0);
    });
});

describe('the Memeplex indexer\'s settings', () => {
    const indexer = (env: Record<string, string> = {}) => loaded('../../services/memeplex-indexer/src/config.ts', env);

    it('has a default for each', async () => {
        expect(await indexer()).toStrictEqual({
            gatekeeperURL: 'http://localhost:4224', port: 4233, bindAddress: '0.0.0.0', pollInterval: 5, gatekeeperTimeout: 120,
        });
    });

    it('takes each setting from its variable', async () => {
        expect(await indexer({
            ARCHON_GATEKEEPER_URL: 'http://gatekeeper:4224',
            ARCHON_MEMEPLEX_INDEXER_PORT: '9000',
            ARCHON_BIND_ADDRESS: '127.0.0.1',
            ARCHON_MEMEPLEX_INDEXER_POLL_INTERVAL: '1',
            ARCHON_MEMEPLEX_INDEXER_GATEKEEPER_TIMEOUT: '10',
        })).toStrictEqual({
            gatekeeperURL: 'http://gatekeeper:4224', port: 9000, bindAddress: '127.0.0.1', pollInterval: 1, gatekeeperTimeout: 10,
        });
    });

    it.each([
        ['ARCHON_MEMEPLEX_INDEXER_PORT', 'http'],
        ['ARCHON_MEMEPLEX_INDEXER_POLL_INTERVAL', '0'],
        ['ARCHON_MEMEPLEX_INDEXER_GATEKEEPER_TIMEOUT', '-5'],
    ])('does not load with %s set to %s', async (name, value) => {
        await expect(indexer({ [name]: value })).rejects.toThrow(`${name} must be a positive integer, not "${value}"`);
    });
});
