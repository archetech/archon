import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
    nodeID?: string;
    adminApiKey?: string;
    gatekeeperURL: string;
    walletURL: string;
    importInterval: number;
    metricsPort: number;
    statePath: string;
}

const config: AppConfig = {
    nodeID: process.env.ARCHON_NODE_ID,
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY,
    gatekeeperURL: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    walletURL: process.env.ARCHON_WALLET_URL || process.env.ARCHON_FIL_WALLET_URL || 'http://localhost:4270',
    importInterval: process.env.ARCHON_FIL_IMPORT_INTERVAL ? parseInt(process.env.ARCHON_FIL_IMPORT_INTERVAL) : 1,
    metricsPort: process.env.ARCHON_FIL_METRICS_PORT ? parseInt(process.env.ARCHON_FIL_METRICS_PORT) : 4271,
    statePath: process.env.ARCHON_FIL_STATE_PATH || './data/filecoin-pins.json',
};

export default config;
