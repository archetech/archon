import dotenv from 'dotenv';

dotenv.config();

const config = {
    gatekeeperURL: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    keymasterPort: process.env.ARCHON_KEYMASTER_PORT ? parseInt(process.env.ARCHON_KEYMASTER_PORT) : 4226,
    bindAddress: process.env.ARCHON_BIND_ADDRESS || '0.0.0.0',
    nodeID: process.env.ARCHON_NODE_ID || '',
    db: process.env.ARCHON_KEYMASTER_DB || 'json',
    keymasterPassphrase: process.env.ARCHON_ENCRYPTED_PASSPHRASE || '',
    walletCache: process.env.ARCHON_WALLET_CACHE ? process.env.ARCHON_WALLET_CACHE === 'true' : false,
    defaultRegistry: process.env.ARCHON_DEFAULT_REGISTRY,
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY || '',
};

export default config;
