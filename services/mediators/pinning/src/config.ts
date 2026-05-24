import dotenv from 'dotenv';

dotenv.config();

function csvEnv(name: string): string[] {
    return (process.env[name] || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function intEnv(name: string, fallback: number): number {
    const value = process.env[name];
    return value ? parseInt(value, 10) : fallback;
}

export interface AppConfig {
    nodeID?: string;
    adminApiKey?: string;
    gatekeeperURL: string;
    provider: string;
    apiUrl: string;
    apiToken?: string;
    importInterval: number;
    metricsPort: number;
    statePath: string;
    origins: string[];
}

const provider = process.env.ARCHON_PIN_PROVIDER || 'filebase';

const defaultApiUrl = provider === 'pinata'
    ? 'https://api.pinata.cloud/psa'
    : 'https://api.filebase.io/v1/ipfs';

const config: AppConfig = {
    nodeID: process.env.ARCHON_NODE_ID,
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY,
    gatekeeperURL: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    provider,
    apiUrl: (process.env.ARCHON_PIN_API_URL || defaultApiUrl).replace(/\/+$/, ''),
    apiToken: process.env.ARCHON_PIN_API_TOKEN,
    importInterval: intEnv('ARCHON_PIN_IMPORT_INTERVAL', 1),
    metricsPort: intEnv('ARCHON_PIN_METRICS_PORT', 4273),
    statePath: process.env.ARCHON_PIN_STATE_PATH || './data/pinning-pins.json',
    origins: csvEnv('ARCHON_PIN_ORIGINS'),
};

export default config;
