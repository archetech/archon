import dotenv from 'dotenv';

dotenv.config();

const config = {
    gatekeeperURL: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    didcommPort: process.env.ARCHON_DIDCOMM_PORT ? parseInt(process.env.ARCHON_DIDCOMM_PORT) : 4236,
    bindAddress: process.env.ARCHON_BIND_ADDRESS || '0.0.0.0',
    uploadLimit: process.env.ARCHON_DIDCOMM_UPLOAD_LIMIT || '5mb',
    messageTtlMs: process.env.ARCHON_DIDCOMM_MESSAGE_TTL_MS ? parseInt(process.env.ARCHON_DIDCOMM_MESSAGE_TTL_MS) : 7 * 24 * 60 * 60 * 1000,
    db: process.env.ARCHON_DIDCOMM_DB || 'memory',
    // Storage caps. Byte-based because the upload limit allows multi-MB
    // envelopes, so a message count does not bound memory. Deposit is
    // unauthenticated by design and the depositor chooses the recipient DID, so
    // a per-recipient cap alone is not a bound -- maxTotalBytes is the one that
    // stops growth by delivering to endless fresh DIDs.
    maxRecipientBytes: process.env.ARCHON_DIDCOMM_MAX_RECIPIENT_BYTES
        ? parseInt(process.env.ARCHON_DIDCOMM_MAX_RECIPIENT_BYTES) : 16 * 1024 * 1024,
    maxTotalBytes: process.env.ARCHON_DIDCOMM_MAX_TOTAL_BYTES
        ? parseInt(process.env.ARCHON_DIDCOMM_MAX_TOTAL_BYTES) : 256 * 1024 * 1024,
    redisURL: process.env.ARCHON_REDIS_URL || 'redis://localhost:6379',
    // Outbound egress (POST /deliver): SOCKS5 Tor proxy for .onion destinations,
    // and an opt-in to allow private/loopback destinations (dev/test only).
    torProxy: process.env.ARCHON_DIDCOMM_TOR_PROXY || '',
    allowPrivateEgress: process.env.ARCHON_DIDCOMM_ALLOW_PRIVATE_EGRESS === 'true',
};

export default config;
