import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { register, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { readFile } from 'fs/promises';
import { pathToFileURL } from 'url';
import config from './config.js';
import { requireAdminKeyFor } from './auth.js';
import { getPaymentInfo, pinCid } from './filecoin-pin.js';

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
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 30, 120],
});

const walletVersionInfo = new Gauge({
    name: 'wallet_version_info',
    help: 'Service version information',
    labelNames: ['version', 'commit'],
});

const pinsTotal = new Counter({
    name: 'filecoin_wallet_pins_total',
    help: 'Total pin operations',
    labelNames: ['status'],
});

let serviceVersion = 'unknown';
const serviceCommit = (process.env.GIT_COMMIT || 'unknown').slice(0, 7);

readFile(new URL('../package.json', import.meta.url), 'utf-8').then(data => {
    const pkg = JSON.parse(data);
    serviceVersion = pkg.version;
    walletVersionInfo.set({ version: serviceVersion, commit: serviceCommit }, 1);
}).catch(() => {
    walletVersionInfo.set({ version: 'unknown', commit: serviceCommit }, 1);
});

function normalizePath(path: string): string {
    return path;
}

export function requireAdminKey(req: express.Request, res: express.Response, next: express.NextFunction): void {
    return requireAdminKeyFor(config.adminApiKey)(req, res, next);
}

async function main(): Promise<void> {
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
            const route = normalizePath(req.path);
            httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
            httpRequestDuration.observe({ method: req.method, route }, duration);
        });
        next();
    });

    v1router.use(requireAdminKey);

    v1router.get('/wallet/version', (_req, res) => {
        res.json({
            version: serviceVersion,
            commit: serviceCommit,
            network: config.network,
            ipfsApiUrl: config.ipfsApiUrl,
        });
    });

    v1router.get('/wallet/balance', async (_req, res) => {
        try {
            res.json(await getPaymentInfo());
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get Filecoin payment info');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.post('/wallet/pin', async (req, res) => {
        try {
            const { cid, fingerprint, registry } = req.body;

            if (!cid || typeof cid !== 'string') {
                res.status(400).json({ error: 'Missing or invalid "cid"' });
                return;
            }
            if (fingerprint !== undefined && typeof fingerprint !== 'string') {
                res.status(400).json({ error: 'Invalid "fingerprint"' });
                return;
            }
            if (registry !== undefined && typeof registry !== 'string') {
                res.status(400).json({ error: 'Invalid "registry"' });
                return;
            }

            const pin = await pinCid(cid, fingerprint, registry);
            pinsTotal.inc({ status: 'pinned' });
            res.json(pin);
        } catch (error: any) {
            pinsTotal.inc({ status: 'failed' });
            logger.error({ err: error }, 'Failed to pin CID to Filecoin');
            res.status(500).json({ error: error.message });
        }
    });

    app.use('/api/v1', v1router);

    const server = app.listen(config.port, () => {
        logger.info(`Filecoin wallet v${serviceVersion} on port ${config.port} (${config.network})`);
    });

    const metricsApp = express();
    metricsApp.get('/health', (_req, res) => {
        res.json({ ok: true });
    });
    metricsApp.get('/metrics', async (_req, res) => {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    });
    metricsApp.listen(config.metricsPort, () => {
        logger.info(`Metrics server listening on port ${config.metricsPort}`);
    });

    const shutdown = () => {
        logger.info('Shutting down...');
        server.close(() => process.exit(0));
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        logger.error({ err: error }, 'Failed to start Filecoin wallet');
        process.exit(1);
    });
}
