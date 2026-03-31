import dotenv from 'dotenv';

dotenv.config();

const config = {
    port: process.env.ARCHON_DRAWBRIDGE_PORT ? parseInt(process.env.ARCHON_DRAWBRIDGE_PORT) : 4222,
    bindAddress: process.env.ARCHON_BIND_ADDRESS || '0.0.0.0',
    gatekeeperURL: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    heraldURL: process.env.ARCHON_HERALD_URL || 'http://localhost:4230',
    lightningMediatorURL: process.env.ARCHON_LIGHTNING_MEDIATOR_URL || 'http://localhost:4235',
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY || '',

    // Lightning / L402
    l402Enabled: process.env.ARCHON_DRAWBRIDGE_L402_ENABLED === 'true',
    clnRestUrl: process.env.ARCHON_DRAWBRIDGE_CLN_REST_URL || 'http://localhost:3001',
    clnRune: process.env.ARCHON_DRAWBRIDGE_CLN_RUNE || '',
    macaroonSecret: process.env.ARCHON_DRAWBRIDGE_MACAROON_SECRET || '',
    defaultPriceSats: process.env.ARCHON_DRAWBRIDGE_DEFAULT_PRICE_SATS ? parseInt(process.env.ARCHON_DRAWBRIDGE_DEFAULT_PRICE_SATS) : 10,
    invoiceExpiry: process.env.ARCHON_DRAWBRIDGE_INVOICE_EXPIRY ? parseInt(process.env.ARCHON_DRAWBRIDGE_INVOICE_EXPIRY) : 3600,

    // Rate limiting
    rateLimitMax: process.env.ARCHON_DRAWBRIDGE_RATE_LIMIT_MAX ? parseInt(process.env.ARCHON_DRAWBRIDGE_RATE_LIMIT_MAX) : 100,
    rateLimitWindow: process.env.ARCHON_DRAWBRIDGE_RATE_LIMIT_WINDOW ? parseInt(process.env.ARCHON_DRAWBRIDGE_RATE_LIMIT_WINDOW) : 60,

    // LNbits
    lnbitsUrl: process.env.ARCHON_DRAWBRIDGE_LNBITS_URL || '',

    // Public Lightning invoices
    publicHost: process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST || '',

    // Tor SOCKS proxy for .onion requests (host:port)
    torProxy: process.env.ARCHON_TOR_PROXY || '',

    // Redis
    redisUrl: process.env.ARCHON_REDIS_URL || 'redis://localhost:6379',
};

export default config;
