import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import { resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import type Gatekeeper from '@didcid/gatekeeper';
import { CheckDIDsResult } from '@didcid/gatekeeper/types';
import { createIdentifiersRouter } from './identifiers-router.js';
import { createV1Router } from './v1-router.js';
import defaultConfig from './config.js';
import promClient from 'prom-client';
import pino from 'pino';
import { pinoHttp } from 'pino-http';

// Initialize Prometheus metrics
const register = promClient.register;
promClient.collectDefaultMetrics({ register });

// Custom metrics
const httpRequestsTotal = new promClient.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status'],
});

const httpRequestDuration = new promClient.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
});

const didOperationsTotal = new promClient.Counter({
    name: 'did_operations_total',
    help: 'Total number of DID operations',
    labelNames: ['operation', 'registry', 'status'],
});

const eventsQueueGauge = new promClient.Gauge({
    name: 'events_queue_size',
    help: 'Number of events in the queue',
    labelNames: ['registry'],
});

const didsTotalGauge = new promClient.Gauge({
    name: 'gatekeeper_dids_total',
    help: 'Total number of DIDs',
});

const didsByTypeGauge = new promClient.Gauge({
    name: 'gatekeeper_dids_by_type',
    help: 'Number of DIDs by type',
    labelNames: ['type'],
});

const didsByRegistryGauge = new promClient.Gauge({
    name: 'gatekeeper_dids_by_registry',
    help: 'Number of DIDs by registry',
    labelNames: ['registry'],
});

const serviceVersionInfo = new promClient.Gauge({
    name: 'service_version_info',
    help: 'Service version information',
    labelNames: ['version', 'commit'],
});

// Initialize structured logger
const defaultLogger = pino({
    level: process.env.LOG_LEVEL || 'info',
});

// Normalize paths to prevent high cardinality metrics
function normalizePath(path: string): string {
    // Remove query string
    const basePath = path.split('?')[0];
    // Normalize known dynamic segments
    return basePath
        .replace(/\/did\/(?:did:[^/]+|did%3[aA][^/]+)/g, '/did/:did')
        .replace(/\/identifiers\/(?:did:[^/]+|did%3[aA][^/]+)/g, '/identifiers/:did')
        .replace(/\/block\/[^/]+\/latest/g, '/block/:registry/latest')
        .replace(/\/block\/[^/]+/g, '/block/:registry')
        .replace(/\/queue\/[^/]+\/clear/g, '/queue/:registry/clear')
        .replace(/\/queue\/[^/]+/g, '/queue/:registry')
        .replace(/\/events\/[^/]+/g, '/events/:registry')
        .replace(/\/dids\/[^/]+/g, '/dids/:prefix');
}

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const commit = (process.env.GIT_COMMIT || 'unknown').slice(0, 7);
serviceVersionInfo.set({ version: pkg.version, commit }, 1);

EventEmitter.defaultMaxListeners = 100;

type GatekeeperApiConfig = typeof defaultConfig;

export interface CreateGatekeeperAppOptions {
    gatekeeper: Gatekeeper;
    config?: GatekeeperApiConfig;
    logger?: typeof defaultLogger;
    ready?: boolean;
    didCheck?: CheckDIDsResult;
    httpLogging?: boolean;
}

export function createGatekeeperApp(options: CreateGatekeeperAppOptions) {
    const gatekeeper = options.gatekeeper;
    const config = options.config ?? defaultConfig;
    const logger = options.logger ?? defaultLogger;
    const startTime = new Date();
    const app = express();

    app.use(cors());
    app.options('*', cors());

    // HTTP request logging - use pino in production, morgan in development
    if (options.httpLogging ?? process.env.NODE_ENV !== 'test') {
        if (process.env.NODE_ENV === 'production') {
            app.use(pinoHttp({ logger }));
        } else {
            app.use(morgan('dev'));
        }
    }
    app.use(express.json({ limit: config.jsonLimit }));

    // Metrics middleware - track HTTP requests
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const duration = (Date.now() - start) / 1000;
            const route = normalizePath(req.path);
            httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
            httpRequestDuration.observe({ method: req.method, route, status: res.statusCode }, duration);
        });
        next();
    });

    /**
     * @swagger
     * /metrics:
     *   get:
     *     summary: Retrieve Prometheus metrics
     *     responses:
     *       200:
     *         description: Prometheus text exposition metrics.
     *         content:
     *           text/plain:
     *             schema:
     *               type: string
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           text/plain:
     *             schema:
     *               type: string
     */
    // Prometheus metrics endpoint
    app.get('/metrics', async (req, res) => {
        try {
            res.set('Content-Type', register.contentType);
            res.end(await register.metrics());
        } catch (error: any) {
            res.status(500).end(error.toString());
        }
    });

    let serverReady = options.ready ?? false;

    const v1router = createV1Router({
        gatekeeper,
        config,
        logger,
        isReady: () => serverReady,
        getStatus,
        didOperationsTotal,
    });
    app.use('/api/v1', v1router);
    // Standards-conformant DID resolution / dereferencing surface, following the Universal
    // Resolver driver convention. Distinct from the internal /api/v1/did/:did family (preserved
    // for backwards compat). Built by a factory so it can be HTTP-tested with an in-memory Gatekeeper.
    app.use('/1.0/identifiers', createIdentifiersRouter(gatekeeper, logger));

    app.use('/api', (req, res) => {
        console.warn(`Warning: Unhandled API endpoint - ${req.method} ${req.originalUrl}`);
        res.status(404).json({ message: 'Endpoint not found' });
    });

    async function gcLoop() {
        try {
            const response = await gatekeeper.verifyDb();
            console.log(`DID garbage collection: ${JSON.stringify(response)} waiting ${config.gcInterval} minutes...`);
            await checkDids();
        }
        catch (error: any) {
            console.error(`Error in DID garbage collection: ${error}`);
        }
        setTimeout(gcLoop, config.gcInterval * 60 * 1000);
    }

    let didCheck: CheckDIDsResult = options.didCheck ?? {
        total: 0,
        byType: {
            agents: 0,
            assets: 0,
            confirmed: 0,
            unconfirmed: 0,
            ephemeral: 0,
            invalid: 0,
        },
        byRegistry: {},
        byVersion: {},
        eventsQueue: [],
    };

    async function checkDids() {
        console.time('checkDIDs');
        didCheck = await gatekeeper.checkDIDs();
        console.timeEnd('checkDIDs');

        // Update events queue metrics - reset first to clear stale data
        eventsQueueGauge.reset();
        if (didCheck.eventsQueue) {
            const queueByRegistry: Record<string, number> = {};
            for (const event of didCheck.eventsQueue) {
                const registry = event.registry || 'unknown';
                queueByRegistry[registry] = (queueByRegistry[registry] || 0) + 1;
            }
            for (const [registry, count] of Object.entries(queueByRegistry)) {
                eventsQueueGauge.set({ registry }, count);
            }
        }

        // Update DID count gauges
        didsTotalGauge.set(didCheck.total || 0);

        didsByTypeGauge.reset();
        if (didCheck.byType) {
            for (const [type, count] of Object.entries(didCheck.byType)) {
                didsByTypeGauge.set({ type }, count as number);
            }
        }

        didsByRegistryGauge.reset();
        if (didCheck.byRegistry) {
            for (const [registry, count] of Object.entries(didCheck.byRegistry)) {
                didsByRegistryGauge.set({ registry }, count as number);
            }
        }
    }

    async function getStatus() {
        return {
            uptimeSeconds: Math.round((Date.now() - startTime.getTime()) / 1000),
            dids: didCheck,
            memoryUsage: process.memoryUsage()
        };
    }

    async function reportStatus() {
        await checkDids();
        const status = await getStatus();

        console.log('Status -----------------------------');

        console.log(`DID Database (${config.db}):`);
        console.log(`  Total: ${status.dids.total}`);

        if (status.dids.total > 0) {
            console.log(`  By type:`);
            console.log(`    Agents: ${status.dids.byType.agents}`);
            console.log(`    Assets: ${status.dids.byType.assets}`);
            console.log(`    Confirmed: ${status.dids.byType.confirmed}`);
            console.log(`    Unconfirmed: ${status.dids.byType.unconfirmed}`);
            console.log(`    Ephemeral: ${status.dids.byType.ephemeral}`);
            console.log(`    Invalid: ${status.dids.byType.invalid}`);

            console.log(`  By registry:`);
            const registries = Object.keys(status.dids.byRegistry).sort();
            for (let registry of registries) {
                console.log(`    ${registry}: ${status.dids.byRegistry[registry]}`);
            }

            console.log(`  By version:`);
            let count = 0;
            for (let version of [1, 2, 3, 4, 5]) {
                const num = status.dids.byVersion[version] || 0;
                console.log(`    ${version}: ${num}`);
                count += num;
            }
            console.log(`    6+: ${status.dids.total - count}`);
        }

        console.log(`Events Queue: ${status.dids.eventsQueue.length} pending`);

        console.log(`Memory Usage Report:`);
        console.log(`  RSS: ${formatBytes(status.memoryUsage.rss)} (Resident Set Size - total memory allocated for the process)`);
        console.log(`  Heap Total: ${formatBytes(status.memoryUsage.heapTotal)} (Total heap allocated)`);
        console.log(`  Heap Used: ${formatBytes(status.memoryUsage.heapUsed)} (Heap actually used)`);
        console.log(`  External: ${formatBytes(status.memoryUsage.external)} (Memory used by C++ objects bound to JavaScript)`);
        console.log(`  Array Buffers: ${formatBytes(status.memoryUsage.arrayBuffers)} (Memory used by ArrayBuffer and SharedArrayBuffer)`);

        console.log(`Uptime: ${status.uptimeSeconds}s (${formatDuration(status.uptimeSeconds)})`);

        console.log('------------------------------------');
    }

    function formatDuration(seconds: number) {
        const secPerMin = 60;
        const secPerHour = secPerMin * 60;
        const secPerDay = secPerHour * 24;

        const days = Math.floor(seconds / secPerDay);
        seconds %= secPerDay;

        const hours = Math.floor(seconds / secPerHour);
        seconds %= secPerHour;

        const minutes = Math.floor(seconds / secPerMin);
        seconds %= secPerMin;

        let duration = "";

        if (days > 0) {
            if (days > 1) {
                duration += `${days} days, `;
            } else {
                duration += `1 day, `;
            }
        }

        if (hours > 0) {
            if (hours > 1) {
                duration += `${hours} hours, `;
            } else {
                duration += `1 hour, `;
            }
        }

        if (minutes > 0) {
            if (minutes > 1) {
                duration += `${minutes} minutes, `;
            } else {
                duration += `1 minute, `;
            }
        }

        if (seconds === 1) {
            duration += `1 second`;
        } else {
            duration += `${seconds} seconds`;
        }

        return duration;
    }

    function formatBytes(bytes: number) {
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        if (bytes === 0) return '0 Byte';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
    }

    return {
        app,
        checkDids,
        gcLoop,
        getStatus,
        reportStatus,
        setReady(value: boolean) {
            serverReady = value;
        },
    };
}

async function createDb(config: GatekeeperApiConfig) {
    const dbName = 'archon';

    switch (config.db) {
    case 'sqlite': {
        const { default: DbSqlite } = await import('@didcid/gatekeeper/db/sqlite');
        return new DbSqlite(dbName);
    }
    case 'mongodb': {
        const { default: DbMongo } = await import('@didcid/gatekeeper/db/mongo');
        return new DbMongo(dbName);
    }
    case 'redis': {
        const { default: DbRedis } = await import('@didcid/gatekeeper/db/redis');
        return new DbRedis(dbName);
    }
    case 'json':
    case 'json-cache': {
        const { default: DbJsonCache } = await import('@didcid/gatekeeper/db/json-cache');
        return new DbJsonCache(dbName);
    }
    default: return null;
    }
}

async function main() {
    const config = defaultConfig;
    const db = await createDb(config);

    if (!db) {
        throw new Error(`Unsupported DB type: ${config.db}`);
    }

    await db.start();

    const { default: Gatekeeper } = await import('@didcid/gatekeeper');
    const { default: KuboClient } = await import('@didcid/ipfs/kubo');

    const ipfs = await KuboClient.create({
        url: config.ipfsURL,
        waitUntilReady: true,
        intervalSeconds: 5,
        chatty: true,
    });

    const gatekeeper = new Gatekeeper({
        db,
        ipfs,
        didPrefix: config.didPrefix,
        registries: config.registries,
        registriesPin: config.registriesPin
    });

    const api = createGatekeeperApp({ gatekeeper, config, logger: defaultLogger });

    console.log(`Starting Archon Gatekeeper v${pkg.version} (${commit}) with a db (${config.db}) check...`);
    await api.reportStatus();

    console.log('Initializing search index...');
    await gatekeeper.initSearchIndex();

    if (config.statusInterval > 0) {
        console.log(`Starting status update every ${config.statusInterval} minutes`);
        setInterval(api.reportStatus, config.statusInterval * 60 * 1000);
    }
    else {
        console.log(`Status update disabled`);
    }

    if (config.gcInterval > 0) {
        console.log(`Starting DID garbage collection in ${config.gcInterval} minutes`);
        setTimeout(api.gcLoop, config.gcInterval * 60 * 1000);
    }
    else {
        console.log(`DID garbage collection disabled`);
    }

    console.log(`DID prefix: ${JSON.stringify(gatekeeper.didPrefix)}`);
    console.log(`Supported registries: ${JSON.stringify(gatekeeper.supportedRegistries)}`);

    const server = api.app.listen(config.port, config.bindAddress, () => {
        console.log(`Server is running on ${config.bindAddress}:${config.port}`);
        if (config.adminApiKey) {
            console.log('Admin API key protection is ENABLED');
        } else {
            console.warn('Warning: ARCHON_ADMIN_API_KEY is not set — admin routes are unprotected');
        }
        api.setReady(true);
    });

    const shutdown = async () => {
        try {
            server.close();
            if (db) {
                db.stop();
            }
        } catch (error: any) {
            console.error("Error during shutdown:", error);
        } finally {
            process.exit(0);
        }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

const isMain = process.argv[1]
    ? fileURLToPath(import.meta.url) === resolvePath(process.argv[1])
    : false;

if (isMain) {
    main();

    process.on('uncaughtException', (error) => {
        console.error('Unhandled exception caught', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled rejection caught', reason, promise);
    });
}
