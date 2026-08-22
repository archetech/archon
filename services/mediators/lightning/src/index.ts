// Production wiring for the Lightning mediator. The routes live in
// lightning-mediator.ts behind createApp, which takes its dependencies as
// parameters; this file supplies the real ones and listens. Same split as
// services/didcomm/server, and what makes the routes testable (#909).
import { readFile } from 'fs/promises';
import { Redis } from 'ioredis';
import pino from 'pino';
import GatekeeperClient from '@didcid/clients/gatekeeper';

import { createApp, type Resolver } from './lightning-mediator.js';
import config from './config.js';
import * as cln from './lightning.js';
import * as lnbits from './lnbits.js';
import { RedisStore } from './store.js';
import { lightningMediatorVersionInfo } from './lightning-mediator.js';
import type { ReadinessStatus } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const TOR_HOSTNAME_FILE = '/data/tor/hostname';

async function checkRedis(redisUrl: string): Promise<boolean> {
    let redis: Redis | undefined;
    try {
        redis = new Redis(redisUrl, {
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
            connectTimeout: 3000,
        });
        await redis.connect();
        const pong = await redis.ping();
        return pong === 'PONG';
    } catch {
        return false;
    } finally {
        if (redis) {
            try {
                await redis.quit();
            } catch {
                redis.disconnect();
            }
        }
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

async function readVersion(commit: string): Promise<{ version: string; commit: string }> {
    try {
        const data = await readFile(new URL('../package.json', import.meta.url), 'utf-8');
        return { version: JSON.parse(data).version, commit };
    } catch {
        return { version: 'unknown', commit };
    }
}

let gatekeeperPromise: Promise<Resolver> | undefined;

function getResolver(): Promise<Resolver> {
    if (!gatekeeperPromise) {
        gatekeeperPromise = GatekeeperClient.create({
            url: config.gatekeeperUrl,
            waitUntilReady: true,
            chatty: false,
        });
    }

    return gatekeeperPromise;
}

async function main(): Promise<void> {
    const commit = (process.env.GIT_COMMIT || 'unknown').slice(0, 7);
    const version = await readVersion(commit);
    lightningMediatorVersionInfo.set({ version: version.version, commit }, 1);

    const app = createApp({
        config,
        store: new RedisStore(config.redisUrl),
        getResolver,
        lnbits,
        cln,
        readiness: buildReadinessStatus,
        version,
        readTorHostname: () => readFile(TOR_HOSTNAME_FILE, 'utf-8'),
    });

    app.listen(config.port, config.bindAddress, () => {
        logger.info(`Lightning mediator v${version.version} (${commit}) running on ${config.bindAddress}:${config.port}`);
    });
}

main().catch((error: unknown) => {
    logger.error({ err: error }, 'Failed to start lightning mediator');
    process.exit(1);
});
