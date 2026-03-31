import express from 'express';
import morgan from 'morgan';
import pino from 'pino';
import { readFile } from 'fs/promises';
import { Counter, Gauge, collectDefaultMetrics, register } from 'prom-client';
import { Redis } from 'ioredis';

import config from './config.js';
import type { ReadinessStatus } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

collectDefaultMetrics();

const httpRequestsTotal = new Counter({
    name: 'lightning_mediator_http_requests_total',
    help: 'Total HTTP requests handled by the Lightning mediator',
    labelNames: ['method', 'route', 'status'],
});

const lightningMediatorVersionInfo = new Gauge({
    name: 'lightning_mediator_version_info',
    help: 'Lightning mediator version information',
    labelNames: ['version', 'commit'],
});

let serviceVersion = 'unknown';
const serviceCommit = (process.env.GIT_COMMIT || 'unknown').slice(0, 7);

readFile(new URL('../package.json', import.meta.url), 'utf-8').then(data => {
    const pkg = JSON.parse(data);
    serviceVersion = pkg.version;
    lightningMediatorVersionInfo.set({ version: serviceVersion, commit: serviceCommit }, 1);
}).catch(() => {
    lightningMediatorVersionInfo.set({ version: 'unknown', commit: serviceCommit }, 1);
});

async function checkRedis(redisUrl: string): Promise<boolean> {
    const redis = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
    });

    try {
        await redis.connect();
        await redis.ping();
        return true;
    } catch {
        return false;
    } finally {
        redis.disconnect();
    }
}

async function buildReadinessStatus(): Promise<ReadinessStatus> {
    const redisReady = await checkRedis(config.redisUrl);

    return {
        ready: redisReady,
        dependencies: {
            redis: redisReady,
            clnConfigured: Boolean(config.clnRune && config.clnRestUrl),
            lnbitsConfigured: Boolean(config.lnbitsUrl),
        },
    };
}

async function main(): Promise<void> {
    const app = express();

    app.use(express.json({ limit: '1mb' }));
    app.use(morgan('dev'));

    app.use((req, res, next) => {
        res.on('finish', () => {
            httpRequestsTotal.inc({
                method: req.method,
                route: req.path,
                status: String(res.statusCode),
            });
        });
        next();
    });

    app.get('/ready', async (_req, res) => {
        const status = await buildReadinessStatus();
        res.status(status.ready ? 200 : 503).json(status);
    });

    app.get('/version', (_req, res) => {
        res.json({ version: serviceVersion, commit: serviceCommit });
    });

    app.get('/metrics', async (_req, res) => {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    });

    app.get('/api/v1/lightning/supported', (_req, res) => {
        res.json({
            supported: true,
            mediator: 'lightning-mediator',
            clnConfigured: Boolean(config.clnRune && config.clnRestUrl),
            lnbitsConfigured: Boolean(config.lnbitsUrl),
        });
    });

    app.listen(config.port, config.bindAddress, () => {
        logger.info(`Lightning mediator v${serviceVersion} (${serviceCommit}) running on ${config.bindAddress}:${config.port}`);
    });
}

main().catch((error: unknown) => {
    logger.error({ err: error }, 'Failed to start lightning mediator');
    process.exit(1);
});
