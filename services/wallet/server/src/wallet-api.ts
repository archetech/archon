import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { register, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { readFile } from 'fs/promises';
import { timingSafeEqual } from 'crypto';
import axios from 'axios';
import config from './config.js';
import {
    createBtcClient,
    setupWatchOnlyWallet,
    getBalance,
    getReceiveAddress,
    getTransactions,
    getUtxos,
    estimateFee,
    getWalletStatus,
    sendBtc,
} from './btc-wallet.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Prometheus metrics
collectDefaultMetrics();

const httpRequestsTotal = new Counter({
    name: 'wallet_http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
});

const httpRequestDuration = new Histogram({
    name: 'wallet_http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
});

const walletVersionInfo = new Gauge({
    name: 'wallet_version_info',
    help: 'Service version information',
    labelNames: ['version', 'commit'],
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

async function fetchMnemonic(): Promise<string> {
    const headers: Record<string, string> = {};
    if (config.adminApiKey) {
        headers['Authorization'] = `Bearer ${config.adminApiKey}`;
    }
    const response = await axios.get(`${config.keymasterURL}/api/v1/wallet/mnemonic`, { headers });
    return response.data.mnemonic;
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

    app.use(express.json());

    // Metrics tracking
    app.use((req, res, next) => {
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            const duration = Number(process.hrtime.bigint() - start) / 1e9;
            httpRequestsTotal.inc({ method: req.method, route: req.path, status: res.statusCode });
            httpRequestDuration.observe({ method: req.method, route: req.path }, duration);
        });
        next();
    });

    const btcClient = createBtcClient();

    // Health / version
    v1router.get('/wallet/version', (_req, res) => {
        res.json({ version: serviceVersion, commit: serviceCommit });
    });

    // Setup: create watch-only wallet and import descriptors
    v1router.post('/wallet/setup', requireAdminKey, async (_req, res) => {
        try {
            const mnemonic = await fetchMnemonic();
            const result = await setupWatchOnlyWallet(btcClient, mnemonic, config.network);
            res.json({ ok: true, network: config.network, ...result });
        } catch (error: any) {
            logger.error({ err: error }, 'Wallet setup failed');
            res.status(500).json({ error: error.message });
        }
    });

    // Balance
    v1router.get('/wallet/balance', requireAdminKey, async (_req, res) => {
        try {
            const balance = await getBalance(btcClient);
            res.json({ ...balance, network: config.network });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get balance');
            res.status(500).json({ error: error.message });
        }
    });

    // Receive address
    v1router.get('/wallet/address', requireAdminKey, async (_req, res) => {
        try {
            const address = await getReceiveAddress(btcClient);
            res.json({ address, network: config.network });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get address');
            res.status(500).json({ error: error.message });
        }
    });

    // Transaction history
    v1router.get('/wallet/transactions', requireAdminKey, async (req, res) => {
        try {
            const count = req.query.count ? parseInt(req.query.count as string) : 10;
            const skip = req.query.skip ? parseInt(req.query.skip as string) : 0;
            const transactions = await getTransactions(btcClient, count, skip);
            res.json({ transactions, network: config.network });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get transactions');
            res.status(500).json({ error: error.message });
        }
    });

    // UTXOs
    v1router.get('/wallet/utxos', requireAdminKey, async (req, res) => {
        try {
            const minconf = req.query.minconf ? parseInt(req.query.minconf as string) : 1;
            const utxos = await getUtxos(btcClient, minconf);
            res.json({ utxos, network: config.network });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get UTXOs');
            res.status(500).json({ error: error.message });
        }
    });

    // Fee estimate
    v1router.get('/wallet/fee-estimate', requireAdminKey, async (req, res) => {
        try {
            const blocks = req.query.blocks ? parseInt(req.query.blocks as string) : undefined;
            const estimate = await estimateFee(btcClient, blocks);
            res.json({ ...estimate, network: config.network });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to estimate fee');
            res.status(500).json({ error: error.message });
        }
    });

    // Wallet info / status
    v1router.get('/wallet/info', requireAdminKey, async (_req, res) => {
        try {
            const status = await getWalletStatus(btcClient);
            res.json(status);
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get wallet info');
            res.status(500).json({ error: error.message });
        }
    });

    // Send BTC
    v1router.post('/wallet/send', requireAdminKey, async (req, res) => {
        try {
            const { to, amount, feeRate, subtractFee } = req.body;

            if (!to || typeof to !== 'string') {
                res.status(400).json({ error: 'Missing or invalid "to" address' });
                return;
            }

            if (!amount || typeof amount !== 'number' || amount <= 0) {
                res.status(400).json({ error: 'Missing or invalid "amount" (BTC)' });
                return;
            }

            const mnemonic = await fetchMnemonic();
            const result = await sendBtc(btcClient, mnemonic, config.network, to, amount, feeRate, subtractFee);
            res.json({ ...result, network: config.network });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to send BTC');
            res.status(500).json({ error: error.message });
        }
    });

    // Mount routes
    app.use('/api/v1', v1router);

    // Start API server
    const server = app.listen(config.port, () => {
        logger.info(`Wallet v${serviceVersion} (${serviceCommit}) running on port ${config.port}`);
        logger.info(`Network: ${config.network}`);
        logger.info(`Bitcoin RPC: ${config.btcHost}:${config.btcPort}`);
        logger.info(`Keymaster: ${config.keymasterURL}`);
    });

    // Metrics server
    const metricsApp = express();
    metricsApp.get('/metrics', async (_req, res) => {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    });
    metricsApp.listen(config.metricsPort, () => {
        logger.info(`Metrics server on port ${config.metricsPort}`);
    });

    // Graceful shutdown
    const shutdown = async () => {
        logger.info('Shutting down wallet service...');
        server.close(() => {
            logger.info('Server closed');
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error) => {
    logger.error('Failed to start wallet service:', error);
    process.exit(1);
});
