import dotenv from 'dotenv';

dotenv.config();

// parseInt yields NaN for a malformed value. NaN reaches the limiter's Lua as a
// nil, the comparison there throws, and the middleware's fail-open path then
// lets everything through -- a security setting switched off by a typo while
// still looking configured. A zero or negative window is just as bad: the
// window key expires immediately, so nothing is ever counted.
function positiveInt(name: string, value: string | undefined, fallback: number): number {
    if (value === undefined || value === '') {
        return fallback;
    }

    const parsed = Number(value);

    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer, got "${value}"`);
    }

    return parsed;
}

const config = {
    port: process.env.ARCHON_DRAWBRIDGE_PORT ? parseInt(process.env.ARCHON_DRAWBRIDGE_PORT) : 4222,
    bindAddress: process.env.ARCHON_BIND_ADDRESS || '0.0.0.0',
    gatekeeperURL: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    // `??` (not `||`) so an explicitly-empty value disables the optional service
    // (the capability off-switch), while an unset var falls back to the default.
    heraldURL: process.env.ARCHON_HERALD_URL ?? 'http://localhost:4230',
    lightningMediatorURL: process.env.ARCHON_LIGHTNING_MEDIATOR_URL ?? 'http://localhost:4235',
    didcommURL: process.env.ARCHON_DIDCOMM_URL ?? 'http://localhost:4236',
    // Public base URL this node is reachable at (clearnet host or Tor onion).
    // Used to advertise the DIDComm relay endpoint (`<publicHost>/didcomm`).
    publicHost: process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST || '',
    // When publicHost is unset, the DIDComm endpoint falls back to the Tor onion
    // fronting this Drawbridge, read from this shared hidden-service hostname file.
    torHostnameFile: process.env.ARCHON_DRAWBRIDGE_TOR_HOSTNAME_FILE || '/data/tor/hostname',
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY || '',

    // L402
    l402Enabled: process.env.ARCHON_DRAWBRIDGE_L402_ENABLED === 'true',
    // Subscription-auth stub (#121) bypasses L402 payment verification for any
    // request carrying X-Subscription-DID. Keep disabled until #121 implements
    // real credential verification.
    subscriptionsEnabled: process.env.ARCHON_DRAWBRIDGE_SUBSCRIPTIONS_ENABLED === 'true',
    macaroonSecret: process.env.ARCHON_DRAWBRIDGE_MACAROON_SECRET || '',
    defaultPriceSats: process.env.ARCHON_DRAWBRIDGE_DEFAULT_PRICE_SATS ? parseInt(process.env.ARCHON_DRAWBRIDGE_DEFAULT_PRICE_SATS) : 10,
    invoiceExpiry: process.env.ARCHON_DRAWBRIDGE_INVOICE_EXPIRY ? parseInt(process.env.ARCHON_DRAWBRIDGE_INVOICE_EXPIRY) : 3600,

    // Rate limiting
    rateLimitMax: positiveInt('ARCHON_DRAWBRIDGE_RATE_LIMIT_MAX', process.env.ARCHON_DRAWBRIDGE_RATE_LIMIT_MAX, 100),
    // Public DIDComm passthrough, limited separately from the paid path because
    // the traffic is unauthenticated. Reads (challenge/fetch/remove) are chatty
    // and cheap -- one poll is four requests -- so their ceiling is a request
    // count generous enough for an active wallet. Deposits are budgeted in
    // BYTES instead: a request ceiling loose enough for normal traffic still
    // allows a couple of dozen max-size envelopes, which is all it takes to
    // fill the relay's storage cap.
    didcommReadPerSource: positiveInt('ARCHON_DRAWBRIDGE_DIDCOMM_READ_PER_SOURCE',
        process.env.ARCHON_DRAWBRIDGE_DIDCOMM_READ_PER_SOURCE, 300),
    didcommReadGlobal: positiveInt('ARCHON_DRAWBRIDGE_DIDCOMM_READ_GLOBAL',
        process.env.ARCHON_DRAWBRIDGE_DIDCOMM_READ_GLOBAL, 3000),
    didcommDepositPerSourceBytes: positiveInt('ARCHON_DRAWBRIDGE_DIDCOMM_DEPOSIT_PER_SOURCE_BYTES',
        process.env.ARCHON_DRAWBRIDGE_DIDCOMM_DEPOSIT_PER_SOURCE_BYTES, 16 * 1024 * 1024),
    didcommDepositGlobalBytes: positiveInt('ARCHON_DRAWBRIDGE_DIDCOMM_DEPOSIT_GLOBAL_BYTES',
        process.env.ARCHON_DRAWBRIDGE_DIDCOMM_DEPOSIT_GLOBAL_BYTES, 64 * 1024 * 1024),
    didcommRateLimitWindow: positiveInt('ARCHON_DRAWBRIDGE_DIDCOMM_RATE_LIMIT_WINDOW',
        process.env.ARCHON_DRAWBRIDGE_DIDCOMM_RATE_LIMIT_WINDOW, 60),
    rateLimitWindow: positiveInt('ARCHON_DRAWBRIDGE_RATE_LIMIT_WINDOW', process.env.ARCHON_DRAWBRIDGE_RATE_LIMIT_WINDOW, 60),

    // Redis
    redisUrl: process.env.ARCHON_REDIS_URL || 'redis://localhost:6379',
};

export default config;
