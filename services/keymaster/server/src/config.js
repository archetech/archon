import dotenv from 'dotenv';

dotenv.config();

const config = {
    gatekeeperURL: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    searchURL: process.env.ARCHON_SEARCH_URL || 'http://localhost:4002',
    disableSearch: process.env.ARCHON_DISABLE_SEARCH ? process.env.ARCHON_DISABLE_SEARCH === 'true' : false,
    keymasterPort: process.env.ARCHON_KEYMASTER_PORT ? parseInt(process.env.ARCHON_KEYMASTER_PORT) : 4226,
    nodeID: process.env.ARCHON_NODE_ID || '',
    db: process.env.ARCHON_KEYMASTER_DB || 'json',
    keymasterPassphrase: process.env.ARCHON_ENCRYPTED_PASSPHRASE || '',
    walletCache: process.env.ARCHON_WALLET_CACHE ? process.env.ARCHON_WALLET_CACHE === 'true' : false,
    defaultRegistry: process.env.ARCHON_DEFAULT_REGISTRY
};

export default config;
