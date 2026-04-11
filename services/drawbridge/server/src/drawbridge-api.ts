import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { register, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { readFile } from 'fs/promises';
import { timingSafeEqual } from 'crypto';
import GatekeeperClient from '@didcid/gatekeeper/client';

import config from './config.js';
import { RedisStore } from './store.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { handlePaymentCompletion, handleRevokeMacaroon, handleL402Status, handleGetPayments } from './middleware/l402-auth.js';
import { loadPricingFromEnv } from './pricing.js';
import type { L402Options, DrawbridgeStore } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Prometheus metrics
collectDefaultMetrics();

const httpRequestsTotal = new Counter({
    name: 'drawbridge_http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
});

const httpRequestDuration = new Histogram({
    name: 'drawbridge_http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
});

const l402ChallengesTotal = new Counter({
    name: 'drawbridge_l402_challenges_total',
    help: 'Total L402 challenges issued',
    labelNames: ['did_known'],
});

const l402VerificationsTotal = new Counter({
    name: 'drawbridge_l402_verifications_total',
    help: 'Total L402 macaroon verifications',
    labelNames: ['result'],
});

const drawbridgeVersionInfo = new Gauge({
    name: 'drawbridge_version_info',
    help: 'Service version information',
    labelNames: ['version', 'commit'],
});

const ARCHON_ADMIN_HEADER = 'x-archon-admin-key';

let serviceVersion = 'unknown';
const serviceCommit = (process.env.GIT_COMMIT || 'unknown').slice(0, 7);

readFile(new URL('../package.json', import.meta.url), 'utf-8').then(data => {
    const pkg = JSON.parse(data);
    serviceVersion = pkg.version;
    drawbridgeVersionInfo.set({ version: serviceVersion, commit: serviceCommit }, 1);
}).catch(() => {
    drawbridgeVersionInfo.set({ version: 'unknown', commit: serviceCommit }, 1);
});

function normalizePath(path: string): string {
    return path
        .replace(/\/did\/(?:did:[^/]+|did%3[aA][^/]+)/, '/did/:did')
        .replace(/\/invoice\/(?:did:[^/]+|did%3[aA][^/]+)/, '/invoice/:did')
        .replace(/\/ipfs\/json\/[^/]+/, '/ipfs/json/:cid')
        .replace(/\/ipfs\/text\/[^/]+/, '/ipfs/text/:cid')
        .replace(/\/ipfs\/data\/[^/]+/, '/ipfs/data/:cid')
        .replace(/\/ipfs\/stream\/[^/]+/, '/ipfs/stream/:cid')
        .replace(/\/queue\/[^/]+/, '/queue/:registry')
        .replace(/\/block\/[^/]+\/latest/, '/block/:registry/latest')
        .replace(/\/block\/[^/]+\/[^/]+/, '/block/:registry/:blockId')
        .replace(/\/payments\/[^/]+/, '/payments/:did');
}

function requireAdminKey(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!config.adminApiKey) {
        res.status(403).json({ error: 'Admin API key not configured' });
        return;
    }

    const adminHeader = req.headers[ARCHON_ADMIN_HEADER];
    const key = typeof adminHeader === 'string'
        ? adminHeader
        : Array.isArray(adminHeader)
            ? adminHeader[0]
            : null;

    if (!key) {
        res.status(401).json({ error: 'Admin API key required' });
        return;
    }

    const keyBuf = Buffer.from(key);
    const expectedBuf = Buffer.from(config.adminApiKey);

    if (keyBuf.length !== expectedBuf.length || !timingSafeEqual(keyBuf, expectedBuf)) {
        res.status(401).json({ error: 'Invalid admin API key' });
        return;
    }

    next();
}

function buildProxyBody(req: express.Request): BodyInit | undefined {
    if (req.method === 'GET' || req.method === 'HEAD') {
        return undefined;
    }

    const contentType = req.headers['content-type'] || '';

    if (Buffer.isBuffer(req.body)) {
        return new Uint8Array(req.body);
    }

    if (typeof req.body === 'string') {
        return req.body;
    }

    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        if (contentType.includes('application/x-www-form-urlencoded')) {
            return new URLSearchParams(
                Object.entries(req.body).flatMap(([key, value]) => {
                    if (Array.isArray(value)) {
                        return value.map(item => [key, String(item)] as [string, string]);
                    }
                    return [[key, String(value)] as [string, string]];
                })
            ).toString();
        }
        return JSON.stringify(req.body);
    }

    return undefined;
}

async function proxyHeraldRequest(req: express.Request, res: express.Response, prefixToStrip = '/names') {
    const upstreamPath = prefixToStrip
        ? (req.originalUrl.replace(new RegExp(`^${prefixToStrip}`), '') || '/')
        : req.originalUrl;
    const upstreamUrl = new URL(upstreamPath, config.heraldURL);

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (!value || name === 'host' || name === 'content-length') {
            continue;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                headers.append(name, item);
            }
        }
        else {
            headers.set(name, value);
        }
    }

    const body = buildProxyBody(req);
    if (body && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
    }

    const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
    });

    res.status(upstream.status);

    upstream.headers.forEach((value, key) => {
        if (key === 'content-length' || key === 'transfer-encoding' || key === 'connection') {
            return;
        }
        res.setHeader(key, value);
    });

    const setCookies = (upstream.headers as any).getSetCookie?.();
    if (Array.isArray(setCookies) && setCookies.length > 0) {
        res.setHeader('Set-Cookie', setCookies);
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
}

async function proxyLightningMediatorRequest(
    req: express.Request,
    res: express.Response,
    upstreamPath: string
) {
    const upstreamUrl = new URL(upstreamPath, config.lightningMediatorURL);

    const headers = new Headers();
    const contentType = req.headers['content-type'];
    if (contentType) {
        headers.set('content-type', Array.isArray(contentType) ? contentType[0] as string : contentType);
    }

    const accept = req.headers.accept;
    if (accept) {
        headers.set('accept', Array.isArray(accept) ? accept[0] as string : accept);
    }

    const body = buildProxyBody(req);
    if (body && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
    }
    if (config.adminApiKey) {
        headers.set(ARCHON_ADMIN_HEADER, config.adminApiKey);
    }

    const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
    });

    res.status(upstream.status);

    upstream.headers.forEach((value, key) => {
        if (key === 'content-length' || key === 'transfer-encoding' || key === 'connection') {
            return;
        }
        res.setHeader(key, value);
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
}

async function main() {
    const app = express();
    const v1router = express.Router();
    const defaultCors = cors();
    const heraldCors = cors({
        origin: true,
        credentials: true,
    });

    // Middleware
    app.use((req, res, next) => {
        if (req.path.startsWith('/names') || req.path.startsWith('/.well-known')) {
            return heraldCors(req, res, next);
        }

        return defaultCors(req, res, next);
    });

    if (process.env.NODE_ENV === 'production') {
        app.use((pinoHttp as any)({ logger }));
    } else {
        app.use(morgan('dev'));
    }

    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: false, limit: '10mb' }));
    app.use(express.text({ limit: '10mb' }));
    // Skip body buffering for streaming routes — they read req directly
    const rawParser = express.raw({ type: 'application/octet-stream', limit: '10mb' });
    app.use((req, res, next) => {
        if (req.path === '/api/v1/ipfs/stream' && req.method === 'POST') {
            return next();
        }
        rawParser(req, res, next);
    });

    // Metrics tracking middleware
    app.use((req, res, next) => {
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            const duration = Number(process.hrtime.bigint() - start) / 1e9;
            const route = normalizePath(req.path);
            httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
            httpRequestDuration.observe({ method: req.method, route }, duration);
        });
        next();
    });

    // Validate required config
    if (!config.macaroonSecret || config.macaroonSecret.length < 32) {
        logger.error('ARCHON_DRAWBRIDGE_MACAROON_SECRET must be set (32+ characters)');
        process.exit(1);
    }

    // Connect to upstream Gatekeeper
    logger.info(`Connecting to Gatekeeper at ${config.gatekeeperURL}`);
    const gatekeeper = await GatekeeperClient.create({
        url: config.gatekeeperURL,
        waitUntilReady: true,
        chatty: true,
        becomeChattyAfter: 5,
    });
    logger.info('Gatekeeper connection established');

    // Initialize store
    const store: DrawbridgeStore = new RedisStore(config.redisUrl);

    // Initialize L402 options
    const l402Options: L402Options = {
        rootSecret: config.macaroonSecret,
        location: `http://localhost:${config.port}`,
        lightningMediatorUrl: config.lightningMediatorURL,
        defaults: {
            amountSat: config.defaultPriceSats,
            expirySeconds: config.invoiceExpiry,
            scopes: ['resolveDID', 'getDIDs', 'listRegistries', 'searchDIDs'],
        },
        rateLimitRequests: config.rateLimitMax,
        rateLimitWindowSeconds: config.rateLimitWindow,
        store,
        pricing: loadPricingFromEnv(),
        hooks: {
            onChallenge: (didKnown) => l402ChallengesTotal.inc({ did_known: String(didKnown) }),
            onMacaroonVerification: (result) => l402VerificationsTotal.inc({ result }),
        },
        logger,
    };

    // Auth middleware (subscription + L402)
    const authMiddleware = config.l402Enabled
        ? createAuthMiddleware(l402Options)
        : [] as express.RequestHandler[];

    if (!config.l402Enabled) {
        logger.info('L402 paywall disabled (ARCHON_DRAWBRIDGE_L402_ENABLED=false)');
    }

    // --- Unprotected routes ---

    v1router.get('/ready', async (_req, res) => {
        try {
            const upstream = await gatekeeper.isReady();
            res.json(upstream);
        } catch {
            res.json(false);
        }
    });

    v1router.get('/version', (_req, res) => {
        res.json({ version: serviceVersion, commit: serviceCommit });
    });

    v1router.get('/status', async (_req, res) => {
        try {
            const upstreamStatus = await gatekeeper.getStatus();
            res.json({
                service: 'drawbridge',
                upstream: upstreamStatus,
                uptime: process.uptime(),
                memoryUsage: process.memoryUsage(),
            });
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper status error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    // --- L402 management routes ---

    v1router.post('/l402/pay', async (req, res) => {
        await handlePaymentCompletion(l402Options, req, res);
    });

    v1router.get('/l402/status', requireAdminKey, async (req, res) => {
        await handleL402Status(l402Options, req, res);
    });

    v1router.post('/l402/revoke', requireAdminKey, async (req, res) => {
        await handleRevokeMacaroon(l402Options, req, res);
    });

    v1router.get('/l402/payments/:did', requireAdminKey, async (req, res) => {
        await handleGetPayments(l402Options, req, res);
    });

    // --- Gatekeeper proxy routes (auth required) ---

    v1router.get('/registries', ...authMiddleware, async (_req, res) => {
        try {
            const result = await gatekeeper.listRegistries();
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/did', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.createDID(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/did/generate', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.generateDID(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.get('/did/:did', ...authMiddleware, async (req, res) => {
        try {
            const options: any = {};
            if (req.query.versionTime) options.versionTime = req.query.versionTime;
            if (req.query.versionSequence) options.versionSequence = Number(req.query.versionSequence);
            if (req.query.confirm) options.confirm = req.query.confirm === 'true';
            if (req.query.verify) options.verify = req.query.verify === 'true';

            const result = await gatekeeper.resolveDID(req.params.did as string, Object.keys(options).length ? options : undefined);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/dids', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.getDIDs(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/dids/export', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.exportDIDs(req.body?.dids);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    // IPFS routes

    v1router.post('/ipfs/json', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.addJSON(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.get('/ipfs/json/:cid', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.getJSON(req.params.cid as string);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/ipfs/text', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.addText(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.get('/ipfs/text/:cid', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.getText(req.params.cid as string);
            res.send(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/ipfs/data', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.addData(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.get('/ipfs/data/:cid', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.getData(req.params.cid as string);
            if (result) {
                res.set('Content-Type', 'application/octet-stream');
                res.send(result);
            } else {
                res.status(404).send('Not found');
            }
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    // IPFS streaming routes (no body-size limit)

    v1router.post('/ipfs/stream', ...authMiddleware, async (req, res) => {
        try {
            const cid = await gatekeeper.addDataStream(req);
            res.send(cid);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.get('/ipfs/stream/:cid', ...authMiddleware, async (req, res) => {
        try {
            const contentType = (req.query.type as string) || 'application/octet-stream';
            const filename = req.query.filename as string;
            if (filename) {
                res.attachment(filename);
            }
            res.setHeader('Content-Type', contentType);
            for await (const chunk of gatekeeper.getDataStream(req.params.cid as string)) {
                res.write(chunk);
            }
            res.end();
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    // Block routes

    v1router.get('/block/:registry/latest', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.getBlock(req.params.registry as string);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.get('/block/:registry/:blockId', ...authMiddleware, async (req, res) => {
        try {
            const blockId = /^\d+$/.test(req.params.blockId as string) ? parseInt(req.params.blockId as string) : req.params.blockId as string;
            const result = await gatekeeper.getBlock(req.params.registry as string, blockId);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    // Search routes

    v1router.get('/search', ...authMiddleware, async (req, res) => {
        try {
            const q = (Array.isArray(req.query.q) ? req.query.q[0] : req.query.q) as string;
            const result = await gatekeeper.searchDocs(q);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/query', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.queryDocs(req.body?.where || req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    // --- Lightning routes proxied to lightning-mediator ---

    v1router.use('/lightning', async (req, res) => {
        try {
            await proxyLightningMediatorRequest(req, res, req.originalUrl);
        } catch (error: any) {
            logger.error({ err: error, path: req.originalUrl }, 'Lightning mediator proxy error');
            res.status(502).json({ error: 'Upstream lightning mediator error' });
        }
    });

    // Public invoice endpoint — no auth required
    app.get('/invoice/:did', async (req, res) => {
        try {
            await proxyLightningMediatorRequest(req, res, req.originalUrl);
        } catch (error: any) {
            logger.error({ err: error, path: req.originalUrl }, 'Lightning mediator public invoice proxy error');
            res.status(502).json({ error: 'Upstream lightning mediator error' });
        }
    });

    app.use('/.well-known', async (req, res) => {
        try {
            await proxyHeraldRequest(req, res, '');
        } catch (error: any) {
            logger.error({ err: error, path: req.originalUrl }, 'Herald proxy error');
            res.status(502).json({ error: 'Upstream herald error' });
        }
    });

    app.use('/names', async (req, res) => {
        try {
            await proxyHeraldRequest(req, res);
        } catch (error: any) {
            logger.error({ err: error, path: req.originalUrl }, 'Herald proxy error');
            res.status(502).json({ error: 'Upstream herald error' });
        }
    });

    // Mount router
    app.use('/api/v1', v1router);

    // Prometheus metrics endpoint
    app.get('/metrics', async (_req, res) => {
        try {
            res.set('Content-Type', register.contentType);
            res.end(await register.metrics());
        } catch (error: any) {
            res.status(500).end(error.toString());
        }
    });

    // Start server
    const server = app.listen(config.port, config.bindAddress, () => {
        logger.info(`Drawbridge v${serviceVersion} (${serviceCommit}) running on ${config.bindAddress}:${config.port}`);
        logger.info(`Proxying to Gatekeeper at ${config.gatekeeperURL}`);
    });

    // Graceful shutdown
    const shutdown = async () => {
        logger.info('Shutting down Drawbridge...');
        server.close(async () => {
            try {
                await (store as any).disconnect?.();
                logger.info('Redis connection closed');
            } catch { /* ignore */ }
            logger.info('Server closed');
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error) => {
    logger.error('Failed to start Drawbridge:', error);
    process.exit(1);
});
