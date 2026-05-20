import CipherNode from '@didcid/cipher/node';
import GatekeeperClient from '@didcid/gatekeeper/client';
import KeymasterClient from '@didcid/keymaster/client';
import JsonFile from './db/jsonfile.js';
import JsonRedis from './db/redis.js';
import JsonMongo from './db/mongo.js';
import JsonSQLite from './db/sqlite.js';
import config from './config.js';
import { isValidDID } from '@didcid/ipfs/utils';
import { MediatorDb, MediatorDbInterface, DiscoveredItem } from './types.js';
import { DidRegistration } from '@didcid/gatekeeper/types';
import express from 'express';
import { readFile } from 'fs/promises';
import promClient from 'prom-client';
import axios from 'axios';
import { createHash } from 'crypto';
import { Interface, JsonRpcProvider, Log, isAddress } from 'ethers';

const REGISTRY = config.chain;
const READ_ONLY = config.exportInterval === 0;
const ARCHON_ADMIN_HEADER = 'X-Archon-Admin-Key';

const ARCHON_REGISTRY_ABI = [
    'event ArchonBatch(address indexed sender, bytes32 indexed batchHash, string batchDid, uint256 opCount)',
];

const registryInterface = new Interface(ARCHON_REGISTRY_ABI);
const provider = new JsonRpcProvider(config.rpcUrl, config.chainId);
const cipher = new CipherNode();
const gatekeeper = new GatekeeperClient();
const keymaster = new KeymasterClient();

let jsonPersister: MediatorDbInterface;
let importRunning = false;
let exportRunning = false;

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack || error.message;
    }

    if (typeof error === 'string') {
        return error;
    }

    try {
        return JSON.stringify(error, (_key, value) => (
            typeof value === 'bigint' ? value.toString() : value
        ));
    } catch {
        return String(error);
    }
}

function walletHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.adminApiKey) {
        headers[ARCHON_ADMIN_HEADER] = config.adminApiKey;
    }
    return headers;
}

async function walletGetBalance(): Promise<{ balance: number; balanceWei: string }> {
    const { data } = await axios.get(`${config.walletURL}/api/v1/wallet/balance`, { headers: walletHeaders() });
    return data;
}

async function walletGetAddress(): Promise<string> {
    const { data } = await axios.get(`${config.walletURL}/api/v1/wallet/address`, { headers: walletHeaders() });
    return data.address;
}

async function walletAnchor(batchDid: string, batchHash: string, opCount: number): Promise<string> {
    const { data } = await axios.post(
        `${config.walletURL}/api/v1/wallet/anchor`,
        { contract: config.contractAddress, batchDid, batchHash, opCount },
        { headers: walletHeaders() }
    );
    return data.txid;
}

async function walletGetTransaction(txid: string): Promise<{ confirmations: number; blockhash?: string } | undefined> {
    try {
        const { data } = await axios.get(`${config.walletURL}/api/v1/wallet/transaction/${txid}`, { headers: walletHeaders() });
        return data;
    } catch {
        return undefined;
    }
}

const register = promClient.register;
promClient.collectDefaultMetrics({ register });

const ethereumBlockHeight = new promClient.Gauge({
    name: 'ethereum_block_height',
    help: 'Current scanned block height',
});

const ethereumBlockCount = new promClient.Gauge({
    name: 'ethereum_block_count',
    help: 'Total blockchain height',
});

const ethereumBlocksPending = new promClient.Gauge({
    name: 'ethereum_blocks_pending',
    help: 'Remaining confirmed blocks to scan',
});

const ethereumBlocksScanned = new promClient.Gauge({
    name: 'ethereum_blocks_scanned',
    help: 'Total blocks scanned',
});

const ethereumTxnsScanned = new promClient.Gauge({
    name: 'ethereum_txns_scanned',
    help: 'Total Archon logs scanned',
});

const ethereumDidsDiscovered = new promClient.Gauge({
    name: 'ethereum_dids_discovered',
    help: 'Total DIDs found on chain',
});

const ethereumDidsRegistered = new promClient.Gauge({
    name: 'ethereum_dids_registered',
    help: 'Total DIDs anchored to chain',
});

const ethereumPendingTxs = new promClient.Gauge({
    name: 'ethereum_pending_txs',
    help: 'Count of pending broadcast transactions',
});

const ethereumImportLoopRunning = new promClient.Gauge({
    name: 'ethereum_import_loop_running',
    help: '1 if import loop is currently executing',
});

const ethereumExportLoopRunning = new promClient.Gauge({
    name: 'ethereum_export_loop_running',
    help: '1 if export loop is currently executing',
});

const ethereumImportErrors = new promClient.Counter({
    name: 'ethereum_import_errors_total',
    help: 'Failed import attempts',
});

const ethereumReorgs = new promClient.Counter({
    name: 'ethereum_reorgs_total',
    help: 'Chain reorganization events detected',
});

const ethereumBatchesAnchored = new promClient.Counter({
    name: 'ethereum_batches_anchored_total',
    help: 'Successful batch anchors to blockchain',
});

const ethereumImportBatchDuration = new promClient.Histogram({
    name: 'ethereum_import_batch_duration_seconds',
    help: 'Duration of importBatch operations in seconds',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
});

const ethereumAnchorBatchDuration = new promClient.Histogram({
    name: 'ethereum_anchor_batch_duration_seconds',
    help: 'Duration of anchorBatch operations in seconds',
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
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

async function updateGauges(): Promise<void> {
    const db = await loadDb();
    ethereumBlockHeight.set(db.height);
    ethereumBlockCount.set(db.blockCount);
    ethereumBlocksPending.set(db.blocksPending);
    ethereumBlocksScanned.set(db.blocksScanned);
    ethereumTxnsScanned.set(db.txnsScanned);
    ethereumDidsDiscovered.set(db.discovered.length);
    ethereumDidsRegistered.set(db.registered.length);
    ethereumPendingTxs.set(db.pending?.txids?.length ?? 0);
    ethereumImportLoopRunning.set(importRunning ? 1 : 0);
    ethereumExportLoopRunning.set(exportRunning ? 1 : 0);
}

function startMetricsServer(): void {
    const app = express();

    app.get('/version', (_req, res) => {
        res.json({ version: serviceVersion, commit: serviceCommit });
    });

    app.get('/metrics', async (_req, res) => {
        try {
            await updateGauges();
            res.set('Content-Type', register.contentType);
            res.end(await register.metrics());
        } catch (error: any) {
            console.error('Metrics endpoint error:', error);
            res.status(500).end('Internal Server Error');
        }
    });

    app.listen(config.metricsPort, () => {
        console.log(`Metrics server listening on port ${config.metricsPort}`);
    }).on('error', (err) => {
        console.error('Metrics server failed to start:', err);
    });
}

async function loadDb(): Promise<MediatorDb> {
    const newDb: MediatorDb = {
        height: 0,
        time: '',
        blockCount: 0,
        blocksScanned: 0,
        blocksPending: 0,
        txnsScanned: 0,
        registered: [],
        discovered: [],
    };

    const db = await jsonPersister.loadDb();
    return db || newDb;
}

function discoveredKey(item: Pick<DiscoveredItem, 'height' | 'index' | 'txid' | 'did'>): string {
    return `${item.height}:${item.index}:${item.txid}:${item.did}`;
}

function sameItem(a: DiscoveredItem, b: DiscoveredItem): boolean {
    return a.height === b.height && a.index === b.index && a.txid === b.txid && a.did === b.did;
}

function isFullyProcessed(item: DiscoveredItem): boolean {
    return !!item.imported && !!item.processed && !item.processed.busy && (item.processed.pending ?? 0) === 0;
}

function preferDiscoveredItem(current: DiscoveredItem, candidate: DiscoveredItem): DiscoveredItem {
    const currentDone = isFullyProcessed(current);
    const candidateDone = isFullyProcessed(candidate);

    if (candidateDone !== currentDone) {
        return candidateDone ? candidate : current;
    }

    const currentState = Number(!!current.imported) + Number(!!current.processed) + Number(!!current.error);
    const candidateState = Number(!!candidate.imported) + Number(!!candidate.processed) + Number(!!candidate.error);

    return candidateState > currentState ? candidate : current;
}

async function dedupeDiscovered(): Promise<void> {
    let removed = 0;

    await jsonPersister.updateDb((db) => {
        db.discovered ??= [];

        const byKey = new Map<string, DiscoveredItem>();
        const keys: string[] = [];

        for (const item of db.discovered) {
            const key = discoveredKey(item);
            const current = byKey.get(key);

            if (!current) {
                byKey.set(key, item);
                keys.push(key);
                continue;
            }

            removed += 1;
            byKey.set(key, preferDiscoveredItem(current, item));
        }

        if (removed > 0) {
            db.discovered = keys.map(key => byKey.get(key)!);
        }
    });

    if (removed > 0) {
        console.log(`Removed ${removed} duplicate discovered item(s)`);
    }
}

function updateDiscoveredItems(db: MediatorDb, update: DiscoveredItem): void {
    const list = db.discovered ?? [];

    for (let idx = 0; idx < list.length; idx++) {
        if (sameItem(list[idx], update)) {
            list[idx] = update;
        }
    }
}

function batchHashForDid(batchDid: string): string {
    return `0x${createHash('sha256').update(batchDid).digest('hex')}`;
}

function formatSyncProgress(height: number, blockCount: number): string {
    const totalBlocks = Math.max(1, blockCount - config.startBlock + 1);
    const completedBlocks = Math.min(totalBlocks, Math.max(0, height - config.startBlock + 1));

    return (100 * completedBlocks / totalBlocks).toFixed(2);
}

async function addBlock(height: number, hash: string, time: number): Promise<void> {
    await gatekeeper.addBlock(REGISTRY, { hash, height, time });
}

async function resolveScanStart(blockCount: number): Promise<number> {
    const db = await loadDb();

    if (!db.hash) {
        return db.height ? db.height + 1 : config.startBlock;
    }

    const block = await provider.getBlock(db.height);
    if (block?.hash === db.hash) {
        return db.height + 1;
    }

    ethereumReorgs.inc();
    console.log(`Reorg detected at height ${db.height}, rewinding ${config.confirmations} confirmed block(s)...`);
    const rewindHeight = Math.max(config.startBlock, db.height - config.confirmations);
    const rewindBlock = await provider.getBlock(rewindHeight);

    await jsonPersister.updateDb((data) => {
        data.height = rewindHeight;
        data.hash = rewindBlock?.hash || '';
        data.time = rewindBlock?.timestamp ? new Date(rewindBlock.timestamp * 1000).toISOString() : '';
        data.blocksScanned = Math.max(0, rewindHeight - config.startBlock + 1);
        data.blockCount = blockCount;
        data.blocksPending = Math.max(0, blockCount - rewindHeight);
    });

    return rewindHeight + 1;
}

function parseArchonLog(log: Log, timestamp: string): DiscoveredItem | undefined {
    const parsed = registryInterface.parseLog(log);
    if (!parsed || parsed.name !== 'ArchonBatch') {
        return undefined;
    }

    const batchDid = String(parsed.args.batchDid);
    if (!batchDid.startsWith('did:cid:') || !isValidDID(batchDid)) {
        return undefined;
    }

    return {
        height: log.blockNumber,
        index: log.index,
        time: timestamp,
        txid: log.transactionHash,
        blockHash: log.blockHash,
        batchHash: String(parsed.args.batchHash),
        did: batchDid,
        sender: String(parsed.args.sender),
        opCount: Number(parsed.args.opCount),
    };
}

async function scanBlocks(): Promise<void> {
    const currentHeight = await provider.getBlockNumber();
    const blockCount = Math.max(0, currentHeight - config.confirmations);

    console.log(`current block height: ${currentHeight}, confirmed scan height: ${blockCount}`);

    if (config.startBlock > blockCount) {
        console.log(`Skipping ${REGISTRY} scan because start block ${config.startBlock} is ahead of confirmed height ${blockCount}`);
        return;
    }

    let start = await resolveScanStart(blockCount);

    while (start <= blockCount) {
        const end = Math.min(blockCount, start + config.logChunkSize - 1);
        console.log(`${start}-${end}/${blockCount} blocks (${formatSyncProgress(end, blockCount)}%)`);

        const logs = await provider.getLogs({
            address: config.contractAddress,
            fromBlock: start,
            toBlock: end,
            topics: [registryInterface.getEvent('ArchonBatch')!.topicHash],
        });

        const blockCache = new Map<number, { hash: string; timestamp: number }>();
        const getCachedBlock = async (height: number): Promise<{ hash: string; timestamp: number } | undefined> => {
            const cached = blockCache.get(height);
            if (cached) {
                return cached;
            }
            const block = await provider.getBlock(height);
            if (!block?.hash) {
                return undefined;
            }
            const value = { hash: block.hash, timestamp: block.timestamp };
            blockCache.set(height, value);
            return value;
        };

        for (const log of logs) {
            const block = await getCachedBlock(log.blockNumber);
            if (!block) {
                continue;
            }
            const timestamp = new Date(block.timestamp * 1000).toISOString();
            const item = parseArchonLog(log, timestamp);
            if (!item) {
                continue;
            }

            await jsonPersister.updateDb((db) => {
                const itemKey = discoveredKey(item);
                if (!db.discovered.some(discovered => discoveredKey(discovered) === itemKey)) {
                    db.discovered.push(item);
                }
            });
        }

        let lastBlock: { hash: string; timestamp: number } | undefined;
        for (let height = start; height <= end; height++) {
            const block = await getCachedBlock(height);
            if (!block) {
                continue;
            }
            lastBlock = block;
            await addBlock(height, block.hash, block.timestamp);
        }

        if (lastBlock) {
            const scannedThrough = end;
            await jsonPersister.updateDb((db) => {
                db.height = scannedThrough;
                db.hash = lastBlock.hash;
                db.time = new Date(lastBlock.timestamp * 1000).toISOString();
                db.blocksScanned = scannedThrough - config.startBlock + 1;
                db.txnsScanned += logs.length;
                db.blockCount = blockCount;
                db.blocksPending = blockCount - scannedThrough;
            });
        }

        start = end + 1;
    }
}

async function importBatch(item: DiscoveredItem, retry = false) {
    if (item.error && !retry) {
        return;
    }

    if (isFullyProcessed(item) && !retry) {
        return;
    }

    const asset = await keymaster.resolveAsset(item.did);
    const batch = (asset as { batch?: { version: number; ops: string[] } }).batch;

    if (!batch || batch.version !== 1 || !Array.isArray(batch.ops) || batch.ops.length === 0) {
        return;
    }

    const expectedHash = batchHashForDid(item.did);
    if (item.batchHash.toLowerCase() !== expectedHash.toLowerCase()) {
        const update: DiscoveredItem = { ...item, error: `Batch hash mismatch: expected ${expectedHash}` };
        ethereumImportErrors.inc();
        return update;
    }

    const metadata = {
        registry: REGISTRY,
        time: item.time,
        ordinal: [item.height, item.index],
        registration: {
            height: item.height,
            index: item.index,
            txid: item.txid,
            batch: item.did,
            opidx: item.index,
        } as DidRegistration,
    };

    const previousPending = item.processed?.pending;
    const update: DiscoveredItem = { ...item };
    const end = ethereumImportBatchDuration.startTimer();

    try {
        update.imported = await gatekeeper.importBatchByCids(batch.ops, metadata);
        update.processed = await gatekeeper.processEvents();

        const newPending = update.processed?.pending ?? 0;
        if (!retry && newPending > 0 && previousPending !== undefined && newPending >= previousPending) {
            update.error = `No progress: ${newPending} pending event(s) unresolved`;
        }
    } catch (error) {
        ethereumImportErrors.inc();
        update.error = JSON.stringify(error);
    } finally {
        end();
    }

    console.log(JSON.stringify(update, null, 4));
    return update;
}

async function importBatches(): Promise<boolean> {
    const db = await loadDb();

    for (const item of db.discovered) {
        try {
            const update = await importBatch(item);
            if (!update) {
                continue;
            }

            await jsonPersister.updateDb((db) => {
                updateDiscoveredItems(db, update);
            });
        }
        catch (error: any) {
            if (error.error !== 'DID not found') {
                console.error(`Error importing ${item.did}: ${formatError(error?.error ?? error)}`);
            }
        }
    }

    return true;
}

async function retryFailedImports(): Promise<void> {
    const db = await loadDb();
    const failed = db.discovered.filter(item => item.error && !item.imported);

    if (failed.length === 0) {
        return;
    }

    console.log(`Retrying ${failed.length} failed import(s)...`);

    for (const item of failed) {
        try {
            const update = await importBatch(item, true);
            if (!update) {
                continue;
            }

            await jsonPersister.updateDb((db) => {
                updateDiscoveredItems(db, update);
            });
        }
        catch (error: any) {
            if (error.error !== 'DID not found') {
                console.error(`Retry failed for ${item.did}: ${formatError(error?.error ?? error)}`);
            }
        }
    }
}

async function checkPendingTransactions(txids: string[]): Promise<boolean> {
    for (const txid of txids) {
        const tx = await walletGetTransaction(txid);
        if (tx && tx.confirmations > 0) {
            await jsonPersister.updateDb((db) => { db.pending = undefined; });
            return false;
        }
    }

    if (txids.length) {
        console.log('pending txid', txids.at(-1));
    }

    return txids.length > 0;
}

async function checkExportInterval(): Promise<boolean> {
    const db = await loadDb();

    if (!db.lastExport) {
        await jsonPersister.updateDb((data) => {
            if (!data.lastExport) {
                data.lastExport = new Date().toISOString();
            }
        });
        return true;
    }

    const lastExport = new Date(db.lastExport).getTime();
    const now = Date.now();
    const elapsedMinutes = (now - lastExport) / (60 * 1000);

    return (elapsedMinutes < config.exportInterval);
}

async function anchorBatch(): Promise<void> {
    if (await checkExportInterval()) {
        return;
    }

    const db = await loadDb();
    if (db.pending?.txids && await checkPendingTransactions(db.pending.txids)) {
        return;
    }

    const end = ethereumAnchorBatchDuration.startTimer();

    try {
        try {
            const { balance } = await walletGetBalance();
            if (balance <= 0) {
                const address = await walletGetAddress();
                console.log(`Wallet has no ETH for gas. Send ${config.chain} gas funds to ${address}`);
                return;
            }
        } catch {
            console.log(`${config.chain} wallet service not accessible`);
            return;
        }

        const operations = await gatekeeper.getQueue(REGISTRY);

        if (operations.length > 0) {
            console.log(JSON.stringify(operations, null, 4));

            const cids = await Promise.all(operations.map(op => {
                const canonical = JSON.parse(cipher.canonicalizeJSON(op));
                return gatekeeper.addJSON(canonical);
            }));
            const batch = { version: 1, ops: cids };
            const did = await keymaster.createAsset({ batch }, { registry: 'hyperswarm', controller: config.nodeID });
            const batchHash = batchHashForDid(did);
            const txid = await walletAnchor(did, batchHash, cids.length);

            if (txid) {
                const ok = await gatekeeper.clearQueue(REGISTRY, operations);

                if (ok) {
                    ethereumBatchesAnchored.inc();
                    const blockCount = await provider.getBlockNumber();
                    await jsonPersister.updateDb((db) => {
                        (db.registered ??= []).push({ did, txid, batchHash });
                        db.pending = { txids: [txid], blockCount };
                        db.lastExport = new Date().toISOString();
                    });
                }
            }
        }
        else {
            console.log(`empty ${REGISTRY} queue`);
        }
    } finally {
        end();
    }
}

async function importLoop(): Promise<void> {
    if (importRunning) {
        setTimeout(importLoop, config.importInterval * 60 * 1000);
        console.log(`import loop busy, waiting ${config.importInterval} minute(s)...`);
        return;
    }

    importRunning = true;
    let stage = 'scanBlocks';

    try {
        await scanBlocks();
        stage = 'importBatches';
        await importBatches();
        stage = 'retryFailedImports';
        await retryFailedImports();
    } catch (error: any) {
        console.error(`Error in importLoop during ${stage}: ${formatError(error?.error ?? error)}`);
    } finally {
        importRunning = false;
        console.log(`import loop waiting ${config.importInterval} minute(s)...`);
        setTimeout(importLoop, config.importInterval * 60 * 1000);
    }
}

async function exportLoop(): Promise<void> {
    if (exportRunning) {
        setTimeout(exportLoop, config.exportInterval * 60 * 1000);
        console.log(`Export loop busy, waiting ${config.exportInterval} minute(s)...`);
        return;
    }

    exportRunning = true;

    try {
        await anchorBatch();
    } catch (error) {
        console.error(`Error in exportLoop: ${formatError(error)}`);
    } finally {
        exportRunning = false;
        console.log(`export loop waiting ${config.exportInterval} minute(s)...`);
        setTimeout(exportLoop, config.exportInterval * 60 * 1000);
    }
}

async function waitForChain() {
    let isReady = false;

    if (!isAddress(config.contractAddress)) {
        console.error('ARCHON_ETH_CONTRACT must be configured with the canonical Archon registry contract address');
        return false;
    }

    console.log(`Connecting to ${config.chain} JSON-RPC at ${config.rpcUrl}`);

    while (!isReady) {
        try {
            const network = await provider.getNetwork();
            if (Number(network.chainId) !== config.chainId) {
                throw new Error(`RPC chain ID ${network.chainId} does not match configured chain ID ${config.chainId}`);
            }
            console.log(`Connected to chain ID ${network.chainId}`);
            isReady = true;
        } catch (error: any) {
            console.log(`Waiting for ${config.chain} node: ${error.message}`);
        }

        if (!isReady) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    if (READ_ONLY) {
        return true;
    }

    if (!config.walletURL) {
        console.error('ARCHON_WALLET_URL is required for export mode');
        return false;
    }

    console.log(`Connecting to wallet service at ${config.walletURL}`);
    while (true) {
        try {
            await walletGetBalance();
            break;
        } catch {
            console.log('Waiting for wallet service...');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    const { balance } = await walletGetBalance();
    const address = await walletGetAddress();
    console.log(`Wallet balance: ${balance}, funding address: ${address}`);

    return true;
}

async function syncBlocks(): Promise<void> {
    try {
        const currentHeight = await provider.getBlockNumber();
        const blockCount = Math.max(0, currentHeight - config.confirmations);
        const latest = await gatekeeper.getBlock(REGISTRY);

        console.log(`current block height: ${currentHeight}, confirmed sync height: ${blockCount}`);

        if (config.startBlock > blockCount) {
            console.log(`Skipping ${REGISTRY} sync because start block ${config.startBlock} is ahead of confirmed height ${blockCount}`);
            return;
        }

        const startBlock = latest
            ? await gatekeeper.getBlock(REGISTRY, config.startBlock)
            : null;

        let startHeight = config.startBlock;

        if (!latest) {
            console.log(`No ${REGISTRY} blocks found in gatekeeper; syncing from configured start block ${config.startBlock}`);
        } else if (!startBlock) {
            console.log(`Gatekeeper ${REGISTRY} is missing configured start block ${config.startBlock}; resyncing from configured start block`);
        } else {
            startHeight = Math.max(latest.height + 1, config.startBlock);
        }

        if (startHeight > blockCount) {
            console.log(`Gatekeeper ${REGISTRY} blocks are already synced through height ${latest!.height}`);
            return;
        }

        for (let height = startHeight; height <= blockCount; height++) {
            const block = await provider.getBlock(height);
            if (!block?.hash) {
                continue;
            }
            console.log(`${height}/${blockCount} blocks (${formatSyncProgress(height, blockCount)}%)`);
            await addBlock(height, block.hash, block.timestamp);
        }
    } catch (error) {
        console.error('Error syncing blocks:', error);
    }
}

async function main() {
    console.log(`Starting Ethereum mediator v${serviceVersion} (${serviceCommit})`);

    if (!READ_ONLY && !config.nodeID) {
        console.log('ethereum-mediator must have ARCHON_NODE_ID configured');
        return;
    }

    const jsonFile = new JsonFile(config.dbName);

    if (config.db === 'redis') {
        jsonPersister = await JsonRedis.create(config.dbName);
    }
    else if (config.db === 'mongodb') {
        jsonPersister = await JsonMongo.create(config.dbName);
    }
    else if (config.db === 'sqlite') {
        jsonPersister = await JsonSQLite.create(config.dbName);
    }
    else {
        jsonPersister = jsonFile;
    }

    if (config.db !== 'json') {
        const jsonDb = await jsonPersister.loadDb();
        const fileDb = await jsonFile.loadDb();

        if (!jsonDb && fileDb) {
            await jsonPersister.saveDb(fileDb);
            console.log(`Database upgraded to ${config.db}`);
        }
        else {
            console.log(`Persisting to ${config.db}`);
        }
    }

    await dedupeDiscovered();

    if (config.reimport) {
        const db = await loadDb();
        for (const item of db.discovered) {
            delete item.imported;
            delete item.processed;
            delete item.error;
        }
        await jsonPersister.saveDb(db);
    }

    const ok = await waitForChain();
    if (!ok) {
        return;
    }

    await gatekeeper.connect({
        url: config.gatekeeperURL,
        apiKey: config.adminApiKey,
        waitUntilReady: true,
        intervalSeconds: 5,
        chatty: true,
    });

    await keymaster.connect({
        url: config.keymasterURL,
        apiKey: config.adminApiKey,
        waitUntilReady: true,
        intervalSeconds: 5,
        chatty: true,
    });

    startMetricsServer();

    await syncBlocks();

    if (config.importInterval > 0) {
        console.log(`Importing operations every ${config.importInterval} minute(s)`);
        setTimeout(importLoop, config.importInterval * 60 * 1000);
    }

    if (!READ_ONLY) {
        console.log(`Exporting operations every ${config.exportInterval} minute(s)`);
        console.log(`Wallet service: ${config.walletURL}`);
        setTimeout(exportLoop, config.exportInterval * 60 * 1000);
    }
}

main();
