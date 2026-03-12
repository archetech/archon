import BtcClient, {Block, BlockVerbose, BlockHeader, MempoolEntry} from 'bitcoin-core';
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

const cipher = new CipherNode();
const gatekeeper = new GatekeeperClient();
const keymaster = new KeymasterClient();
const btcClient = new BtcClient({
    username: config.user,
    password: config.pass,
    host: `http://${config.host}:${config.port}`,
});

// Wallet service API helpers
function walletHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.adminApiKey) {
        headers['Authorization'] = `Bearer ${config.adminApiKey}`;
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

async function walletAnchor(opReturnData: string): Promise<string> {
    const { data } = await axios.post(`${config.walletURL}/api/v1/wallet/anchor`, { data: opReturnData }, { headers: walletHeaders() });
    return data.txid;
}

async function walletBumpFee(txid: string, feeRate?: number): Promise<string> {
    const { data } = await axios.post(`${config.walletURL}/api/v1/wallet/bump-fee`, { txid, feeRate }, { headers: walletHeaders() });
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
const satoshiBlockHeight = new promClient.Gauge({
    name: 'satoshi_block_height',
    help: 'Current scanned block height',
});

const satoshiBlockCount = new promClient.Gauge({
    name: 'satoshi_block_count',
    help: 'Total blockchain height',
});

const satoshiBlocksPending = new promClient.Gauge({
    name: 'satoshi_blocks_pending',
    help: 'Remaining blocks to scan',
});

const satoshiBlocksScanned = new promClient.Gauge({
    name: 'satoshi_blocks_scanned',
    help: 'Total blocks scanned',
});

const satoshiTxnsScanned = new promClient.Gauge({
    name: 'satoshi_txns_scanned',
    help: 'Total transactions scanned',
});

const satoshiDidsDiscovered = new promClient.Gauge({
    name: 'satoshi_dids_discovered',
    help: 'Total DIDs found on chain',
});

const satoshiDidsRegistered = new promClient.Gauge({
    name: 'satoshi_dids_registered',
    help: 'Total DIDs anchored to chain',
});

const satoshiPendingTxs = new promClient.Gauge({
    name: 'satoshi_pending_txs',
    help: 'Count of pending broadcast transactions',
});

const satoshiImportLoopRunning = new promClient.Gauge({
    name: 'satoshi_import_loop_running',
    help: '1 if import loop is currently executing',
});

const satoshiExportLoopRunning = new promClient.Gauge({
    name: 'satoshi_export_loop_running',
    help: '1 if export loop is currently executing',
});

// Counters
const satoshiImportErrors = new promClient.Counter({
    name: 'satoshi_import_errors_total',
    help: 'Failed import attempts',
});

const satoshiReorgs = new promClient.Counter({
    name: 'satoshi_reorgs_total',
    help: 'Chain reorganization events detected',
});

const satoshiBatchesAnchored = new promClient.Counter({
    name: 'satoshi_batches_anchored_total',
    help: 'Successful batch anchors to blockchain',
});

const satoshiRbfBumps = new promClient.Counter({
    name: 'satoshi_rbf_bumps_total',
    help: 'Replace-by-fee fee bumps',
});

// Histograms
const satoshiImportBatchDuration = new promClient.Histogram({
    name: 'satoshi_import_batch_duration_seconds',
    help: 'Duration of importBatch operations in seconds',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
});

const satoshiAnchorBatchDuration = new promClient.Histogram({
    name: 'satoshi_anchor_batch_duration_seconds',
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
    satoshiBlockHeight.set(db.height);
    satoshiBlockCount.set(db.blockCount);
    satoshiBlocksPending.set(db.blocksPending);
    satoshiBlocksScanned.set(db.blocksScanned);
    satoshiTxnsScanned.set(db.txnsScanned);
    satoshiDidsDiscovered.set(db.discovered.length);
    satoshiDidsRegistered.set(db.registered.length);
    satoshiPendingTxs.set(db.pending?.txids?.length ?? 0);
    satoshiImportLoopRunning.set(importRunning ? 1 : 0);
    satoshiExportLoopRunning.set(exportRunning ? 1 : 0);
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

    const block = await btcClient.getBlock(hash, BlockVerbosity.JSON) as Block;
    return Array.isArray(block.tx) ? block.tx.length : 0;
}

async function resolveScanStart(blockCount: number): Promise<number> {
    const db = await loadDb();

    if (!db.hash) {
        return db.height ? db.height + 1 : config.startBlock;
    }

    let header: BlockHeader | undefined;
    try {
        header = await btcClient.getBlockHeader(db.hash) as BlockHeader;
    } catch { }

    if ((header?.confirmations ?? 0) > 0) {
        return db.height + 1;
    }

    satoshiReorgs.inc();
    console.log(`Reorg detected at height ${db.height}, rewinding to a confirmed block...`);

    let height = db.height;
    let hash = db.hash;
    let txnsToSubtract = 0;

    while (hash && height >= config.startBlock) {
        let currentHeader: BlockHeader;
        try {
            currentHeader = await btcClient.getBlockHeader(hash) as BlockHeader;
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
        fallbackHash = await btcClient.getBlockHash(fallbackHeight);
        const fallbackHeader = await btcClient.getBlockHeader(fallbackHash) as BlockHeader;
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

async function fetchBlock(height: number, blockCount: number): Promise<void> {
    try {
        const blockHash = await btcClient.getBlockHash(height);
        const block = await btcClient.getBlock(blockHash, BlockVerbosity.JSON_TX_DATA) as BlockVerbose;
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
                            db.discovered.push({ height, index: i, time: timestamp, txid, did: textString });
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
    let blockCount = await btcClient.getBlockCount();

    console.log(`current block height: ${blockCount}`);

    let start = await resolveScanStart(blockCount);

    for (let height = start; height <= blockCount; height++) {
        console.log(`${height}/${blockCount} blocks (${(100 * height / blockCount).toFixed(2)}%)`);
        await fetchBlock(height, blockCount);
        blockCount = await btcClient.getBlockCount();
    }
}

async function importBatch(item: DiscoveredItem, retry: boolean = false) {
    // Skip items with errors unless this is a retry
    if (item.error && !retry) {
        return;
    }

    // Skip fully processed items (unless retrying)
    const isFullyProcessed = item.processed && !item.processed.busy && (item.processed.pending ?? 0) === 0;
    if (item.imported && isFullyProcessed && !retry) {
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

    const previousPending = item.processed?.pending ?? 0;
    let update: DiscoveredItem = { ...item };
    const end = satoshiImportBatchDuration.startTimer();

    try {
        update.imported = await gatekeeper.importBatchByCids(cids, metadata);
        update.processed = await gatekeeper.processEvents();

        // If pending count didn't decrease, no progress was made — stop retrying
        const newPending = update.processed?.pending ?? 0;
        if (!retry && newPending > 0 && newPending >= previousPending) {
            update.error = `No progress: ${newPending} pending event(s) unresolved`;
        }
    } catch (error) {
        satoshiImportErrors.inc();
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
                const list = db.discovered ?? [];
                const idx = list.findIndex(d => sameItem(d, update));
                if (idx >= 0) {
                    list[idx] = update;
                }
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
                const list = db.discovered ?? [];
                const idx = list.findIndex(d => sameItem(d, update));
                if (idx >= 0) {
                    list[idx] = update;
                }
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
    const txid = await walletAnchor(opReturnData);
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

async function getEntryFromMempool(txids: string[]): Promise<{ entry: MempoolEntry, txid: string }>  {
    if (!txids.length) {
        throw new Error('RBF: empty array');
    }

    for (let i = txids.length - 1; i >= 0; i--) {
        const txid = txids[i];
        const entry = await btcClient.getMempoolEntry(txid).catch(() => undefined);
        if (entry) {
            if (entry.fees.modified >= config.feeMax) {
                throw new Error('RBF: Pending reveal transaction already at max fee');
            }
            return { entry, txid };
        }
    }

    throw new Error('RBF: Cannot find pending reveal transaction in mempool');
}


async function replaceByFee(): Promise<boolean> {
    const db = await loadDb();

    if (!db.pending?.txids || !(await checkPendingTransactions(db.pending.txids))) {
        return false;
    }

    if (!config.rbfEnabled) {
        return true;
    }

    const blockCount = await btcClient.getBlockCount();
    if (db.pending.blockCount + config.feeConf >= blockCount) {
        return true;
    }

    const { entry, txid } = await getEntryFromMempool(db.pending.txids);

    // Check if already at max fee
    if (entry.fees.modified >= config.feeMax) {
        console.log('RBF: Pending transaction already at max fee');
        return true;
    }

    // Get recommended fee rate and compare with current tx fee rate
    const currentSatPerVb = (entry.fees.base * 1e8) / entry.vsize;
    const estimate = await btcClient.estimateSmartFee(config.feeConf, 'ECONOMICAL');
    const estimatedBtcPerKb = estimate.feerate ?? (config.feeFallback / 1e8 * 1000);
    const targetSatPerVb = (estimatedBtcPerKb / 1000) * 1e8;

    if (currentSatPerVb >= targetSatPerVb) {
        console.log(`RBF: Current fee ${currentSatPerVb.toFixed(1)} sat/vB >= estimate ${targetSatPerVb.toFixed(1)} sat/vB, skipping bump`);
        return true;
    }

    console.log(`RBF: Bumping fee from ${currentSatPerVb.toFixed(1)} sat/vB (estimate: ${targetSatPerVb.toFixed(1)} sat/vB)`);
    const newTxid = await walletBumpFee(txid);

    if (newTxid) {
        satoshiRbfBumps.inc();
        console.log(`RBF: Transaction broadcast with txid: ${newTxid}`);
        await jsonPersister.updateDb((db) => {
            if (db.pending?.txids) {
                db.pending.txids.push(newTxid);
            }
        });
    }

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

    const end = satoshiAnchorBatchDuration.startTimer();

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
                    satoshiBatchesAnchored.inc();
                    const blockCount = await btcClient.getBlockCount();
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
            const blockchainInfo = await btcClient.getBlockchainInfo();
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

async function syncBlocks(): Promise<void> {
    try {
        const latest = await gatekeeper.getBlock(REGISTRY);
        const currentMax = Math.max(latest?.height ?? 0, config.startBlock);
        const blockCount = await btcClient.getBlockCount();

        console.log(`current block height: ${blockCount}`);

        for (let height = currentMax; height <= blockCount; height++) {
            const blockHash = await btcClient.getBlockHash(height);
            const block = await btcClient.getBlock(blockHash) as Block;
            console.log(`${height}/${blockCount} blocks (${(100 * height / blockCount).toFixed(2)}%)`);
            await addBlock(height, blockHash, block.time);
        }
    } catch (error) {
        console.error(`Error syncing blocks:`, error);
    }
}

async function main() {
    console.log(`Starting Satoshi mediator v${serviceVersion} (${serviceCommit})`);

    if (!READ_ONLY && !config.nodeID) {
        console.log('satoshi-mediator must have a ARCHON_NODE_ID configured');
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
