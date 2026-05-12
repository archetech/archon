import ZecClient, { Block, BlockVerbose, BlockHeader } from 'bitcoin-core';
import CipherNode from '@didcid/cipher/node';
import GatekeeperClient from '@didcid/gatekeeper/client';
import KeymasterClient from '@didcid/keymaster/client';
import JsonFile from './db/jsonfile.js';
import JsonRedis from './db/redis.js';
import JsonMongo from './db/mongo.js';
import JsonSQLite from './db/sqlite.js';
import config from './config.js';
import { isValidDID } from '@didcid/ipfs/utils';
import { MediatorDb, MediatorDbInterface, DiscoveredItem, BlockVerbosity } from './types.js';
import { DidRegistration } from '@didcid/gatekeeper/types';
import express from 'express';
import { readFile } from 'fs/promises';
import promClient from 'prom-client';
import axios from 'axios';

const REGISTRY = config.chain;

const READ_ONLY = config.exportInterval === 0;
const ARCHON_ADMIN_HEADER = 'X-Archon-Admin-Key';

const cipher = new CipherNode();
const gatekeeper = new GatekeeperClient();
const keymaster = new KeymasterClient();
const zecClient = new ZecClient({
    username: config.user,
    password: config.pass,
    host: `http://${config.host}:${config.port}`,
});

// Wallet service API helpers
function walletHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.adminApiKey) {
        headers[ARCHON_ADMIN_HEADER] = config.adminApiKey;
    }
    return headers;
}

async function walletGetBalance(): Promise<{ balance: number; unconfirmed_balance: number }> {
    const { data } = await axios.get(`${config.walletURL}/api/v1/wallet/balance`, { headers: walletHeaders() });
    return data;
}

async function walletGetAddress(): Promise<string> {
    const { data } = await axios.get(`${config.walletURL}/api/v1/wallet/address`, { headers: walletHeaders() });
    return data.address;
}

async function walletAnchor(opReturnData: string, feeRate?: number): Promise<string> {
    const { data } = await axios.post(`${config.walletURL}/api/v1/wallet/anchor`, { data: opReturnData, feeRate }, { headers: walletHeaders() });
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

let jsonPersister: MediatorDbInterface;
let importRunning = false;
let exportRunning = false;

// --- Prometheus metrics setup ---
const register = promClient.register;
promClient.collectDefaultMetrics({ register });

// Gauges — updated on each /metrics scrape from db state
const zcashBlockHeight = new promClient.Gauge({
    name: 'zcash_block_height',
    help: 'Current scanned block height',
});

const zcashBlockCount = new promClient.Gauge({
    name: 'zcash_block_count',
    help: 'Total blockchain height',
});

const zcashBlocksPending = new promClient.Gauge({
    name: 'zcash_blocks_pending',
    help: 'Remaining blocks to scan',
});

const zcashBlocksScanned = new promClient.Gauge({
    name: 'zcash_blocks_scanned',
    help: 'Total blocks scanned',
});

const zcashTxnsScanned = new promClient.Gauge({
    name: 'zcash_txns_scanned',
    help: 'Total transactions scanned',
});

const zcashDidsDiscovered = new promClient.Gauge({
    name: 'zcash_dids_discovered',
    help: 'Total DIDs found on chain',
});

const zcashDidsRegistered = new promClient.Gauge({
    name: 'zcash_dids_registered',
    help: 'Total DIDs anchored to chain',
});

const zcashPendingTxs = new promClient.Gauge({
    name: 'zcash_pending_txs',
    help: 'Count of pending broadcast transactions',
});

const zcashImportLoopRunning = new promClient.Gauge({
    name: 'zcash_import_loop_running',
    help: '1 if import loop is currently executing',
});

const zcashExportLoopRunning = new promClient.Gauge({
    name: 'zcash_export_loop_running',
    help: '1 if export loop is currently executing',
});

// Counters
const zcashImportErrors = new promClient.Counter({
    name: 'zcash_import_errors_total',
    help: 'Failed import attempts',
});

const zcashReorgs = new promClient.Counter({
    name: 'zcash_reorgs_total',
    help: 'Chain reorganization events detected',
});

const zcashBatchesAnchored = new promClient.Counter({
    name: 'zcash_batches_anchored_total',
    help: 'Successful batch anchors to blockchain',
});

// Histograms
const zcashImportBatchDuration = new promClient.Histogram({
    name: 'zcash_import_batch_duration_seconds',
    help: 'Duration of importBatch operations in seconds',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
});

const zcashAnchorBatchDuration = new promClient.Histogram({
    name: 'zcash_anchor_batch_duration_seconds',
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
    zcashBlockHeight.set(db.height);
    zcashBlockCount.set(db.blockCount);
    zcashBlocksPending.set(db.blocksPending);
    zcashBlocksScanned.set(db.blocksScanned);
    zcashTxnsScanned.set(db.txnsScanned);
    zcashDidsDiscovered.set(db.discovered.length);
    zcashDidsRegistered.set(db.registered.length);
    zcashPendingTxs.set(db.pending?.txids?.length ?? 0);
    zcashImportLoopRunning.set(importRunning ? 1 : 0);
    zcashExportLoopRunning.set(exportRunning ? 1 : 0);
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
        time: "",
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

async function getBlockTxCount(hash: string, header?: BlockHeader): Promise<number> {
    if (typeof header?.nTx === 'number') {
        return header.nTx;
    }

    const block = await zecClient.getBlock(hash, BlockVerbosity.JSON) as Block;
    return Array.isArray(block.tx) ? block.tx.length : 0;
}

async function resolveScanStart(blockCount: number): Promise<number> {
    const db = await loadDb();

    if (!db.hash) {
        return db.height ? db.height + 1 : config.startBlock;
    }

    let header: BlockHeader | undefined;
    try {
        header = await zecClient.getBlockHeader(db.hash) as BlockHeader;
    } catch { }

    if ((header?.confirmations ?? 0) > 0) {
        return db.height + 1;
    }

    zcashReorgs.inc();
    console.log(`Reorg detected at height ${db.height}, rewinding to a confirmed block...`);

    let height = db.height;
    let hash = db.hash;
    let txnsToSubtract = 0;

    while (hash && height >= config.startBlock) {
        let currentHeader: BlockHeader;
        try {
            currentHeader = await zecClient.getBlockHeader(hash) as BlockHeader;
        } catch {
            break;
        }

        if ((currentHeader.confirmations ?? 0) > 0) {
            const resolvedHeight = currentHeader.height ?? height;
            const resolvedTime = currentHeader.time ? new Date(currentHeader.time * 1000).toISOString() : '';
            const resolvedHash = hash;
            const resolvedBlocksPending = blockCount - resolvedHeight;
            const resolvedTxnsToSubtract = txnsToSubtract;
            await jsonPersister.updateDb((data) => {
                data.height = resolvedHeight;
                data.hash = resolvedHash;
                data.time = resolvedTime;
                data.blocksScanned = Math.max(0, resolvedHeight - config.startBlock + 1);
                data.txnsScanned = Math.max(0, data.txnsScanned - resolvedTxnsToSubtract);
                data.blockCount = blockCount;
                data.blocksPending = resolvedBlocksPending;
            });
            return resolvedHeight + 1;
        }

        txnsToSubtract += await getBlockTxCount(hash, currentHeader);

        if (!currentHeader.previousblockhash) {
            break;
        }

        hash = currentHeader.previousblockhash;
        height = (currentHeader.height ?? height) - 1;
    }

    const fallbackHeight = config.startBlock;
    let fallbackHash = '';
    let fallbackTime = '';

    try {
        fallbackHash = await zecClient.getBlockHash(fallbackHeight);
        const fallbackHeader = await zecClient.getBlockHeader(fallbackHash) as BlockHeader;
        fallbackTime = fallbackHeader.time ? new Date(fallbackHeader.time * 1000).toISOString() : '';
    } catch {
        fallbackHash = '';
    }

    await jsonPersister.updateDb((data) => {
        data.height = fallbackHeight;
        if (fallbackHash) {
            data.hash = fallbackHash;
        }
        data.time = fallbackTime;
        data.blocksScanned = 0;
        data.txnsScanned = 0;
        data.blockCount = blockCount;
        data.blocksPending = blockCount - fallbackHeight;
    });

    return fallbackHeight + 1;
}

function discoveredKey(item: Pick<DiscoveredItem, 'height' | 'index' | 'txid' | 'did'>): string {
    return `${item.height}:${item.index}:${item.txid}:${item.did}`;
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

        const discovered = db.discovered;
        const byKey = new Map<string, DiscoveredItem>();
        const keys: string[] = [];

        for (const item of discovered) {
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

async function fetchBlock(height: number, blockCount: number): Promise<void> {
    try {
        const blockHash = await zecClient.getBlockHash(height);
        const block = await zecClient.getBlock(blockHash, BlockVerbosity.JSON_TX_DATA) as BlockVerbose;
        const timestamp = new Date(block.time * 1000).toISOString();

        for (let i = 0; i < block.tx.length; i++) {
            const tx = block.tx[i];
            const txid = tx.txid;

            console.log(height, String(i).padStart(4), txid);

            for (const vout of tx.vout ?? []) {
                const asm = vout.scriptPubKey?.asm;
                if (!asm) {
                    continue;
                }

                const parts = asm.split(' ');
                if (parts[0] !== 'OP_RETURN' || !parts[1]) {
                    continue;
                }

                try {
                    const textString = Buffer.from(parts[1], 'hex').toString('utf8');
                    if (textString.startsWith('did:cid:') && isValidDID(textString)) {
                        await jsonPersister.updateDb((db) => {
                            const item = { height, index: i, time: timestamp, txid, did: textString };
                            const itemKey = discoveredKey(item);

                            if (!db.discovered.some(discovered => discoveredKey(discovered) === itemKey)) {
                                db.discovered.push(item);
                            }
                        });
                    }
                } catch (error: any) {
                    console.error('Error decoding OP_RETURN or updating DB:', error);
                }
            }
        }

        await jsonPersister.updateDb((db) => {
            db.height = height;
            db.hash = blockHash;
            db.time = timestamp;
            db.blocksScanned = height - config.startBlock + 1;
            db.txnsScanned += block.tx.length;
            db.blockCount = blockCount;
            db.blocksPending = blockCount - height;
        });
        await addBlock(height, blockHash, block.time);

    } catch (error) {
        console.error(`Error fetching block: ${error}`);
    }
}

async function scanBlocks(): Promise<void> {
    let blockCount = await zecClient.getBlockCount();

    console.log(`current block height: ${blockCount}`);

    let start = await resolveScanStart(blockCount);

    for (let height = start; height <= blockCount; height++) {
        console.log(`${height}/${blockCount} blocks (${formatSyncProgress(height, blockCount)}%)`);
        await fetchBlock(height, blockCount);
        blockCount = await zecClient.getBlockCount();
    }
}

async function importBatch(item: DiscoveredItem, retry: boolean = false) {
    // Skip items with errors unless this is a retry
    if (item.error && !retry) {
        return;
    }

    // Skip fully processed items (unless retrying)
    if (isFullyProcessed(item) && !retry) {
        return;
    }

    const asset = await keymaster.resolveAsset(item.did);
    const batch = (asset as { batch?: { version: number; ops: string[] } }).batch;

    // Skip badly formatted batches
    if (!batch || batch.version !== 1 || !Array.isArray(batch.ops) || batch.ops.length === 0) {
        return;
    }

    const cids = batch.ops;

    const metadata = {
        registry: REGISTRY,
        time: item.time,
        ordinal: [item.height, item.index],
        registration: {
            height: item.height,
            index: item.index,
            txid: item.txid,
            batch: item.did,
        } as DidRegistration,
    };

    const previousPending = item.processed?.pending;
    let update: DiscoveredItem = { ...item };
    const end = zcashImportBatchDuration.startTimer();

    try {
        update.imported = await gatekeeper.importBatchByCids(cids, metadata);
        update.processed = await gatekeeper.processEvents();

        // If pending count didn't decrease, no progress was made — stop retrying
        const newPending = update.processed?.pending ?? 0;
        if (!retry && newPending > 0 && previousPending !== undefined && newPending >= previousPending) {
            update.error = `No progress: ${newPending} pending event(s) unresolved`;
        }
    } catch (error) {
        zcashImportErrors.inc();
        update.error = JSON.stringify(error);
    } finally {
        end();
    }

    console.log(JSON.stringify(update, null, 4));
    return update;
}

function sameItem(a: DiscoveredItem, b: DiscoveredItem) {
    return a.height === b.height && a.index === b.index && a.txid === b.txid && a.did === b.did;
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
            // OK if DID not found, we'll just try again later
            if (error.error !== 'DID not found') {
                console.error(`Error importing ${item.did}: ${error.error || JSON.stringify(error)}`);
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

            if (update.imported) {
                console.log(`Successfully imported ${item.did}`);
            }
        }
        catch (error: any) {
            if (error.error !== 'DID not found') {
                console.error(`Retry failed for ${item.did}: ${error.error || JSON.stringify(error)}`);
            }
        }
    }
}

export async function createOpReturnTxn(opReturnData: string): Promise<string | undefined> {
    const feeRate = await getHybridFeeRateZatPerVb();
    console.log(`Anchoring with fee rate: ${feeRate.toFixed(1)} zat/vB`);
    const txid = await walletAnchor(opReturnData, feeRate);
    console.log(`Transaction broadcast with txid: ${txid}`);
    return txid;
}

async function checkPendingTransactions(txids: string[]): Promise<boolean> {
    const isMined = async (txid: string) => {
        const tx = await walletGetTransaction(txid);
        return !!(tx && tx.confirmations > 0);
    };

    const checkPendingTxs = async (txids: string[]): Promise<number> => {
        for (let i = 0; i < txids.length; i++) {
            if (await isMined(txids[i])) {
                return i;
            }
        }
        return -1;
    }

    if (txids.length) {
        const mined = await checkPendingTxs(txids);
        if (mined >= 0) {
            await jsonPersister.updateDb((db) => { db.pending = undefined; });
            return false;
        } else {
            console.log('pending txid', txids.at(-1));
        }
    }

    return true;
}

async function getHybridFeeRateZatPerVb(): Promise<number> {
    let localZatPerVb = config.feeFallback;
    try {
        const networkInfo = await zecClient.getNetworkInfo();
        if (networkInfo.relayfee) {
            localZatPerVb = (networkInfo.relayfee / 1000) * 1e8;
        }
    } catch (err: any) {
        console.warn(`getnetworkinfo failed, using fallback: ${err.message}`);
    }

    let oracleZatPerVb: number | undefined;
    if (config.feeOracleUrl) {
        try {
            const response = await axios.get<{ fastestFee: number; halfHourFee: number; hourFee: number }>(
                config.feeOracleUrl,
                { timeout: 5000 }
            );
            const { fastestFee, halfHourFee, hourFee } = response.data;
            if (config.feeConf <= 1) {
                oracleZatPerVb = fastestFee;
            } else if (config.feeConf <= 3) {
                oracleZatPerVb = halfHourFee;
            } else {
                oracleZatPerVb = hourFee;
            }
            if (oracleZatPerVb !== localZatPerVb) {
                console.log(`Fee oracle: ${oracleZatPerVb} zat/vB (local estimate: ${localZatPerVb.toFixed(1)} zat/vB)`);
            }
        } catch (err: any) {
            console.warn(`Fee oracle unavailable: ${err.message}`);
        }
    }

    return Math.max(localZatPerVb, oracleZatPerVb ?? 0);
}


async function replaceByFee(): Promise<boolean> {
    const db = await loadDb();

    if (!db.pending?.txids || !(await checkPendingTransactions(db.pending.txids))) {
        return false;
    }

    if (!config.rbfEnabled) {
        return true;
    }

    console.log('Zcash transparent fee bumping is not supported; waiting for pending transaction confirmation');
    return true;
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

    if (await replaceByFee()) {
        return;
    }

    const end = zcashAnchorBatchDuration.startTimer();

    try {
        try {
            const { balance } = await walletGetBalance();

            if (balance < config.feeMax) {
                const address = await walletGetAddress();
                console.log(`Wallet has insufficient funds (${balance}). Send ${config.chain} to ${address}`);
                return;
            }
        }
        catch {
            console.log(`${config.chain} wallet service not accessible`);
            return;
        }

        const operations = await gatekeeper.getQueue(REGISTRY);

        if (operations.length > 0) {
            console.log(JSON.stringify(operations, null, 4));

            // Save each operation to IPFS and collect CIDs (canonicalize for deterministic CIDs)
            const cids = await Promise.all(operations.map(op => {
                const canonical = JSON.parse(cipher.canonicalizeJSON(op));
                return gatekeeper.addJSON(canonical);
            }));
            const batch = { version: 1, ops: cids };
            const did = await keymaster.createAsset({ batch }, { registry: 'hyperswarm', controller: config.nodeID });
            const txid = await createOpReturnTxn(did);

            if (txid) {
                const ok = await gatekeeper.clearQueue(REGISTRY, operations);

                if (ok) {
                    zcashBatchesAnchored.inc();
                    const blockCount = await zecClient.getBlockCount();
                    await jsonPersister.updateDb(async (db) => {
                        (db.registered ??= []).push({
                            did,
                            txid: txid!
                        });
                        db.pending = {
                            txids: [txid!],
                            blockCount
                        };
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

    try {
        await scanBlocks();
        await importBatches();
        await retryFailedImports();
    } catch (error: any) {
        console.error(`Error in importLoop: ${error.error || JSON.stringify(error)}`);
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
        console.error(`Error in exportLoop: ${error}`);
    } finally {
        exportRunning = false;
        console.log(`export loop waiting ${config.exportInterval} minute(s)...`);
        setTimeout(exportLoop, config.exportInterval * 60 * 1000);
    }
}

async function waitForChain() {
    let isReady = false;

    console.log(`Connecting to ${config.chain} node on ${config.host}:${config.port}`);

    while (!isReady) {
        try {
            const blockchainInfo = await zecClient.getBlockchainInfo();
            console.log("Blockchain Info:", JSON.stringify(blockchainInfo, null, 4));
            isReady = true;
        } catch (error) {
            console.log(`Waiting for ${config.chain} node...`);
        }

        if (!isReady) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    if (READ_ONLY) {
        return true;
    }

    // Verify wallet service is accessible
    if (!config.walletURL) {
        console.error('ARCHON_WALLET_URL is required for export mode');
        return false;
    }

    console.log(`Connecting to wallet service at ${config.walletURL}`);
    while (true) {
        try {
            await walletGetBalance();
            break;
        } catch (error) {
            console.log(`Waiting for wallet service...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    const { balance } = await walletGetBalance();
    const address = await walletGetAddress();
    console.log(`Wallet balance: ${balance}, funding address: ${address}`);

    return true;
}

async function addBlock(height: number, hash: string, time: number): Promise<void> {
    await gatekeeper.addBlock(REGISTRY, { hash, height, time });
}

function formatSyncProgress(height: number, blockCount: number): string {
    const totalBlocks = Math.max(1, blockCount - config.startBlock + 1);
    const completedBlocks = Math.min(totalBlocks, Math.max(0, height - config.startBlock + 1));

    return (100 * completedBlocks / totalBlocks).toFixed(2);
}

async function syncBlocks(): Promise<void> {
    try {
        const blockCount = await zecClient.getBlockCount();
        const latest = await gatekeeper.getBlock(REGISTRY);

        console.log(`current block height: ${blockCount}`);

        if (config.startBlock > blockCount) {
            console.log(`Skipping ${REGISTRY} sync because start block ${config.startBlock} is ahead of current chain height ${blockCount}`);
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
            const blockHash = await zecClient.getBlockHash(height);
            const header = await zecClient.getBlockHeader(blockHash) as BlockHeader;
            console.log(`${height}/${blockCount} blocks (${formatSyncProgress(height, blockCount)}%)`);
            await addBlock(height, blockHash, header.time!);
        }
    } catch (error) {
        console.error(`Error syncing blocks:`, error);
    }
}

async function main() {
    console.log(`Starting Zcash mediator v${serviceVersion} (${serviceCommit})`);

    if (!READ_ONLY && !config.nodeID) {
        console.log('zcash-mediator must have a ARCHON_NODE_ID configured');
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
