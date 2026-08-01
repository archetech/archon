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
