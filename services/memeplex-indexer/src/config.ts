import dotenv from 'dotenv';

dotenv.config();

function positiveInt(name: string, value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer, not "${value}"`);
    }
    return parsed;
}

const env = process.env;

const config = {
    gatekeeperURL: env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    port: positiveInt('ARCHON_MEMEPLEX_INDEXER_PORT', env.ARCHON_MEMEPLEX_INDEXER_PORT, 4238),
    bindAddress: env.ARCHON_BIND_ADDRESS || '0.0.0.0',
    // Seconds between polls of the Gatekeeper's changes.
    pollInterval: positiveInt('ARCHON_MEMEPLEX_INDEXER_POLL_INTERVAL', env.ARCHON_MEMEPLEX_INDEXER_POLL_INTERVAL, 5),
    // Seconds a request to the Gatekeeper may take. One that never answers
    // would otherwise hold its pass, and every pass after it, for good.
    gatekeeperTimeout: positiveInt('ARCHON_MEMEPLEX_INDEXER_GATEKEEPER_TIMEOUT', env.ARCHON_MEMEPLEX_INDEXER_GATEKEEPER_TIMEOUT, 120),
};

export default config;
