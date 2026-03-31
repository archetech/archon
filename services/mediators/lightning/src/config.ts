import dotenv from 'dotenv';
import type { LightningMediatorConfig } from './types.js';

dotenv.config();

const config: LightningMediatorConfig = {
    port: process.env.ARCHON_LIGHTNING_MEDIATOR_PORT ? parseInt(process.env.ARCHON_LIGHTNING_MEDIATOR_PORT, 10) : 4235,
    bindAddress: process.env.ARCHON_BIND_ADDRESS || '0.0.0.0',
    redisUrl: process.env.ARCHON_LIGHTNING_MEDIATOR_REDIS_URL || process.env.ARCHON_REDIS_URL || 'redis://localhost:6379',
    clnRestUrl: process.env.ARCHON_LIGHTNING_MEDIATOR_CLN_REST_URL || 'https://cln:3001',
    clnRune: process.env.ARCHON_LIGHTNING_MEDIATOR_CLN_RUNE || '',
    lnbitsUrl: process.env.ARCHON_LIGHTNING_MEDIATOR_LNBITS_URL || '',
    publicHost: process.env.ARCHON_LIGHTNING_MEDIATOR_PUBLIC_HOST || '',
    torProxy: process.env.ARCHON_LIGHTNING_MEDIATOR_TOR_PROXY || '',
};

export default config;
