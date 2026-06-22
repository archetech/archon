import dotenv from 'dotenv';

dotenv.config();

const config = {
    gatekeeperURL: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    didcommPort: process.env.ARCHON_DIDCOMM_PORT ? parseInt(process.env.ARCHON_DIDCOMM_PORT) : 4228,
    bindAddress: process.env.ARCHON_BIND_ADDRESS || '0.0.0.0',
    uploadLimit: process.env.ARCHON_DIDCOMM_UPLOAD_LIMIT || '5mb',
    messageTtlMs: process.env.ARCHON_DIDCOMM_MESSAGE_TTL_MS ? parseInt(process.env.ARCHON_DIDCOMM_MESSAGE_TTL_MS) : 7 * 24 * 60 * 60 * 1000,
    db: process.env.ARCHON_DIDCOMM_DB || 'memory',
    redisURL: process.env.ARCHON_REDIS_URL || 'redis://localhost:6379',
};

export default config;
