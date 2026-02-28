import dotenv from 'dotenv';

dotenv.config();

const config = {
    port: process.env.ARCHON_DRAWBRIDGE_PORT ? parseInt(process.env.ARCHON_DRAWBRIDGE_PORT) : 4230,
    bindAddress: process.env.ARCHON_BIND_ADDRESS || '0.0.0.0',
    gatekeeperURL: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY || '',

    // Lightning / L402
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

    // Redis
    redisUrl: process.env.ARCHON_REDIS_URL || 'redis://localhost:6379',
};

export default config;
