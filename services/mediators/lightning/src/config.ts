import dotenv from 'dotenv';
import type { LightningMediatorConfig } from './types.js';

dotenv.config();

const config: LightningMediatorConfig = {
    port: process.env.ARCHON_LIGHTNING_MEDIATOR_PORT ? parseInt(process.env.ARCHON_LIGHTNING_MEDIATOR_PORT, 10) : 4235,
    bindAddress: process.env.ARCHON_BIND_ADDRESS || '0.0.0.0',
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY || '',
    redisUrl: process.env.ARCHON_LIGHTNING_MEDIATOR_REDIS_URL || process.env.ARCHON_REDIS_URL || 'redis://localhost:6379',
    gatekeeperUrl: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    clnRestUrl: process.env.ARCHON_LIGHTNING_MEDIATOR_CLN_REST_URL || 'https://cln:3001',
    clnRune: process.env.ARCHON_LIGHTNING_MEDIATOR_CLN_RUNE || '',
    lnbitsUrl: process.env.ARCHON_LIGHTNING_MEDIATOR_LNBITS_URL || 'http://lnbits:5000',
    publicHost: process.env.ARCHON_LIGHTNING_MEDIATOR_PUBLIC_HOST || '',
    drawbridgePublicHost: process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST || '',
    drawbridgePort: process.env.ARCHON_DRAWBRIDGE_PORT ? parseInt(process.env.ARCHON_DRAWBRIDGE_PORT, 10) : 4222,
    torProxy: process.env.ARCHON_LIGHTNING_MEDIATOR_TOR_PROXY || '',
};

export default config;
