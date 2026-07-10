import { readFile } from 'fs/promises';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

import DrawbridgeClient from '@didcid/gatekeeper/drawbridge';
import Keymaster from '@didcid/keymaster';
import { WalletBase } from '@didcid/keymaster/types';
import WalletJson from '@didcid/keymaster/wallet/json';
import WalletRedis from '@didcid/keymaster/wallet/redis';
import WalletMongo from '@didcid/keymaster/wallet/mongo';
import WalletSQLite from '@didcid/keymaster/wallet/sqlite';
import WalletCache from '@didcid/keymaster/wallet/cache';
import CipherNode from '@didcid/cipher/node';
import { InvalidParameterError } from '@didcid/common/errors';
import config from './config.js';
import { createAddressRouter } from './keymaster-address-router.js';
import { createAgentRouter } from './keymaster-agent-router.js';
import { createAssetRouter } from './keymaster-asset-router.js';
import { createChallengeRouter } from './keymaster-challenge-router.js';
import { createRequireAdminKey } from './keymaster-admin.js';
import { createCoreRouter } from './keymaster-core-router.js';
import { createCredentialRouter } from './keymaster-credential-router.js';
import { createDidCommRouter } from './keymaster-didcomm-router.js';
import { createDmailRouter } from './keymaster-dmail-router.js';
import { createFileRouter } from './keymaster-file-router.js';
import { createGroupRouter } from './keymaster-group-router.js';
import { createIdentityRouter } from './keymaster-identity-router.js';
import { createImageRouter } from './keymaster-image-router.js';
import { createKeyRouter } from './keymaster-key-router.js';
import { createLightningRouter } from './keymaster-lightning-router.js';
import { createNostrRouter } from './keymaster-nostr-router.js';
import { createNoticeRouter } from './keymaster-notice-router.js';
import { createPollRouter } from './keymaster-poll-router.js';
import { createPublicRouter } from './keymaster-public-router.js';
import { createResponseRouter } from './keymaster-response-router.js';
import { createSchemaRouter } from './keymaster-schema-router.js';
import { createSchemaTemplateRouter } from './keymaster-schema-template-router.js';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';
import { createVaultRouter } from './keymaster-vault-router.js';
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

const walletOperationsTotal = new promClient.Counter({
    name: 'wallet_operations_total',
    help: 'Total number of wallet operations',
    labelNames: ['operation', 'status'],
});

const serviceVersionInfo = new promClient.Gauge({
    name: 'service_version_info',
    help: 'Service version information',
    labelNames: ['version', 'commit'],
});

let serviceVersion = 'unknown';
const serviceCommit = (process.env.GIT_COMMIT || 'unknown').slice(0, 7);

readFile(new URL('../package.json', import.meta.url), 'utf-8').then(data => {
    const pkg = JSON.parse(data);
    serviceVersion = pkg.version;
    serviceVersionInfo.set({ version: serviceVersion, commit: serviceCommit }, 1);
}).catch(() => {
    serviceVersionInfo.set({ version: 'unknown', commit: serviceCommit }, 1);
});

// Initialize structured logger
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
});

// Normalize paths to prevent high cardinality metrics
function normalizePath(path: string): string {
    // Remove query string
    const basePath = path.split('?')[0];
    // Normalize known dynamic segments
    return basePath
        .replace(/\/did\/[^/]+/g, '/did/:id')
        .replace(/\/ids\/[^/]+/g, '/ids/:id')
        .replace(/\/aliases\/[^/]+/g, '/aliases/:alias')
        .replace(/\/addresses\/check\/[^/]+/g, '/addresses/check/:address')
        .replace(/\/addresses\/import/g, '/addresses/import')
        .replace(/\/addresses\/publish/g, '/addresses/publish')
        .replace(/\/addresses\/[^/]+/g, '/addresses/:address')
        .replace(/\/groups\/[^/]+/g, '/groups/:name')
        .replace(/\/schemas\/[^/]+/g, '/schemas/:id')
        .replace(/\/agents\/[^/]+/g, '/agents/:id')
        .replace(/\/credentials\/held\/[^/]+/g, '/credentials/held/:did')
        .replace(/\/credentials\/issued\/[^/]+/g, '/credentials/issued/:did')
        .replace(/\/assets\/[^/]+/g, '/assets/:id')
        .replace(/\/polls\/[^/]+\/voters\/[^/]+/g, '/polls/:poll/voters/:voter')
        .replace(/\/polls\/ballot\/[^/]+/g, '/polls/ballot/:did')
        .replace(/\/polls\/[^/]+/g, '/polls/:poll')
        .replace(/\/images\/[^/]+/g, '/images/:id')
        .replace(/\/files\/[^/]+/g, '/files/:id')
        .replace(/\/ipfs\/data\/[^/]+/g, '/ipfs/data/:cid')
        .replace(/\/vaults\/[^/]+\/members\/[^/]+/g, '/vaults/:id/members/:member')
        .replace(/\/vaults\/[^/]+\/items\/[^/]+/g, '/vaults/:id/items/:name')
        .replace(/\/vaults\/[^/]+/g, '/vaults/:id')
        .replace(/\/dmail\/[^/]+\/attachments\/[^/]+/g, '/dmail/:id/attachments/:name')
        .replace(/\/dmail\/[^/]+/g, '/dmail/:id')
        .replace(/\/notices\/[^/]+/g, '/notices/:id');
}

const app = express();
const v1router = express.Router();

// HTTP request logging - use pino in production, morgan in development
if (process.env.NODE_ENV === 'production') {
    app.use(pinoHttp({ logger }));
} else {
    app.use(morgan('dev'));
}
app.use(cors());
app.options('*', cors());
app.use(express.json());

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

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
    try {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    } catch (error: any) {
        res.status(500).end(error.toString());
    }
});

const DIDNotFound = { error: 'DID not found' };

let gatekeeper: DrawbridgeClient;
let keymaster: Keymaster;
let serverReady = false;

const routerOptions: CreateKeymasterRouterOptions = {
    getKeymaster: () => keymaster,
    getGatekeeper: () => gatekeeper,
    config,
    walletOperationsTotal,
    didNotFound: DIDNotFound,
    isReady: () => serverReady,
    getServiceVersion: () => serviceVersion,
    serviceCommit,
};

v1router.use(createPublicRouter(routerOptions));
v1router.use(createRequireAdminKey(config));
v1router.use(createCoreRouter(routerOptions));
v1router.use(createIdentityRouter(routerOptions));
v1router.use(createAddressRouter(routerOptions));
v1router.use(createDidCommRouter(routerOptions));
v1router.use(createNostrRouter(routerOptions));
v1router.use(createLightningRouter(routerOptions));
v1router.use(createChallengeRouter(routerOptions));
v1router.use(createResponseRouter(routerOptions));
v1router.use(createGroupRouter(routerOptions));
v1router.use(createSchemaRouter(routerOptions));
v1router.use(createAgentRouter(routerOptions));
v1router.use(createCredentialRouter(routerOptions));
v1router.use(createKeyRouter(routerOptions));
v1router.use(createSchemaTemplateRouter(routerOptions));
v1router.use(createAssetRouter(routerOptions));
v1router.use(createPollRouter(routerOptions));
v1router.use(createImageRouter(routerOptions));
v1router.use(createFileRouter(routerOptions));
v1router.use(createVaultRouter(routerOptions));
v1router.use(createDmailRouter(routerOptions));
v1router.use(createNoticeRouter(routerOptions));

app.use('/api/v1', v1router);

app.use('/api', (req, res) => {
    console.warn(`Warning: Unhandled API endpoint - ${req.method} ${req.originalUrl}`);
    res.status(404).json({ message: 'Endpoint not found' });
});

process.on('uncaughtException', (error) => {
    //console.error('Unhandled exception caught');
    console.error('Unhandled exception caught', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    //console.error('Unhandled rejection caught');
});

async function waitForNodeId() {
    let isReady = false;

    if (!config.nodeID) {
        throw new Error('ARCHON_NODE_ID is not set in the configuration.');
    }

    const ids = await keymaster.listIds();

    if (!ids.includes(config.nodeID)) {
        await keymaster.createId(config.nodeID!);
        console.log(`Created node ID '${config.nodeID}'`);
    }

    while (!isReady) {
        try {
            console.log(`Resolving node ID: ${config.nodeID}`);
            const doc = await keymaster.resolveDID(config.nodeID);
            console.log(JSON.stringify(doc, null, 4));
            isReady = true;
        }
        catch {
            console.log(`Waiting for gatekeeper to sync...`);
        }

        if (!isReady) {
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
}

async function initWallet() {
    let wallet: WalletBase;

    if (config.db === 'redis') {
        wallet = await WalletRedis.create();
    } else if (config.db === 'mongodb') {
        wallet = await WalletMongo.create();
    } else if (config.db === 'sqlite') {
        wallet = await WalletSQLite.create();
    } else if (config.db === 'json') {
        wallet = new WalletJson();
    } else {
        throw new InvalidParameterError(`db=${config.db}`);
    }

    if (config.walletCache) {
        wallet = new WalletCache(wallet);
    }

    return wallet;
}

const port = config.keymasterPort;

const server = app.listen(port, config.bindAddress, async () => {
    gatekeeper = new DrawbridgeClient();

    await gatekeeper.connect({
        url: config.gatekeeperURL,
        waitUntilReady: true,
        intervalSeconds: 5,
        chatty: true,
    });

    const wallet = await initWallet();
    const cipher = new CipherNode();
    const defaultRegistry = config.defaultRegistry;
    keymaster = new Keymaster({
        gatekeeper,
        wallet,
        cipher,
        defaultRegistry,
        passphrase: config.keymasterPassphrase,
    });
    console.log(`Keymaster server v${serviceVersion} (${serviceCommit}) running on ${config.bindAddress}:${port}`);
    console.log(`Keymaster server persisting to ${config.db}`);
    if (config.adminApiKey) {
        console.log('Admin API key protection is ENABLED');
    } else {
        console.warn('Warning: ARCHON_ADMIN_API_KEY is not set — admin routes are unprotected');
    }

    try {
        await waitForNodeId();
        serverReady = true;
    }
    catch (error) {
        console.error('Failed to wait for node ID:', error);
    }
});

const shutdown = async () => {
    try {
        server.close();
    } catch (error: any) {
        console.error("Error during shutdown:", error);
    } finally {
        process.exit(0);
    }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
