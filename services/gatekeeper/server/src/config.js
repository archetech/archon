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
    gcInterval: process.env.ARCHON_GATEKEEPER_GC_INTERVAL ? parseInt(process.env.ARCHON_GATEKEEPER_GC_INTERVAL) : 15,
    statusInterval: process.env.ARCHON_GATEKEEPER_STATUS_INTERVAL ? parseInt(process.env.ARCHON_GATEKEEPER_STATUS_INTERVAL) : 5,
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY || '',
};

export default config;
