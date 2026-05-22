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
import {
    Connection,
    Finality,
    ParsedInstruction,
    PartiallyDecodedInstruction,
    PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';

const REGISTRY = config.chain;
const READ_ONLY = config.exportInterval === 0;
const ARCHON_ADMIN_HEADER = 'X-Archon-Admin-Key';
const ARCHON_MEMO_PREFIX = 'ARCHON_BATCH_V1:';
const SLOT_OVERLAP = 64;
const CHECKPOINT_BLOCK_INTERVAL = 100;
const CHECKPOINT_SLOT_CHUNK = 1000;
const CHECKPOINT_SLOT_LOOKBACK = 1000;
const CHECKPOINT_SLOT_CHUNKS_PER_CYCLE = 10;

const connection = new Connection(config.rpcUrl, config.commitment);
const registryAddress = new PublicKey(config.registryAddress);
const cipher = new CipherNode();
const gatekeeper = new GatekeeperClient();
const keymaster = new KeymasterClient();

let jsonPersister: MediatorDbInterface;
let importRunning = false;
let exportRunning = false;

function transactionFinality(): Finality {
    return config.commitment === 'finalized' ? 'finalized' : 'confirmed';
}

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

function isRateLimitError(error: unknown): boolean {
    const anyError = error as { code?: unknown; status?: unknown; message?: unknown };
    const message = typeof anyError?.message === 'string' ? anyError.message : formatError(error);
    return anyError?.code === 429 || anyError?.status === 429 || /429|too many requests/i.test(message);
}

function walletHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.adminApiKey) {
        headers[ARCHON_ADMIN_HEADER] = config.adminApiKey;
    }
    return headers;
}

async function walletGetBalance(): Promise<{ balance: number; balanceLamports: string }> {
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
        { batchDid, batchHash, opCount },
        { headers: walletHeaders() }
    );
    return data.txid;
}

async function walletGetTransaction(txid: string): Promise<{ confirmations: number; slot?: number } | undefined> {
    try {
        const { data } = await axios.get(`${config.walletURL}/api/v1/wallet/transaction/${txid}`, { headers: walletHeaders() });
        return data;
    } catch {
        return undefined;
    }
}

const register = promClient.register;
promClient.collectDefaultMetrics({ register });

const solanaBlockHeight = new promClient.Gauge({
    name: 'solana_block_height',
    help: 'Current scanned slot height',
});

const solanaBlockCount = new promClient.Gauge({
    name: 'solana_block_count',
    help: 'Total Solana slot height',
});

const solanaBlocksPending = new promClient.Gauge({
    name: 'solana_blocks_pending',
    help: 'Remaining slots to scan',
});

const solanaBlocksScanned = new promClient.Gauge({
    name: 'solana_blocks_scanned',
    help: 'Total slots scanned',
});

const solanaTxnsScanned = new promClient.Gauge({
    name: 'solana_txns_scanned',
    help: 'Total Archon memo transactions scanned',
});

const solanaDidsDiscovered = new promClient.Gauge({
    name: 'solana_dids_discovered',
    help: 'Total DIDs found on chain',
});

const solanaDidsRegistered = new promClient.Gauge({
    name: 'solana_dids_registered',
    help: 'Total DIDs anchored to chain',
});

const solanaPendingTxs = new promClient.Gauge({
    name: 'solana_pending_txs',
    help: 'Count of pending broadcast transactions',
});

const solanaImportLoopRunning = new promClient.Gauge({
    name: 'solana_import_loop_running',
    help: '1 if import loop is currently executing',
});

const solanaExportLoopRunning = new promClient.Gauge({
    name: 'solana_export_loop_running',
    help: '1 if export loop is currently executing',
});

const solanaImportErrors = new promClient.Counter({
    name: 'solana_import_errors_total',
    help: 'Failed import attempts',
});

const solanaBatchesAnchored = new promClient.Counter({
    name: 'solana_batches_anchored_total',
    help: 'Successful batch anchors to blockchain',
});

const solanaImportBatchDuration = new promClient.Histogram({
    name: 'solana_import_batch_duration_seconds',
    help: 'Duration of importBatch operations in seconds',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
});

const solanaAnchorBatchDuration = new promClient.Histogram({
    name: 'solana_anchor_batch_duration_seconds',
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
    solanaBlockHeight.set(db.height);
    solanaBlockCount.set(db.blockCount);
    solanaBlocksPending.set(db.blocksPending);
    solanaBlocksScanned.set(db.blocksScanned);
    solanaTxnsScanned.set(db.txnsScanned);
    solanaDidsDiscovered.set(db.discovered.length);
    solanaDidsRegistered.set(db.registered.length);
    solanaPendingTxs.set(db.pending?.txids?.length ?? 0);
    solanaImportLoopRunning.set(importRunning ? 1 : 0);
    solanaExportLoopRunning.set(exportRunning ? 1 : 0);
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
    const totalSlots = Math.max(1, blockCount + 1);
    const completedSlots = Math.min(totalSlots, Math.max(0, height + 1));

    return (100 * completedSlots / totalSlots).toFixed(2);
}

async function addBlock(height: number, hash: string, time: number): Promise<void> {
    await gatekeeper.addBlock(REGISTRY, { hash, height, time });
}

async function getSlotBlock(slot: number, finality: Finality = transactionFinality()): Promise<{ height: number; hash: string; time: number } | undefined> {
    const block = await connection.getBlock(slot, {
        commitment: finality,
        transactionDetails: 'none',
        rewards: false,
    });

    const rpcBlock = block as typeof block & { blockHeight?: number | null };

    if (!block?.blockhash || block.blockTime === null || rpcBlock.blockHeight == null) {
        return undefined;
    }

    return {
        height: rpcBlock.blockHeight,
        hash: block.blockhash,
        time: block.blockTime,
    };
}

async function getNearestProducedBlockAtOrBefore(slot: number, finality: Finality): Promise<{ slot: number; height: number } | undefined> {
    const startSlot = Math.max(0, slot - CHECKPOINT_SLOT_LOOKBACK);
    const slots = await connection.getBlocks(startSlot, slot, finality);
    const producedSlot = slots.at(-1);

    if (producedSlot === undefined) {
        return undefined;
    }

    const block = await getSlotBlock(producedSlot, finality);
    return block ? { slot: producedSlot, height: block.height } : undefined;
}

async function getBlocksOrPause(startSlot: number, endSlot: number, finality: Finality): Promise<number[] | undefined> {
    try {
        return await connection.getBlocks(startSlot, endSlot, finality);
    } catch (error) {
        if (isRateLimitError(error)) {
            console.log(`Pausing ${REGISTRY} checkpoint sync at slot ${startSlot}: Solana RPC rate limit`);
            return undefined;
        }
        throw error;
    }
}

async function getSlotBlockOrPause(slot: number, finality: Finality): Promise<{ height: number; hash: string; time: number } | undefined | 'rate-limited'> {
    try {
        return await getSlotBlock(slot, finality);
    } catch (error) {
        if (isRateLimitError(error)) {
            console.log(`Pausing ${REGISTRY} checkpoint sync at slot ${slot}: Solana RPC rate limit`);
            return 'rate-limited';
        }
        throw error;
    }
}

async function findFirstSlotAtOrAfterBlockHeight(targetHeight: number, currentSlot: number, finality: Finality): Promise<number> {
    if (targetHeight <= 0) {
        return 0;
    }

    let low = 0;
    let high = currentSlot;
    let result = currentSlot;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        let produced: { slot: number; height: number } | undefined;
        try {
            produced = await getNearestProducedBlockAtOrBefore(mid, finality);
        } catch (error) {
            if (isRateLimitError(error)) {
                console.log(`Pausing ${REGISTRY} checkpoint sync while finding start block ${targetHeight}: Solana RPC rate limit`);
                return currentSlot + 1;
            }
            throw error;
        }

        if (!produced || produced.height < targetHeight) {
            low = mid + 1;
            continue;
        }

        result = produced.slot;
        high = mid - 1;
    }

    return Math.max(0, result - CHECKPOINT_SLOT_LOOKBACK);
}

async function syncBlockCheckpoints(): Promise<void> {
    const finality: Finality = 'finalized';
    const currentSlot = await connection.getSlot(finality);
    const currentBlockHeight = await connection.getBlockHeight(finality);

    if (config.startBlock > currentBlockHeight) {
        console.log(`Skipping ${REGISTRY} checkpoint sync because start block ${config.startBlock} is ahead of finalized block height ${currentBlockHeight}`);
        return;
    }

    const db = await loadDb();
    let startSlot = db.checkpointSlot !== undefined && (db.checkpointHeight ?? 0) >= config.startBlock
        ? Math.max(0, db.checkpointSlot + 1)
        : await findFirstSlotAtOrAfterBlockHeight(config.startBlock, currentSlot, finality);

    let checkpointed = 0;
    let maxCheckpointHeight = db.checkpointHeight ?? 0;
    let chunksProcessed = 0;

    while (startSlot <= currentSlot && chunksProcessed < CHECKPOINT_SLOT_CHUNKS_PER_CYCLE) {
        const endSlot = Math.min(currentSlot, startSlot + CHECKPOINT_SLOT_CHUNK - 1);
        const slots = await getBlocksOrPause(startSlot, endSlot, finality);
        if (!slots) {
            return;
        }
        let processedThroughSlot = endSlot;
        chunksProcessed += 1;

        if (slots.length > 0) {
            const firstBlock = await getSlotBlockOrPause(slots[0], finality);
            if (firstBlock === 'rate-limited') {
                return;
            }

            if (firstBlock) {
                const lastHeight = firstBlock.height + slots.length - 1;
                let processedThroughHeight = lastHeight;

                let checkpointIndex = (CHECKPOINT_BLOCK_INTERVAL - (firstBlock.height % CHECKPOINT_BLOCK_INTERVAL)) % CHECKPOINT_BLOCK_INTERVAL;
                while (firstBlock.height + checkpointIndex < config.startBlock) {
                    checkpointIndex += CHECKPOINT_BLOCK_INTERVAL;
                }

                for (let index = checkpointIndex; index < slots.length; index += CHECKPOINT_BLOCK_INTERVAL) {
                    const block = await getSlotBlockOrPause(slots[index], finality);
                    if (block === 'rate-limited') {
                        return;
                    }

                    if (!block) {
                        processedThroughSlot = slots[index] - 1;
                        processedThroughHeight = firstBlock.height + index - 1;
                        break;
                    }

                    if (block.height < config.startBlock || block.height % CHECKPOINT_BLOCK_INTERVAL !== 0) {
                        continue;
                    }

                    await addBlock(block.height, block.hash, block.time);
                    checkpointed += 1;
                }

                maxCheckpointHeight = Math.max(maxCheckpointHeight, processedThroughHeight);
            } else {
                processedThroughSlot = slots[0] - 1;
            }
        }

        await jsonPersister.updateDb((db) => {
            db.checkpointSlot = processedThroughSlot;
            db.checkpointHeight = Math.max(db.checkpointHeight ?? 0, maxCheckpointHeight);
        });

        startSlot = processedThroughSlot + 1;

        if (processedThroughSlot < endSlot) {
            break;
        }
    }

    const pending = startSlot <= currentSlot ? `; checkpoint catch-up will resume from slot ${startSlot}` : '';
    console.log(`Synced ${checkpointed} ${REGISTRY} block checkpoint(s) through finalized block height ${currentBlockHeight}${pending}`);
}

function parseArchonMemo(memo: string): { batchDid: string; batchHash: string; opCount: number } | undefined {
    if (!memo.startsWith(ARCHON_MEMO_PREFIX)) {
        return undefined;
    }

    try {
        const payload = JSON.parse(memo.slice(ARCHON_MEMO_PREFIX.length));
        const batchDid = String(payload.batchDid);
        const batchHash = String(payload.batchHash);
        const opCount = Number(payload.opCount ?? 0);

        if (!batchDid.startsWith('did:cid:') || !isValidDID(batchDid)) {
            return undefined;
        }
        if (!/^0x[0-9a-fA-F]{64}$/.test(batchHash)) {
            return undefined;
        }

        return { batchDid, batchHash, opCount };
    } catch {
        return undefined;
    }
}

function memoFromInstruction(instruction: ParsedInstruction | PartiallyDecodedInstruction): string | undefined {
    if (!('programId' in instruction) || instruction.programId.toBase58() !== config.memoProgramId) {
        return undefined;
    }

    if ('parsed' in instruction) {
        return typeof instruction.parsed === 'string' ? instruction.parsed : undefined;
    }

    try {
        return Buffer.from(bs58.decode(instruction.data)).toString('utf8');
    } catch {
        return undefined;
    }
}

async function scanSignatures(): Promise<void> {
    const currentSlot = await connection.getSlot(config.commitment);
    const currentBlockHeight = await connection.getBlockHeight(config.commitment);
    const db = await loadDb();
    const scanFloor = db.height > 0 ? Math.max(0, db.height - SLOT_OVERLAP) : 0;

    console.log(`current slot height: ${currentSlot}, current block height: ${currentBlockHeight}, scan floor: ${scanFloor}, start block: ${config.startBlock}`);

    if (config.startBlock > currentBlockHeight) {
        console.log(`Skipping ${REGISTRY} scan because start block ${config.startBlock} is ahead of current block height ${currentBlockHeight}`);
        return;
    }

    const candidates: { signature: string; slot: number; blockTime?: number | null }[] = [];
    let before: string | undefined;

    for (let page = 0; page < config.signaturePageMax; page++) {
        const signatures = await connection.getSignaturesForAddress(registryAddress, {
            limit: config.signaturePageLimit,
            before,
        }, transactionFinality());

        if (signatures.length === 0) {
            break;
        }

        for (const signature of signatures) {
            if (signature.slot < scanFloor) {
                break;
            }
            candidates.push(signature);
        }

        if (signatures.some(signature => signature.slot < scanFloor)) {
            break;
        }

        before = signatures.at(-1)?.signature;
    }

    candidates.sort((a, b) => a.slot - b.slot);
    console.log(`Scanning ${candidates.length} Solana memo signature(s)`);

    let maxSlot = db.height;
    let maxSlotTime = db.time;
    let maxSlotHash = db.hash;
    let scanned = 0;

    for (const candidate of candidates) {
        const tx = await connection.getParsedTransaction(candidate.signature, {
            commitment: transactionFinality(),
            maxSupportedTransactionVersion: 0,
        });

        if (!tx) {
            continue;
        }

        const block = await getSlotBlock(candidate.slot);
        if (!block) {
            continue;
        }

        const blockTime = block.time;
        const blockHash = block.hash;
        const instructions = tx.transaction.message.instructions;

        if (candidate.slot > maxSlot) {
            maxSlot = candidate.slot;
            maxSlotTime = new Date(blockTime * 1000).toISOString();
            maxSlotHash = blockHash;
        }

        if (block.height < config.startBlock) {
            continue;
        }

        for (let index = 0; index < instructions.length; index++) {
            const memo = memoFromInstruction(instructions[index]);
            if (!memo) {
                continue;
            }

            const parsed = parseArchonMemo(memo);
            if (!parsed) {
                continue;
            }

            const item: DiscoveredItem = {
                height: block.height,
                slot: candidate.slot,
                index,
                time: new Date(blockTime * 1000).toISOString(),
                txid: candidate.signature,
                blockHash,
                batchHash: parsed.batchHash,
                did: parsed.batchDid,
                opCount: parsed.opCount,
            };

            await jsonPersister.updateDb((db) => {
                const itemKey = discoveredKey(item);
                if (!db.discovered.some(discovered => discoveredKey(discovered) === itemKey)) {
                    db.discovered.push(item);
                }
            });

            await addBlock(block.height, blockHash, blockTime);
            scanned += 1;
        }
    }

    await jsonPersister.updateDb((db) => {
        db.height = Math.max(db.height, maxSlot);
        db.hash = maxSlotHash;
        db.time = maxSlotTime;
        db.blocksScanned = Math.max(0, db.height + 1);
        db.txnsScanned += scanned;
        db.blockCount = currentSlot;
        db.blocksPending = Math.max(0, currentSlot - db.height);
    });

    if (maxSlot > 0) {
        console.log(`${maxSlot}/${currentSlot} slots (${formatSyncProgress(maxSlot, currentSlot)}%)`);
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
        solanaImportErrors.inc();
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
        } as DidRegistration,
    };

    const previousPending = item.processed?.pending;
    const update: DiscoveredItem = { ...item };
    const end = solanaImportBatchDuration.startTimer();

    try {
        update.imported = await gatekeeper.importBatchByCids(batch.ops, metadata);
        update.processed = await gatekeeper.processEvents();

        const newPending = update.processed?.pending ?? 0;
        if (!retry && newPending > 0 && previousPending !== undefined && newPending >= previousPending) {
            update.error = `No progress: ${newPending} pending event(s) unresolved`;
        }
    } catch (error) {
        solanaImportErrors.inc();
        update.error = formatError(error);
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

async function checkPendingTransactions(pending: NonNullable<MediatorDb['pending']>): Promise<boolean> {
    const txids = pending.txids ?? [];

    for (const txid of txids) {
        const tx = await walletGetTransaction(txid);
        if (tx && tx.confirmations > 0) {
            await jsonPersister.updateDb((db) => { db.pending = undefined; });
            return false;
        }
    }

    const currentSlot = await connection.getSlot(config.commitment);
    const elapsedSlots = Math.max(0, currentSlot - pending.blockCount);

    if (config.pendingTxTimeoutSlots > 0 && elapsedSlots >= config.pendingTxTimeoutSlots && pending.batchDid && pending.batchHash) {
        try {
            const txid = await walletAnchor(pending.batchDid, pending.batchHash, pending.opCount ?? 0);
            await jsonPersister.updateDb((db) => {
                if (db.pending) {
                    db.pending.txids = [...(db.pending.txids ?? []), txid];
                    db.pending.blockCount = currentSlot;
                }
            });
            console.log(`Re-anchored stale ${REGISTRY} batch ${pending.batchDid}: ${txid}`);
        } catch (error) {
            console.log(`Unable to re-anchor stale ${REGISTRY} batch ${pending.batchDid}: ${formatError(error)}`);
        }
        return true;
    }

    if (txids.length) {
        console.log(`pending txid ${txids.at(-1)} (${elapsedSlots}/${config.pendingTxTimeoutSlots} slots)`);
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

    const end = solanaAnchorBatchDuration.startTimer();

    try {
        try {
            const { balance, balanceLamports } = await walletGetBalance();
            if (BigInt(balanceLamports) < config.minSolBalanceLamports) {
                const address = await walletGetAddress();
                console.log(`Wallet has ${balance} SOL, below gas floor ${config.minSolBalanceLamports} lamports. Send ${config.chain} funds to ${address}`);
                return;
            }
        } catch {
            console.log(`${config.chain} wallet service not accessible`);
            return;
        }

        const db = await loadDb();
        if (db.pending?.txids && await checkPendingTransactions(db.pending)) {
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
                    solanaBatchesAnchored.inc();
                    const blockCount = await connection.getSlot(config.commitment);
                    await jsonPersister.updateDb((db) => {
                        (db.registered ??= []).push({ did, txid, batchHash });
                        db.pending = { txids: [txid], blockCount, batchDid: did, batchHash, opCount: cids.length };
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
    let stage = 'syncBlockCheckpoints';

    try {
        await syncBlockCheckpoints();
        stage = 'scanSignatures';
        await scanSignatures();
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
    console.log(`Connecting to ${config.chain} JSON-RPC at ${config.rpcUrl}`);

    while (true) {
        try {
            const version = await connection.getVersion();
            console.log(`Connected to Solana ${config.network}: ${JSON.stringify(version)}`);
            break;
        } catch (error: any) {
            console.log(`Waiting for ${config.chain} node: ${error.message}`);
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

async function main() {
    console.log(`Starting Solana mediator v${serviceVersion} (${serviceCommit})`);

    if (!READ_ONLY && !config.nodeID) {
        console.log('solana-mediator must have ARCHON_NODE_ID configured');
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
