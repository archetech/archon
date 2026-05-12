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
import { createZcashClient } from './zcash-rpc.js';
import {
    setupTransparentWallet,
    getBalance,
    getReceiveAddress,
    getTransactions,
    getUtxos,
    estimateFee,
    getWalletStatus,
    sendZec,
    anchorData,
    getTransaction,
    bumpTransactionFee,
} from './zcash-wallet.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

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

const walletBalanceConfirmed = new Gauge({
    name: 'wallet_balance_confirmed_zec',
    help: 'Confirmed wallet balance in ZEC',
});

const walletBalanceUnconfirmed = new Gauge({
    name: 'wallet_balance_unconfirmed_zec',
    help: 'Unconfirmed wallet balance in ZEC',
});

const walletUtxoCount = new Gauge({
    name: 'wallet_utxo_count',
    help: 'Number of unspent transaction outputs',
});

const walletFeeEstimate = new Gauge({
    name: 'wallet_fee_estimate_zat_per_vb',
    help: 'Current fee estimate in zats/vB',
});

const walletSendsTotal = new Counter({
    name: 'wallet_sends_total',
    help: 'Total send operations',
    labelNames: ['status'],
});

const walletSetupStatus = new Gauge({
    name: 'wallet_setup_status',
    help: 'Transparent wallet initialization status (1=ready, 0=not ready)',
});

const walletBlockHeight = new Gauge({
    name: 'wallet_zebra_block_height',
    help: 'Current block height from Zebra',
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

const ARCHON_ADMIN_HEADER = 'x-archon-admin-key';

function normalizePath(path: string): string {
    return path.replace(/\/wallet\/transaction\/[^/]+/g, '/wallet/transaction/:txid');
}

export function requireAdminKey(req: express.Request, res: express.Response, next: express.NextFunction) {
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

export async function fetchMnemonic(): Promise<string> {
    const headers: Record<string, string> = {};
    if (config.adminApiKey) {
        headers[ARCHON_ADMIN_HEADER] = config.adminApiKey;
    }
    const response = await axios.get(`${config.keymasterURL}/api/v1/wallet/mnemonic`, { headers });
    return response.data.mnemonic;
}

async function main() {
    const app = express();
    const v1router = express.Router();
    const zecClient = createZcashClient();

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

    const maxRetries = 12;
    let walletReady = false;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const mnemonic = await fetchMnemonic();
            const result = await setupTransparentWallet(zecClient, mnemonic, config.network);
            logger.info({ ...result }, 'Transparent Zcash wallet ready');
            walletReady = true;
            break;
        } catch (error: any) {
            if (attempt === maxRetries) {
                logger.error({ err: error }, `Wallet setup failed after ${maxRetries} attempts, starting without wallet`);
                break;
            }
            logger.warn(`Wallet setup attempt ${attempt}/${maxRetries} failed: ${error.message}. Retrying in 10s...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    if (!walletReady) {
        logger.warn('Wallet service starting without an active transparent wallet');
    }
    walletSetupStatus.set(walletReady ? 1 : 0);

    async function updateMetrics() {
        try {
            const mnemonic = await fetchMnemonic();
            const balance = await getBalance(zecClient, mnemonic, config.network);
            walletBalanceConfirmed.set(balance.balance);
            walletBalanceUnconfirmed.set(balance.unconfirmed_balance);

            const utxos = await getUtxos(zecClient, mnemonic, config.network, 0);
            walletUtxoCount.set(utxos.length);

            const fee = await estimateFee(zecClient);
            if (fee.feerate) {
                walletFeeEstimate.set((fee.feerate / 1000) * 1e8);
            }

            const blockHeight = await zecClient.command<number>('getblockcount');
            walletBlockHeight.set(blockHeight);
        } catch (error: any) {
            logger.debug({ err: error }, 'Metrics update failed');
        }
    }

    if (walletReady) {
        updateMetrics();
        setInterval(updateMetrics, 60_000);
    }

    v1router.get('/wallet/version', (_req, res) => {
        res.json({ version: serviceVersion, commit: serviceCommit });
    });

    v1router.post('/wallet/setup', requireAdminKey, async (_req, res) => {
        try {
            const mnemonic = await fetchMnemonic();
            const result = await setupTransparentWallet(zecClient, mnemonic, config.network);
            walletSetupStatus.set(1);
            res.json({ ok: true, network: config.network, ...result });
        } catch (error: any) {
            logger.error({ err: error }, 'Wallet setup failed');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/balance', requireAdminKey, async (_req, res) => {
        try {
            const mnemonic = await fetchMnemonic();
            const balance = await getBalance(zecClient, mnemonic, config.network);
            res.json({ ...balance, network: config.network });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get balance');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/address', requireAdminKey, async (_req, res) => {
        try {
            const mnemonic = await fetchMnemonic();
            const receiveAddress = await getReceiveAddress(zecClient, mnemonic, config.network);
            res.json({ address: receiveAddress, network: config.network });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get address');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/transactions', requireAdminKey, async (req, res) => {
        try {
            const count = req.query.count ? parseInt(req.query.count as string) : 10;
            const skip = req.query.skip ? parseInt(req.query.skip as string) : 0;
            if (!Number.isFinite(count) || count < 1) {
                res.status(400).json({ error: 'Invalid "count" parameter' });
                return;
            }
            if (!Number.isFinite(skip) || skip < 0) {
                res.status(400).json({ error: 'Invalid "skip" parameter' });
                return;
            }

            const mnemonic = await fetchMnemonic();
            const transactions = await getTransactions(zecClient, mnemonic, config.network, count, skip);
            res.json({ transactions, network: config.network });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get transactions');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/utxos', requireAdminKey, async (req, res) => {
        try {
            const minconf = req.query.minconf ? parseInt(req.query.minconf as string) : 1;
            if (!Number.isFinite(minconf) || minconf < 0) {
                res.status(400).json({ error: 'Invalid "minconf" parameter' });
                return;
            }

            const mnemonic = await fetchMnemonic();
            const utxos = await getUtxos(zecClient, mnemonic, config.network, minconf);
            res.json({ utxos, network: config.network });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get UTXOs');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/fee-estimate', requireAdminKey, async (req, res) => {
        try {
            const blocks = req.query.blocks ? parseInt(req.query.blocks as string) : undefined;
            if (blocks !== undefined && (!Number.isFinite(blocks) || blocks < 1)) {
                res.status(400).json({ error: 'Invalid "blocks" parameter' });
                return;
            }

            const estimate = await estimateFee(zecClient, blocks);
            res.json({ ...estimate, network: config.network });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to estimate fee');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/info', requireAdminKey, async (_req, res) => {
        try {
            const mnemonic = await fetchMnemonic();
            const status = await getWalletStatus(zecClient, mnemonic, config.network);
            res.json(status);
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get wallet info');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.post('/wallet/send', requireAdminKey, async (req, res) => {
        try {
            const { to, amount, feeRate, subtractFee } = req.body;
            if (!to || typeof to !== 'string') {
                res.status(400).json({ error: 'Missing or invalid "to" address' });
                return;
            }
            if (!Number.isFinite(amount) || amount <= 0) {
                res.status(400).json({ error: 'Missing or invalid "amount" (ZEC)' });
                return;
            }

            const mnemonic = await fetchMnemonic();
            const result = await sendZec(zecClient, mnemonic, config.network, to, amount, feeRate, subtractFee);
            walletSendsTotal.inc({ status: 'success' });
            res.json({ ...result, network: config.network });
        } catch (error: any) {
            walletSendsTotal.inc({ status: 'failed' });
            logger.error({ err: error }, 'Failed to send ZEC');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.post('/wallet/anchor', requireAdminKey, async (req, res) => {
        try {
            const { data, feeRate } = req.body;
            if (!data || typeof data !== 'string') {
                res.status(400).json({ error: 'Missing or invalid "data" string' });
                return;
            }
            if (Buffer.from(data, 'utf8').length > 80) {
                res.status(400).json({ error: 'OP_RETURN data exceeds 80 byte limit' });
                return;
            }

            const mnemonic = await fetchMnemonic();
            const result = await anchorData(zecClient, mnemonic, config.network, data, feeRate);
            walletSendsTotal.inc({ status: 'success' });
            res.json({ ...result, network: config.network });
        } catch (error: any) {
            walletSendsTotal.inc({ status: 'failed' });
            logger.error({ err: error }, 'Failed to anchor data');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/transaction/:txid', requireAdminKey, async (req, res) => {
        try {
            const txid = Array.isArray(req.params.txid) ? req.params.txid[0] : req.params.txid;
            const tx = await getTransaction(zecClient, txid);
            res.json({ ...tx, network: config.network });
        } catch (error: any) {
            if (error.message?.includes('No such mempool or blockchain transaction') || error.message?.includes('not found')) {
                res.status(404).json({ error: 'Transaction not found in wallet' });
                return;
            }
            logger.error({ err: error }, 'Failed to get transaction');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.post('/wallet/bump-fee', requireAdminKey, async (_req, res) => {
        try {
            await bumpTransactionFee();
        } catch (error: any) {
            logger.warn({ err: error }, 'Fee bump requested but unsupported');
            res.status(501).json({ error: error.message });
        }
    });

    app.use('/api/v1', v1router);

    const server = app.listen(config.port, () => {
        logger.info(`Zcash wallet v${serviceVersion} (${serviceCommit}) running on port ${config.port}`);
        logger.info(`Network: ${config.network}`);
        logger.info(`Zebra RPC: ${config.zecHost}:${config.zecPort}`);
        logger.info(`Keymaster: ${config.keymasterURL}`);
    });

    const metricsApp = express();
    metricsApp.get('/metrics', async (_req, res) => {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    });
    metricsApp.listen(config.metricsPort, () => {
        logger.info(`Metrics server on port ${config.metricsPort}`);
    });

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
