import config from '../../services/didcomm/server/src/config.js';

describe('didcomm service config', () => {
    it('provides defaults for every setting', () => {
        expect(config).toMatchObject({
            gatekeeperURL: expect.any(String),
            didcommPort: expect.any(Number),
            bindAddress: expect.any(String),
            uploadLimit: expect.any(String),
            messageTtlMs: expect.any(Number),
            db: expect.any(String),
            maxRecipientBytes: expect.any(Number),
            maxTotalBytes: expect.any(Number),
            maxChallenges: expect.any(Number),
            redisURL: expect.any(String),
            torProxy: expect.any(String),
            allowPrivateEgress: expect.any(Boolean),
        });
    });

    it('defaults egress to Tor-less and private destinations disallowed', () => {
        // These two gate outbound delivery, so their defaults are the safe ones:
        // no proxy configured, and private/loopback destinations refused unless
        // explicitly opted into for dev.
        expect(config.torProxy).toBe(process.env.ARCHON_DIDCOMM_TOR_PROXY || '');
        expect(config.allowPrivateEgress).toBe(
            process.env.ARCHON_DIDCOMM_ALLOW_PRIVATE_EGRESS === 'true',
        );
    });

    it('defaults the message TTL to seven days', () => {
        if (!process.env.ARCHON_DIDCOMM_MESSAGE_TTL_MS) {
            expect(config.messageTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
        }
    });
});

describe('didcomm config validation', () => {
    // parseInt('invalid') is NaN, and every comparison against NaN is false, so
    // a typo in a cap would have switched the bound off while still looking
    // configured. Startup must fail instead.
    const numeric = [
        'ARCHON_DIDCOMM_PORT',
        'ARCHON_DIDCOMM_MESSAGE_TTL_MS',
        'ARCHON_DIDCOMM_MAX_RECIPIENT_BYTES',
        'ARCHON_DIDCOMM_MAX_TOTAL_BYTES',
        'ARCHON_DIDCOMM_MAX_CHALLENGES',
    ];

    async function loadWith(name: string, value: string) {
        const previous = process.env[name];
        process.env[name] = value;
        try {
            // Bust the module cache so the config module re-evaluates.
            await import(`../../services/didcomm/server/src/config.js?bad=${name}${encodeURIComponent(value)}`);
            return null;
        }
        catch (error: any) {
            return error.message as string;
        }
        finally {
            if (previous === undefined) {
                delete process.env[name];
            }
            else {
                process.env[name] = previous;
            }
        }
    }

    it.each(numeric)('rejects a non-numeric %s at startup', async (name) => {
        expect(await loadWith(name, 'invalid')).toContain(name);
    });

    it.each(numeric)('rejects a zero or negative %s at startup', async (name) => {
        expect(await loadWith(name, '0')).toContain(name);
        expect(await loadWith(name, '-1')).toContain(name);
    });
});
