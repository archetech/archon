import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { register, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { readFile } from 'fs/promises';
import { timingSafeEqual, createHash } from 'crypto';
import axios from 'axios';
import { Contract, JsonRpcProvider, formatEther, parseEther, isAddress } from 'ethers';
import config from './config.js';
import { deriveWallet } from './derivation.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const ARCHON_ADMIN_HEADER = 'x-archon-admin-key';

const ARCHON_REGISTRY_ABI = [
    'function anchorBatch(bytes32 batchHash, string batchDid, uint256 opCount)',
];

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
    name: 'wallet_balance_confirmed_eth',
    help: 'Wallet balance in ETH',
});

const walletGasPrice = new Gauge({
    name: 'wallet_fee_estimate_wei',
    help: 'Current gas price estimate in wei',
});

const walletSendsTotal = new Counter({
    name: 'wallet_sends_total',
    help: 'Total send operations',
    labelNames: ['status'],
});

const walletSetupStatus = new Gauge({
    name: 'wallet_setup_status',
    help: 'Ethereum wallet initialization status (1=ready, 0=not ready)',
});

const walletBlockHeight = new Gauge({
    name: 'wallet_eth_block_height',
    help: 'Current Ethereum block height',
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

function batchHashForDid(batchDid: string): string {
    return `0x${createHash('sha256').update(batchDid).digest('hex')}`;
}

async function getConnectedWallet(provider: JsonRpcProvider) {
    const mnemonic = await fetchMnemonic();
    return deriveWallet(mnemonic, config.derivationPath).connect(provider);
}

async function main() {
    const app = express();
    const v1router = express.Router();
    const provider = new JsonRpcProvider(config.rpcUrl, config.chainId);

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

    let walletReady = false;
    for (let attempt = 1; attempt <= 12; attempt++) {
        try {
            const wallet = await getConnectedWallet(provider);
            const network = await provider.getNetwork();
            if (Number(network.chainId) !== config.chainId) {
                throw new Error(`RPC chain ID ${network.chainId} does not match configured chain ID ${config.chainId}`);
            }
            logger.info({ address: wallet.address, network: config.network, chainId: config.chainId }, 'Ethereum wallet ready');
            walletReady = true;
            break;
        } catch (error: any) {
            if (attempt === 12) {
                logger.error({ err: error }, 'Wallet setup failed after retries, starting without wallet');
                break;
            }
            logger.warn(`Wallet setup attempt ${attempt}/12 failed: ${error.message}. Retrying in 10s...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    walletSetupStatus.set(walletReady ? 1 : 0);

    async function updateMetrics() {
        try {
            const wallet = await getConnectedWallet(provider);
            const [balance, feeData, blockHeight] = await Promise.all([
                provider.getBalance(wallet.address),
                provider.getFeeData(),
                provider.getBlockNumber(),
            ]);
            walletBalanceConfirmed.set(Number(formatEther(balance)));
            walletBlockHeight.set(blockHeight);
            if (feeData.gasPrice) {
                walletGasPrice.set(Number(feeData.gasPrice));
            }
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
            const wallet = await getConnectedWallet(provider);
            walletSetupStatus.set(1);
            res.json({ ok: true, address: wallet.address, network: config.network, chainId: config.chainId });
        } catch (error: any) {
            logger.error({ err: error }, 'Wallet setup failed');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/balance', requireAdminKey, async (_req, res) => {
        try {
            const wallet = await getConnectedWallet(provider);
            const balanceWei = await provider.getBalance(wallet.address);
            res.json({
                balance: Number(formatEther(balanceWei)),
                balanceWei: balanceWei.toString(),
                network: config.network,
                chainId: config.chainId,
            });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get balance');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/address', requireAdminKey, async (_req, res) => {
        try {
            const wallet = await getConnectedWallet(provider);
            res.json({ address: wallet.address, network: config.network, chainId: config.chainId });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get address');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/fee-estimate', requireAdminKey, async (_req, res) => {
        try {
            const feeData = await provider.getFeeData();
            res.json({
                gasPrice: feeData.gasPrice?.toString(),
                maxFeePerGas: feeData.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString(),
                network: config.network,
            });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to estimate fee');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/info', requireAdminKey, async (_req, res) => {
        try {
            const wallet = await getConnectedWallet(provider);
            const [balanceWei, nonce, blockHeight] = await Promise.all([
                provider.getBalance(wallet.address),
                provider.getTransactionCount(wallet.address, 'pending'),
                provider.getBlockNumber(),
            ]);
            res.json({
                address: wallet.address,
                balance: Number(formatEther(balanceWei)),
                balanceWei: balanceWei.toString(),
                nonce,
                blockHeight,
                network: config.network,
                chainId: config.chainId,
                derivationPath: config.derivationPath,
            });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get wallet info');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.post('/wallet/send', requireAdminKey, async (req, res) => {
        try {
            const { to, amount } = req.body;
            if (!to || typeof to !== 'string' || !isAddress(to)) {
                res.status(400).json({ error: 'Missing or invalid "to" address' });
                return;
            }
            if (!Number.isFinite(amount) || amount <= 0) {
                res.status(400).json({ error: 'Missing or invalid "amount" (ETH)' });
                return;
            }

            const wallet = await getConnectedWallet(provider);
            const tx = await wallet.sendTransaction({ to, value: parseEther(String(amount)) });
            walletSendsTotal.inc({ status: 'success' });
            res.json({ txid: tx.hash, hash: tx.hash, network: config.network });
        } catch (error: any) {
            walletSendsTotal.inc({ status: 'failed' });
            logger.error({ err: error }, 'Failed to send ETH');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.post('/wallet/anchor', requireAdminKey, async (req, res) => {
        try {
            const { contract, batchDid, batchHash, opCount } = req.body;
            if (!contract || typeof contract !== 'string' || !isAddress(contract)) {
                res.status(400).json({ error: 'Missing or invalid "contract" address' });
                return;
            }
            if (!batchDid || typeof batchDid !== 'string' || !batchDid.startsWith('did:cid:')) {
                res.status(400).json({ error: 'Missing or invalid "batchDid"' });
                return;
            }
            if (Buffer.from(batchDid, 'utf8').length > 128) {
                res.status(400).json({ error: 'batchDid exceeds 128 byte contract limit' });
                return;
            }

            const resolvedBatchHash = typeof batchHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(batchHash)
                ? batchHash
                : batchHashForDid(batchDid);
            const resolvedOpCount = Number.isInteger(opCount) && opCount >= 0 ? opCount : 0;

            const wallet = await getConnectedWallet(provider);
            const registry = new Contract(contract, ARCHON_REGISTRY_ABI, wallet);
            const tx = await registry.anchorBatch(resolvedBatchHash, batchDid, resolvedOpCount);
            walletSendsTotal.inc({ status: 'success' });
            res.json({
                txid: tx.hash,
                hash: tx.hash,
                batchHash: resolvedBatchHash,
                network: config.network,
            });
        } catch (error: any) {
            walletSendsTotal.inc({ status: 'failed' });
            logger.error({ err: error }, 'Failed to anchor batch');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/transaction/:txid', requireAdminKey, async (req, res) => {
        try {
            const txid = Array.isArray(req.params.txid) ? req.params.txid[0] : req.params.txid;
            const [tx, receipt, blockHeight] = await Promise.all([
                provider.getTransaction(txid),
                provider.getTransactionReceipt(txid),
                provider.getBlockNumber(),
            ]);

            if (!tx && !receipt) {
                res.status(404).json({ error: 'Transaction not found' });
                return;
            }

            const confirmations = receipt ? Math.max(0, blockHeight - receipt.blockNumber + 1) : 0;
            res.json({
                txid,
                hash: txid,
                confirmations,
                blockhash: receipt?.blockHash,
                blockNumber: receipt?.blockNumber,
                status: receipt?.status,
                network: config.network,
            });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get transaction');
            res.status(500).json({ error: error.message });
        }
    });

    app.use('/api/v1', v1router);

    const server = app.listen(config.port, () => {
        logger.info(`Ethereum wallet v${serviceVersion} (${serviceCommit}) running on port ${config.port}`);
        logger.info(`Network: ${config.network} (${config.chainId})`);
        logger.info(`RPC: ${config.rpcUrl}`);
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
