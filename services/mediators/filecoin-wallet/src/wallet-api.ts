import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { register, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
import { timingSafeEqual } from 'crypto';
import { readFile } from 'fs/promises';
import config from './config.js';
import { pinCid, getPinStatus, listPins, removePin, getPaymentInfo } from './filecoin-pin.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

collectDefaultMetrics();

const httpRequestsTotal = new Counter({
    name: 'filecoin_wallet_http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
});

const httpRequestDuration = new Histogram({
    name: 'filecoin_wallet_http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
});

const pinsTotal = new Counter({
    name: 'filecoin_wallet_pins_total',
    help: 'Total pin operations',
    labelNames: ['status'],
});

const ARCHON_ADMIN_HEADER = 'x-archon-admin-key';

let serviceVersion = 'unknown';
readFile(new URL('../package.json', import.meta.url), 'utf-8').then(data => {
    serviceVersion = JSON.parse(data).version;
}).catch(() => {});

function requireAdminKey(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!config.adminApiKey) {
        res.status(403).json({ error: 'Admin API key not configured' });
        return;
    }

    const key = req.headers[ARCHON_ADMIN_HEADER];
    const keyStr = typeof key === 'string' ? key : Array.isArray(key) ? key[0] : null;

    if (!keyStr) {
        res.status(401).json({ error: 'Admin API key required' });
        return;
    }

    const keyBuf = Buffer.from(keyStr);
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

    app.use(cors());

    if (process.env.NODE_ENV === 'production') {
        app.use((pinoHttp as any)({ logger }));
    } else {
        app.use(morgan('dev'));
    }

    app.use(express.json());

    app.use((req, res, next) => {
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            const duration = Number(process.hrtime.bigint() - start) / 1e9;
            httpRequestsTotal.inc({ method: req.method, route: req.path, status: res.statusCode });
            httpRequestDuration.observe({ method: req.method, route: req.path }, duration);
        });
        next();
    });

    v1router.get('/wallet/version', (_req, res) => {
        res.json({
            version: serviceVersion,
            network: config.network,
            ipfsApiUrl: config.ipfsApiUrl,
        });
    });

    // Filecoin payment/balance info
    v1router.get('/wallet/balance', requireAdminKey, async (_req, res) => {
        try {
            const info = await getPaymentInfo();
            res.json(info);
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get payment info');
            res.status(500).json({ error: error.message });
        }
    });

    // Pin an Archon operation CID to Filecoin (no admin key — user-facing)
    v1router.post('/wallet/anchor', async (req, res) => {
        try {
            const { cid, did, name } = req.body;

            if (!cid || typeof cid !== 'string') {
                res.status(400).json({ error: 'Missing or invalid "cid"' });
                return;
            }
            if (!did || typeof did !== 'string') {
                res.status(400).json({ error: 'Missing or invalid "did"' });
                return;
            }

            const pin = await pinCid(cid, did, name);
            pinsTotal.inc({ status: 'queued' });
            res.json({ requestid: pin.requestid, status: pin.status, cid, did });
        } catch (error: any) {
            pinsTotal.inc({ status: 'failed' });
            logger.error({ err: error }, 'Failed to initiate pin');
            res.status(500).json({ error: error.message });
        }
    });

    // Get pin status by request ID (no admin key — user-facing)
    v1router.get('/wallet/pin/:requestid', async (req, res) => {
        const pin = getPinStatus(req.params.requestid);
        if (!pin) {
            res.status(404).json({ error: 'Pin not found' });
            return;
        }
        res.json(pin);
    });

    // List all pins (optionally filtered by status) (no admin key — user-facing)
    v1router.get('/wallet/pins', async (req, res) => {
        const status = req.query.status as any;
        const pins = listPins(status);
        res.json({ count: pins.length, results: pins });
    });

    // Remove a pin record (does not unpin from Filecoin storage)
    v1router.delete('/wallet/pin/:requestid', requireAdminKey, async (req, res) => {
        const removed = removePin(req.params.requestid);
        if (!removed) {
            res.status(404).json({ error: 'Pin not found' });
            return;
        }
        res.json({ ok: true });
    });

    app.use('/api/v1', v1router);

    const server = app.listen(config.port, () => {
        logger.info(`Filecoin wallet v${serviceVersion} on port ${config.port} (${config.network})`);
        logger.info(`IPFS API: ${config.ipfsApiUrl}`);
    });

    const metricsApp = express();
    metricsApp.get('/metrics', async (_req, res) => {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    });
    metricsApp.listen(config.metricsPort, () => {
        logger.info(`Metrics on port ${config.metricsPort}`);
    });

    const shutdown = () => {
        logger.info('Shutting down...');
        server.close(() => process.exit(0));
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(error => {
    logger.error('Failed to start filecoin wallet:', error);
    process.exit(1);
});
