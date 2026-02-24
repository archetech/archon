import dotenv from 'dotenv';

dotenv.config();

const config = {
    port: process.env.ARCHON_GATEKEEPER_PORT ? parseInt(process.env.ARCHON_GATEKEEPER_PORT) : 4224,
    bindAddress: process.env.ARCHON_BIND_ADDRESS || '0.0.0.0',
    db: process.env.ARCHON_GATEKEEPER_DB || 'redis',
    ipfsURL: process.env.ARCHON_IPFS_URL || 'http://localhost:5001/api/v0',
    didPrefix: process.env.ARCHON_GATEKEEPER_DID_PREFIX || 'did:cid',
    registries: process.env.ARCHON_GATEKEEPER_REGISTRIES ? process.env.ARCHON_GATEKEEPER_REGISTRIES.split(',') : undefined,
    jsonLimit: process.env.ARCHON_GATEKEEPER_JSON_LIMIT || '4mb',
    uploadLimit: process.env.ARCHON_GATEKEEPER_UPLOAD_LIMIT || '10mb',
    gcInterval: process.env.ARCHON_GATEKEEPER_GC_INTERVAL ? parseInt(process.env.ARCHON_GATEKEEPER_GC_INTERVAL) : 15,
    statusInterval: process.env.ARCHON_GATEKEEPER_STATUS_INTERVAL ? parseInt(process.env.ARCHON_GATEKEEPER_STATUS_INTERVAL) : 5,
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY || '',
    fallbackURL: process.env.ARCHON_GATEKEEPER_FALLBACK_URL || 'https://dev.uniresolver.io',
    fallbackTimeout: process.env.ARCHON_GATEKEEPER_FALLBACK_TIMEOUT ? parseInt(process.env.ARCHON_GATEKEEPER_FALLBACK_TIMEOUT) : 5000,

    // L402 payment protocol
    l402Enabled: (process.env.ARCHON_L402_ENABLED || 'false').toLowerCase() === 'true',
    l402RootSecret: process.env.ARCHON_L402_ROOT_SECRET || '',
    l402DefaultAmountSat: process.env.ARCHON_L402_DEFAULT_AMOUNT_SAT ? parseInt(process.env.ARCHON_L402_DEFAULT_AMOUNT_SAT) : 100,
    l402DefaultExpirySeconds: process.env.ARCHON_L402_DEFAULT_EXPIRY_SECONDS ? parseInt(process.env.ARCHON_L402_DEFAULT_EXPIRY_SECONDS) : 3600,
    l402DefaultScopes: process.env.ARCHON_L402_DEFAULT_SCOPES ? process.env.ARCHON_L402_DEFAULT_SCOPES.split(',') : ['resolveDID', 'getDIDs'],
    l402RateLimitRequests: process.env.ARCHON_L402_RATE_LIMIT_REQUESTS ? parseInt(process.env.ARCHON_L402_RATE_LIMIT_REQUESTS) : 1000,
    l402RateLimitWindowSeconds: process.env.ARCHON_L402_RATE_LIMIT_WINDOW_SECONDS ? parseInt(process.env.ARCHON_L402_RATE_LIMIT_WINDOW_SECONDS) : 3600,
    l402Store: process.env.ARCHON_L402_STORE || 'redis',
    l402ClnRestUrl: process.env.ARCHON_L402_CLN_REST_URL || '',
    l402ClnRune: process.env.ARCHON_L402_CLN_RUNE || '',
    l402CashuMintUrl: process.env.ARCHON_L402_CASHU_MINT_URL || '',
    l402CashuTrustedMints: process.env.ARCHON_L402_CASHU_TRUSTED_MINTS ? process.env.ARCHON_L402_CASHU_TRUSTED_MINTS.split(',') : [],
};

export default config;
