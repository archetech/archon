import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { register, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
import { readFile } from 'fs/promises';
import { timingSafeEqual } from 'crypto';

import GatekeeperClient from '@didcid/gatekeeper/client';

import config from './config.js';
import { RedisStore } from './store.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { handlePaymentCompletion, handleRevokeMacaroon, handleL402Status, handleGetPayments } from './middleware/l402-auth.js';
import { loadPricingFromEnv } from './pricing.js';
import * as lnbits from './lnbits.js';
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

function normalizePath(path: string): string {
    return path
        .replace(/\/did\/did:[^/]+/, '/did/:did')
        .replace(/\/ipfs\/json\/[^/]+/, '/ipfs/json/:cid')
        .replace(/\/ipfs\/text\/[^/]+/, '/ipfs/text/:cid')
        .replace(/\/ipfs\/data\/[^/]+/, '/ipfs/data/:cid')
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

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Admin API key required' });
        return;
    }

    const key = authHeader.slice(7);
    const keyBuf = Buffer.from(key);
    const expectedBuf = Buffer.from(config.adminApiKey);

    if (keyBuf.length !== expectedBuf.length || !timingSafeEqual(keyBuf, expectedBuf)) {
        res.status(401).json({ error: 'Invalid admin API key' });
        return;
    }

    next();
}

async function main() {
    const app = express();
    const v1router = express.Router();

    // Middleware
    app.use(cors());

    if (process.env.NODE_ENV === 'production') {
        app.use((pinoHttp as any)({ logger }));
    } else {
        app.use(morgan('dev'));
    }

    app.use(express.json({ limit: '10mb' }));
    app.use(express.text({ limit: '10mb' }));
    app.use(express.raw({ type: 'application/octet-stream', limit: '10mb' }));

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

    if (!config.clnRune) {
        logger.warn('ARCHON_DRAWBRIDGE_CLN_RUNE is not set — Lightning invoices will fail until configured');
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
        cln: {
            restUrl: config.clnRestUrl,
            rune: config.clnRune,
        },
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
    const authMiddleware = createAuthMiddleware(l402Options);

    // --- Unprotected routes ---

    v1router.get('/ready', async (_req, res) => {
        try {
            const upstream = await gatekeeper.isReady();
            res.json(upstream);
        } catch {
            res.json(false);
        }
    });

    v1router.get('/version', async (_req, res) => {
        try {
            const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf-8'));
            res.json(pkg.version);
        } catch {
            res.json('unknown');
        }
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

    v1router.post('/dids/import', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.importDIDs(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/dids/remove', requireAdminKey, async (req, res) => {
        try {
            const result = await gatekeeper.removeDIDs(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/batch/export', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.exportBatch(req.body?.dids);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/batch/import', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.importBatch(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/batch/import/cids', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.importBatchByCids(req.body.cids, req.body.metadata);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.get('/queue/:registry', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.getQueue(req.params.registry as string);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/queue/:registry/clear', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.clearQueue(req.params.registry as string, req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/events/process', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.processEvents();
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

    v1router.post('/block/:registry', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.addBlock(req.params.registry as string, req.body);
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

    // Admin DB routes

    v1router.get('/db/reset', requireAdminKey, async (_req, res) => {
        try {
            const result = await gatekeeper.resetDb();
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.get('/db/verify', requireAdminKey, async (_req, res) => {
        try {
            const result = await gatekeeper.verifyDb();
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    // --- LNbits Lightning wallet routes ---

    v1router.post('/lightning/wallet', async (req, res) => {
        if (!config.lnbitsUrl) {
            res.status(503).json({ error: 'Lightning (LNbits) not configured' });
            return;
        }
        try {
            const { name } = req.body;
            const result = await lnbits.createWallet(config.lnbitsUrl, name || 'archon');
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'LNbits error');
            res.status(502).json({ error: error.message || 'LNbits error' });
        }
    });

    v1router.post('/lightning/balance', async (req, res) => {
        if (!config.lnbitsUrl) {
            res.status(503).json({ error: 'Lightning (LNbits) not configured' });
            return;
        }
        try {
            const { invoiceKey } = req.body;
            const balance = await lnbits.getBalance(config.lnbitsUrl, invoiceKey);
            res.json({ balance });
        } catch (error: any) {
            logger.error({ err: error }, 'LNbits error');
            res.status(502).json({ error: error.message || 'LNbits error' });
        }
    });

    v1router.post('/lightning/invoice', async (req, res) => {
        if (!config.lnbitsUrl) {
            res.status(503).json({ error: 'Lightning (LNbits) not configured' });
            return;
        }
        try {
            const { invoiceKey, amount, memo } = req.body;
            const result = await lnbits.createInvoice(config.lnbitsUrl, invoiceKey, amount, memo);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'LNbits error');
            res.status(502).json({ error: error.message || 'LNbits error' });
        }
    });

    v1router.post('/lightning/pay', async (req, res) => {
        if (!config.lnbitsUrl) {
            res.status(503).json({ error: 'Lightning (LNbits) not configured' });
            return;
        }
        try {
            const { adminKey, bolt11 } = req.body;
            const result = await lnbits.payInvoice(config.lnbitsUrl, adminKey, bolt11);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'LNbits error');
            res.status(502).json({ error: error.message || 'LNbits error' });
        }
    });

    v1router.post('/lightning/payment', async (req, res) => {
        if (!config.lnbitsUrl) {
            res.status(503).json({ error: 'Lightning (LNbits) not configured' });
            return;
        }
        try {
            const { invoiceKey, paymentHash } = req.body;
            const status = await lnbits.checkPayment(config.lnbitsUrl, invoiceKey, paymentHash);
            res.json({ ...status, paymentHash });
        } catch (error: any) {
            logger.error({ err: error }, 'LNbits error');
            res.status(502).json({ error: error.message || 'LNbits error' });
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
        logger.info(`Drawbridge running on ${config.bindAddress}:${config.port}`);
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
