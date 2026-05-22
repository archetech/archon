import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { register, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { readFile } from 'fs/promises';
import { timingSafeEqual, createHash } from 'crypto';
import axios from 'axios';
import {
    Connection,
    Finality,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
} from '@solana/web3.js';
import config from './config.js';
import { deriveKeypair } from './derivation.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const ARCHON_ADMIN_HEADER = 'x-archon-admin-key';
const ARCHON_MEMO_PREFIX = 'ARCHON_BATCH_V1:';

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
    name: 'wallet_balance_confirmed_sol',
    help: 'Wallet balance in SOL',
});

const walletSendsTotal = new Counter({
    name: 'wallet_sends_total',
    help: 'Total send operations',
    labelNames: ['status'],
});

const walletSetupStatus = new Gauge({
    name: 'wallet_setup_status',
    help: 'Solana wallet initialization status (1=ready, 0=not ready)',
});

const walletSlotHeight = new Gauge({
    name: 'wallet_solana_slot_height',
    help: 'Current Solana slot height',
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

function lamportsToSol(lamports: number): number {
    return lamports / LAMPORTS_PER_SOL;
}

function transactionFinality(): Finality {
    return config.commitment === 'finalized' ? 'finalized' : 'confirmed';
}

function buildMemo(batchDid: string, batchHash: string, opCount: number): string {
    return `${ARCHON_MEMO_PREFIX}${JSON.stringify({ batchHash, batchDid, opCount })}`;
}

function defaultRegistryKeypair(): Keypair {
    const seed = createHash('sha256')
        .update('archon-solana-registry-signer-v1')
        .update(config.chain)
        .update(config.memoProgramId)
        .digest();
    return Keypair.fromSeed(seed);
}

async function getKeypair(): Promise<Keypair> {
    const mnemonic = await fetchMnemonic();
    return deriveKeypair(mnemonic, config.derivationPath);
}

async function main() {
    const app = express();
    const v1router = express.Router();
    const connection = new Connection(config.rpcUrl, config.commitment);
    const memoProgramId = new PublicKey(config.memoProgramId);
    const registryAddress = new PublicKey(config.registryAddress);
    const registrySigner = defaultRegistryKeypair();

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
            const keypair = await getKeypair();
            await connection.getVersion();
            logger.info({ address: keypair.publicKey.toBase58(), network: config.network }, 'Solana wallet ready');
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
            const keypair = await getKeypair();
            const [balance, slot] = await Promise.all([
                connection.getBalance(keypair.publicKey, config.commitment),
                connection.getSlot(config.commitment),
            ]);
            walletBalanceConfirmed.set(lamportsToSol(balance));
            walletSlotHeight.set(slot);
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
            const keypair = await getKeypair();
            walletSetupStatus.set(1);
            res.json({ ok: true, address: keypair.publicKey.toBase58(), network: config.network });
        } catch (error: any) {
            logger.error({ err: error }, 'Wallet setup failed');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/balance', requireAdminKey, async (_req, res) => {
        try {
            const keypair = await getKeypair();
            const balanceLamports = await connection.getBalance(keypair.publicKey, config.commitment);
            res.json({
                balance: lamportsToSol(balanceLamports),
                balanceLamports: balanceLamports.toString(),
                network: config.network,
            });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get balance');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/address', requireAdminKey, async (_req, res) => {
        try {
            const keypair = await getKeypair();
            res.json({ address: keypair.publicKey.toBase58(), network: config.network });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get address');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.get('/wallet/info', requireAdminKey, async (_req, res) => {
        try {
            const keypair = await getKeypair();
            const [balanceLamports, slot] = await Promise.all([
                connection.getBalance(keypair.publicKey, config.commitment),
                connection.getSlot(config.commitment),
            ]);
            res.json({
                address: keypair.publicKey.toBase58(),
                balance: lamportsToSol(balanceLamports),
                balanceLamports: balanceLamports.toString(),
                slot,
                network: config.network,
                derivationPath: config.derivationPath,
            });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get wallet info');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.post('/wallet/airdrop', requireAdminKey, async (req, res) => {
        try {
            if (config.network === 'mainnet-beta') {
                res.status(400).json({ error: 'Airdrop is not available on mainnet-beta' });
                return;
            }

            const keypair = await getKeypair();
            const sol = Number(req.body?.amount ?? 1);
            if (!Number.isFinite(sol) || sol <= 0) {
                res.status(400).json({ error: 'Missing or invalid "amount" (SOL)' });
                return;
            }

            const signature = await connection.requestAirdrop(keypair.publicKey, Math.floor(sol * LAMPORTS_PER_SOL));
            walletSendsTotal.inc({ status: 'success' });
            res.json({ txid: signature, signature, network: config.network });
        } catch (error: any) {
            walletSendsTotal.inc({ status: 'failed' });
            logger.error({ err: error }, 'Failed to request airdrop');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.post('/wallet/send', requireAdminKey, async (req, res) => {
        try {
            const { to, amount } = req.body;
            if (!to || typeof to !== 'string') {
                res.status(400).json({ error: 'Missing or invalid "to" address' });
                return;
            }
            const toPubkey = new PublicKey(to);
            if (!Number.isFinite(amount) || amount <= 0) {
                res.status(400).json({ error: 'Missing or invalid "amount" (SOL)' });
                return;
            }

            const keypair = await getKeypair();
            const transaction = new Transaction().add(SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey,
                lamports: Math.floor(Number(amount) * LAMPORTS_PER_SOL),
            }));
            const signature = await connection.sendTransaction(transaction, [keypair], { preflightCommitment: config.commitment });
            walletSendsTotal.inc({ status: 'success' });
            res.json({ txid: signature, signature, network: config.network });
        } catch (error: any) {
            walletSendsTotal.inc({ status: 'failed' });
            logger.error({ err: error }, 'Failed to send SOL');
            res.status(500).json({ error: error.message });
        }
    });

    v1router.post('/wallet/anchor', requireAdminKey, async (req, res) => {
        try {
            const { batchDid, batchHash, opCount } = req.body;
            if (!batchDid || typeof batchDid !== 'string' || !batchDid.startsWith('did:cid:')) {
                res.status(400).json({ error: 'Missing or invalid "batchDid"' });
                return;
            }
            const resolvedBatchHash = typeof batchHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(batchHash)
                ? batchHash
                : batchHashForDid(batchDid);
            const resolvedOpCount = Number.isInteger(opCount) && opCount >= 0 ? opCount : 0;
            const memo = buildMemo(batchDid, resolvedBatchHash, resolvedOpCount);
            if (Buffer.byteLength(memo, 'utf8') > 256) {
                res.status(400).json({ error: 'Archon memo exceeds 256 byte limit' });
                return;
            }

            const keypair = await getKeypair();
            const transaction = new Transaction().add(new TransactionInstruction({
                keys: [{ pubkey: registryAddress, isSigner: true, isWritable: false }],
                programId: memoProgramId,
                data: Buffer.from(memo, 'utf8'),
            }));
            const signature = await connection.sendTransaction(transaction, [keypair, registrySigner], { preflightCommitment: config.commitment });
            walletSendsTotal.inc({ status: 'success' });
            res.json({
                txid: signature,
                signature,
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
            const [status, transaction] = await Promise.all([
                connection.getSignatureStatuses([txid], { searchTransactionHistory: true }),
                connection.getTransaction(txid, {
                    commitment: transactionFinality(),
                    maxSupportedTransactionVersion: 0,
                }),
            ]);
            const value = status.value[0];

            if (!value && !transaction) {
                res.status(404).json({ error: 'Transaction not found' });
                return;
            }

            const confirmed = value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized';
            res.json({
                txid,
                signature: txid,
                confirmations: confirmed ? 1 : 0,
                confirmationStatus: value?.confirmationStatus,
                err: value?.err,
                slot: value?.slot ?? transaction?.slot,
                blockTime: transaction?.blockTime,
                network: config.network,
            });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to get transaction');
            res.status(500).json({ error: error.message });
        }
    });

    app.use('/api/v1', v1router);

    const server = app.listen(config.port, () => {
        logger.info(`Solana wallet v${serviceVersion} (${serviceCommit}) running on port ${config.port}`);
        logger.info(`Network: ${config.network}`);
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
            process.exit(0);
        });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

main().catch(err => {
    logger.error({ err }, 'Fatal error');
    process.exit(1);
});
