import dotenv from 'dotenv';

dotenv.config();

export interface MediatorConfig {
    adminApiKey: string;
    walletUrl: string;
    exportIntervalMs: number;
    port: number;
    metricsPort: number;
}

const config: MediatorConfig = {
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY || '',
    walletUrl: process.env.ARCHON_FIL_WALLET_URL || 'http://localhost:4242',
    exportIntervalMs: process.env.ARCHON_FIL_EXPORT_INTERVAL
        ? parseInt(process.env.ARCHON_FIL_EXPORT_INTERVAL)
        : 60_000,
    port: process.env.ARCHON_FIL_MEDIATOR_PORT
        ? parseInt(process.env.ARCHON_FIL_MEDIATOR_PORT)
        : 4244,
    metricsPort: process.env.ARCHON_FIL_MEDIATOR_METRICS_PORT
        ? parseInt(process.env.ARCHON_FIL_MEDIATOR_METRICS_PORT)
        : 4245,
};

export default config;
