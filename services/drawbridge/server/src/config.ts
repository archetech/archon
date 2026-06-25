import dotenv from 'dotenv';

dotenv.config();

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
    macaroonSecret: process.env.ARCHON_DRAWBRIDGE_MACAROON_SECRET || '',
    defaultPriceSats: process.env.ARCHON_DRAWBRIDGE_DEFAULT_PRICE_SATS ? parseInt(process.env.ARCHON_DRAWBRIDGE_DEFAULT_PRICE_SATS) : 10,
    invoiceExpiry: process.env.ARCHON_DRAWBRIDGE_INVOICE_EXPIRY ? parseInt(process.env.ARCHON_DRAWBRIDGE_INVOICE_EXPIRY) : 3600,

    // Rate limiting
    rateLimitMax: process.env.ARCHON_DRAWBRIDGE_RATE_LIMIT_MAX ? parseInt(process.env.ARCHON_DRAWBRIDGE_RATE_LIMIT_MAX) : 100,
    rateLimitWindow: process.env.ARCHON_DRAWBRIDGE_RATE_LIMIT_WINDOW ? parseInt(process.env.ARCHON_DRAWBRIDGE_RATE_LIMIT_WINDOW) : 60,

    // Redis
    redisUrl: process.env.ARCHON_REDIS_URL || 'redis://localhost:6379',
};

export default config;
