function positiveInt(name: string, value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer, not "${value}"`);
    }
    return parsed;
}

function nonNegativeInt(name: string, value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${name} must be a whole number, not "${value}"`);
    }
    return parsed;
}

const env = process.env;

const config = {
    gatekeeperURL: env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    port: positiveInt('ARCHON_MEMEPOOL_PORT', env.ARCHON_MEMEPOOL_PORT, 4237),
    bindAddress: env.ARCHON_BIND_ADDRESS || '0.0.0.0',
    // The name of the service's identity in its wallet, and the name it gives
    // itself in a grant request.
    name: env.ARCHON_MEMEPOOL_NAME || 'memepool',
    // The address users reach the service at, such as `https://node/memepool`.
    // With it, a challenge names the service's callback and a wallet sends its
    // answer there.
    publicURL: env.ARCHON_MEMEPOOL_PUBLIC_URL || '',
    // The node's Memeplex indexer, which says what a publication is for the
    // page at its address. Empty, such a page says nothing of itself.
    // Under Compose it is the indexer's container where the node runs one,
    // which ARCHON_COMPOSE_PROFILES says, as Drawbridge finds it.
    indexerURL: env.ARCHON_MEMEPLEX_INDEXER_URL
        || ((env.ARCHON_COMPOSE_PROFILES ?? '').split(',').map(profile => profile.trim()).includes('memeplex') ? 'http://memeplex-indexer:4233' : ''),
    // The built pages, served beside the API. Empty serves none.
    pagesDir: env.ARCHON_MEMEPOOL_PAGES_DIR ?? 'public',
    // Where the wallet that holds the service's key is kept.
    dataDir: env.ARCHON_MEMEPOOL_DATA_DIR || 'data',
    // The passphrase that encrypts that wallet. Required.
    passphrase: env.ARCHON_MEMEPOOL_WALLET_PASSPHRASE || '',
    // The registry the service's own identity is created on. Not `local`.
    registry: env.ARCHON_MEMEPOOL_REGISTRY || 'hyperswarm',
    challengesPerMinute: positiveInt('ARCHON_MEMEPOOL_CHALLENGES_PER_MINUTE', env.ARCHON_MEMEPOOL_CHALLENGES_PER_MINUTE, 60),
    // Hours a session lasts.
    sessionHours: positiveInt('ARCHON_MEMEPOOL_SESSION_HOURS', env.ARCHON_MEMEPOOL_SESSION_HOURS, 24),
    // How many proxies stand between the service and its users. With one or
    // more, the service takes a request as secure when the last of them says
    // it arrived over HTTPS, and marks its cookies for HTTPS only.
    trustedProxies: nonNegativeInt('ARCHON_MEMEPOOL_TRUSTED_PROXIES', env.ARCHON_MEMEPOOL_TRUSTED_PROXIES, 0),
    // Seconds a request to the Gatekeeper may take.
    gatekeeperTimeout: positiveInt('ARCHON_MEMEPOOL_GATEKEEPER_TIMEOUT', env.ARCHON_MEMEPOOL_GATEKEEPER_TIMEOUT, 120),
};

export default config;
