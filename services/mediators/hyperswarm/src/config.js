import dotenv from 'dotenv';

dotenv.config();

const config = {
    debug: process.env.ARCHON_DEBUG ? process.env.ARCHON_DEBUG === 'true' : false,
    gatekeeperURL: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    keymasterURL: process.env.ARCHON_KEYMASTER_URL || 'http://localhost:4226',
    ipfsURL: process.env.ARCHON_IPFS_URL || 'http://localhost:5001/api/v0',
    nodeID: process.env.ARCHON_NODE_ID || '',
    nodeName: process.env.ARCHON_NODE_NAME || 'anon',
    protocol: process.env.ARCHON_PROTOCOL || '/ARCHON/v0.1',
    exportInterval: process.env.ARCHON_HYPR_EXPORT_INTERVAL ? parseInt(process.env.ARCHON_HYPR_EXPORT_INTERVAL) : 2,
};

export default config;
