import Hyperswarm, { HyperswarmConnection } from 'hyperswarm';
import goodbye from 'graceful-goodbye';
import b4a from 'b4a';
import { sha256 } from '@noble/hashes/sha256';
import asyncLib from 'async';
import { EventEmitter } from 'events';
import express from 'express';
import promClient from 'prom-client';

import GatekeeperClient from '@didcid/gatekeeper/client';
import KeymasterClient from '@didcid/keymaster/client';
import KuboClient from '@didcid/ipfs/kubo';
import { Operation } from '@didcid/gatekeeper/types';
import CipherNode from '@didcid/cipher/node';
import config from './config.js';
import { exit } from 'process';

interface HyperMessage {
    type: 'batch' | 'queue' | 'sync' | 'ping';
    time: string;
    node: string;
    relays: string[];
}

interface PingMessage extends HyperMessage {
    peers: string[];
}

interface BatchMessage extends HyperMessage {
    data: Operation[];
}

interface ImportQueueTask {
    name: string;
    msg: BatchMessage;
}

interface ExportQueueTask extends ImportQueueTask {
    conn: HyperswarmConnection;
}

interface NodeInfo {
    name: string;
    ipfs: any;
}

interface ConnectionInfo {
    connection: HyperswarmConnection;
    key: string;
    peerName: string;
    nodeName: string;
    did: string;
    lastSeen: number;
}

const gatekeeper = new GatekeeperClient();
const keymaster = new KeymasterClient();
const ipfs = new KuboClient();
const cipher = new CipherNode();

EventEmitter.defaultMaxListeners = 100;

const REGISTRY = 'hyperswarm';
const BATCH_SIZE = 100;

const connectionInfo: Record<string, ConnectionInfo> = {};
const knownNodes: Record<string, NodeInfo> = {};
const knownPeers: Record<string, string> = {};
const addedPeers: Record<string, number> = {};
const badPeers: Record<string, number> = {};

let swarm: Hyperswarm | null = null;
let nodeKey = '';
let nodeInfo: NodeInfo;

// --- Prometheus metrics setup ---
const register = promClient.register;
promClient.collectDefaultMetrics({ register });

const mediatorActiveConnections = new promClient.Gauge({
    name: 'mediator_active_connections',
    help: 'Number of currently active hyperswarm peer connections',
});

const mediatorImportQueueDepth = new promClient.Gauge({
    name: 'mediator_import_queue_depth',
    help: 'Number of tasks in the import queue',
});

const mediatorExportQueueDepth = new promClient.Gauge({
    name: 'mediator_export_queue_depth',
    help: 'Number of tasks in the export queue',
});

const mediatorSyncQueueDepth = new promClient.Gauge({
    name: 'mediator_sync_queue_depth',
    help: 'Number of tasks in the sync queue',
});

const mediatorKnownNodes = new promClient.Gauge({
    name: 'mediator_known_nodes',
    help: 'Number of known DID nodes',
});

const mediatorKnownPeers = new promClient.Gauge({
    name: 'mediator_known_peers',
    help: 'Number of known IPFS peers',
});

const mediatorMessagesReceived = new promClient.Counter({
    name: 'mediator_messages_received_total',
    help: 'Total messages received from peers',
    labelNames: ['type'],
});

const mediatorMessagesRelayed = new promClient.Counter({
    name: 'mediator_messages_relayed_total',
    help: 'Total messages relayed to peers',
});

const mediatorOperationsImported = new promClient.Counter({
    name: 'mediator_operations_imported_total',
    help: 'Total operations imported from peers',
});

const mediatorOperationsExported = new promClient.Counter({
    name: 'mediator_operations_exported_total',
    help: 'Total operations exported to peers',
});

const mediatorConnectionsTotal = new promClient.Counter({
    name: 'mediator_connections_total',
    help: 'Total connection events',
    labelNames: ['event'],
});

const mediatorDuplicateBatches = new promClient.Counter({
    name: 'mediator_duplicate_batches_total',
    help: 'Total duplicate batches detected and skipped',
});

const mediatorErrors = new promClient.Counter({
    name: 'mediator_errors_total',
    help: 'Total errors encountered',
    labelNames: ['operation'],
});

const mediatorImportBatchDuration = new promClient.Histogram({
    name: 'mediator_import_batch_duration_seconds',
    help: 'Duration of importBatch operations in seconds',
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
});

const mediatorExportDbDuration = new promClient.Histogram({
    name: 'mediator_export_db_duration_seconds',
    help: 'Duration of shareDb (export) operations in seconds',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
});

function updateGauges(): void {
    mediatorActiveConnections.set(Object.keys(connectionInfo).length);
    mediatorImportQueueDepth.set(importQueue.length());
    mediatorExportQueueDepth.set(exportQueue.length());
    mediatorSyncQueueDepth.set(syncQueue.length());
    mediatorKnownNodes.set(Object.keys(knownNodes).length);
    mediatorKnownPeers.set(Object.keys(knownPeers).length);
}

function startMetricsServer(): void {
    const app = express();

    app.get('/metrics', async (_req, res) => {
        try {
            updateGauges();
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

goodbye(() => {
    if (swarm) {
        swarm.destroy();
    }
});

async function createSwarm(): Promise<void> {
    if (swarm) {
        swarm.destroy();
    }

    swarm = new Hyperswarm();
    nodeKey = b4a.toString(swarm.keyPair.publicKey, 'hex');

    swarm.on('connection', conn => addConnection(conn));

    const discovery = swarm.join(topic, { client: true, server: true });
    await discovery.flushed();

    const shortTopic = shortName(b4a.toString(topic, 'hex'));
    console.log(`new hyperswarm peer id: ${shortName(nodeKey)} (${config.nodeName}) joined topic: ${shortTopic} using protocol: ${config.protocol}`);
}

let syncQueue = asyncLib.queue<HyperswarmConnection, asyncLib.ErrorCallback>(
    async function (conn, callback) {
        try {
            // Wait until the importQueue is empty
            while (importQueue.length() > 0) {
                console.log(`* sync waiting 10s for importQueue to empty. Current length: ${importQueue.length()}`);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }

            const msg: HyperMessage = {
                type: 'sync',
                time: new Date().toISOString(),
                node: nodeInfo.name,
                relays: [],
            };

            const json = JSON.stringify(msg);
            conn.write(json);
        }
        catch (error) {
            mediatorErrors.inc({ operation: 'sync' });
            console.log('sync error:', error);
        }
        callback();
    }, 1); // concurrency is 1

function addConnection(conn: HyperswarmConnection): void {
    const peerKey = b4a.toString(conn.remotePublicKey, 'hex');
    const peerName = shortName(peerKey);

    conn.once('close', () => closeConnection(peerKey));
    conn.on('data', data => receiveMsg(peerKey, data));

    console.log(`received connection from: ${peerName}`);

    // Push the connection to the syncQueue instead of writing directly
    syncQueue.push(conn);

    connectionInfo[peerKey] = {
        connection: conn,
        key: peerKey,
        peerName: peerName,
        nodeName: 'anon',
        did: '',
        lastSeen: new Date().getTime(),
    };
    mediatorConnectionsTotal.inc({ event: 'established' });

    const peerNames = Object.values(connectionInfo).map(info => info.peerName);
    console.log(`--- ${peerNames.length} nodes connected, detected nodes: ${peerNames.join(', ')}`);
}

function closeConnection(peerKey: string): void {
    const conn = connectionInfo[peerKey];
    console.log(`* connection closed with: ${conn.peerName} (${conn.nodeName}) *`);

    delete connectionInfo[peerKey];
    mediatorConnectionsTotal.inc({ event: 'closed' });
}

function shortName(peerKey: string): string {
    return peerKey.slice(0, 4) + '-' + peerKey.slice(-4);
}

function sendBatch(conn: HyperswarmConnection, batch: Operation[]): number {
    const limit = 8 * 1024 * 1014; // 8 MB limit

    const msg: BatchMessage = {
        type: 'batch',
        time: new Date().toISOString(),
        node: nodeInfo.name,
        relays: [],
        data: batch,
    };

    const json = JSON.stringify(msg);

    if (json.length < limit) {
        conn.write(json);
        mediatorOperationsExported.inc(batch.length);
        console.log(` * sent ${batch.length} ops in ${json.length} bytes`);
        return batch.length;
    }
    else {
        if (batch.length < 2) {
            console.error(`Error: Single operation exceeds the limit of ${limit} bytes. Unable to send.`);
            return 0;
        }

        // split batch into 2 halves
        const midIndex = Math.floor(batch.length / 2);
        const batch1 = batch.slice(0, midIndex);
        const batch2 = batch.slice(midIndex);

        return sendBatch(conn, batch1) + sendBatch(conn, batch2);
    }
}

function isStringArray(arr: any[]): arr is string[] {
    return arr.every(item => typeof item === 'string');
}

async function shareDb(conn: HyperswarmConnection): Promise<void> {
    const end = mediatorExportDbDuration.startTimer();
    console.time('shareDb');
    try {
        const batchSize = 1000; // export DIDs in batches of 1000 for scalability
        const dids = await gatekeeper.getDIDs();

        // Either empty or we got an DidCidDocument[] which should not happen.
        if (!isStringArray(dids)) {
            return;
        }

        for (let i = 0; i < dids.length; i += batchSize) {
            const didBatch = dids.slice(i, i + batchSize);
            const exports = await gatekeeper.exportBatch(didBatch);

            // hyperswarm distributes only operations
            const batch = exports.map(event => event.operation);
            console.log(`${batch.length} operations fetched`);

            if (!batch || batch.length === 0) {
                continue;
            }

            const opsCount = batch.length;
            console.time('sendBatch');
            const opsSent = sendBatch(conn, batch);
            console.timeEnd('sendBatch');
            console.log(` * sent ${opsSent}/${opsCount} operations`);
        }
    }
    catch (error) {
        mediatorErrors.inc({ operation: 'export' });
        console.log(error);
    }
    finally {
        end();
    }
    console.timeEnd('shareDb');
}

async function relayMsg(msg: HyperMessage): Promise<void> {
    const json = JSON.stringify(msg);

    const connectionsCount = Object.keys(connectionInfo).length;
    console.log(`Connected nodes: ${connectionsCount}`);
    console.log(`* sending ${msg.type} from: ${shortName(nodeKey)} (${config.nodeName}) *`);

    for (const peerKey in connectionInfo) {
        const conn = connectionInfo[peerKey];
        const last = new Date(conn.lastSeen);
        const now = Date.now();
        const minutesSinceLastSeen = Math.floor((now - last.getTime()) / 1000 / 60);
        const lastSeen = `last seen ${minutesSinceLastSeen} minutes ago ${last.toISOString()}`;

        if (!msg.relays.includes(peerKey)) {
            conn.connection.write(json);
            mediatorMessagesRelayed.inc();
            console.log(`* relaying to: ${conn.peerName} (${conn.nodeName}) ${lastSeen} *`);
        }
        else {
            console.log(`* skipping relay to: ${conn.peerName} (${conn.nodeName}) ${lastSeen} *`);
        }
    }
}

async function importBatch(batch: Operation[]): Promise<void> {
    // The batch we receive from other hyperswarm nodes includes just operations.
    // We have to wrap the operations in new events before submitting to our gatekeeper for importing
    const end = mediatorImportBatchDuration.startTimer();
    try {
        const hash = cipher.hashJSON(batch);
        const events = [];
        const now = new Date();
        const isoTime = now.toISOString();
        const ordTime = now.getTime();

        for (let i = 0; i < batch.length; i++) {
            events.push({
                registry: REGISTRY,
                time: isoTime,
                ordinal: [ordTime, i],
                operation: batch[i],
            })
        }

        console.log(`importBatch: ${shortName(hash)} merging ${events.length} events...`);
        console.time('importBatch');
        const response = await gatekeeper.importBatch(events);
        console.timeEnd('importBatch');
        console.log(`* ${JSON.stringify(response)}`);
        mediatorOperationsImported.inc(batch.length);
    }
    catch (error) {
        mediatorErrors.inc({ operation: 'import' });
        console.error(`importBatch error: ${error}`);
    }
    finally {
        end();
    }
}

async function mergeBatch(batch: Operation[]): Promise<void> {

    if (!batch) {
        return;
    }

    let chunk = [];
    for (const operation of batch) {
        chunk.push(operation);

        if (chunk.length >= BATCH_SIZE) {
            await importBatch(chunk);
            chunk = [];
        }
    }

    if (chunk.length > 0) {
        await importBatch(chunk);
    }

    console.time('processEvents');
    const response = await gatekeeper.processEvents();
    console.timeEnd('processEvents');
    console.log(`mergeBatch: ${JSON.stringify(response)}`);
}

let importQueue = asyncLib.queue<ImportQueueTask, asyncLib.ErrorCallback>(
    async function (task, callback) {
        const { name, msg } = task;
        try {
            const ready = await gatekeeper.isReady();

            if (ready) {
                const batch = msg.data || [];

                if (batch.length === 0) {
                    return;
                }

                const nodeName = msg.node || 'anon';
                console.log(`* merging batch (${batch.length} events) from: ${shortName(name)} (${nodeName}) *`);
                await mergeBatch(batch);
            }
        }
        catch (error) {
            mediatorErrors.inc({ operation: 'import' });
            console.log('mergeBatch error:', error);
        }
        callback();
    }, 1); // concurrency is 1

let exportQueue = asyncLib.queue<ExportQueueTask, asyncLib.ErrorCallback>(
    async function (task, callback) {
        const { name, msg, conn } = task;
        try {
            const ready = await gatekeeper.isReady();

            if (ready) {
                console.log(`* sharing db with: ${shortName(name)} (${msg.node || 'anon'}) *`);
                await shareDb(conn);
            }
        }
        catch (error) {
            mediatorErrors.inc({ operation: 'export' });
            console.log('shareDb error:', error);
        }
        callback();
    }, 1); // concurrency is 1


const batchesSeen: Record<string, boolean> = {};

function newBatch(batch: Operation[]): boolean {
    const hash = cipher.hashJSON(batch);

    if (!batchesSeen[hash]) {
        batchesSeen[hash] = true;
        return true;
    }

    return false;
}

async function addPeer(did: string): Promise<void> {
    // Check peer suffix to avoid duplicate DID aliases
    const suffix = did.split(':').pop() || '';

    if (suffix in addedPeers) {
        return;
    }

    console.log(`Adding peer ${did}...`);
    addedPeers[suffix] = Date.now();

    try {
        const docs = await keymaster.resolveDID(did);
        const data = docs.didDocumentData as { node: NodeInfo };

        if (!data?.node || !data.node.ipfs) {
            return;
        }

        const { id, addresses } = data.node.ipfs;

        if (!id || !addresses) {
            return;
        }

        if (id !== nodeInfo.ipfs.id) {
            // A node should never add itself as a peer node
            await ipfs.addPeeringPeer(id, addresses);
        }

        knownNodes[did] = {
            name: data.node.name,
            ipfs: {
                id,
                addresses,
            },
        };

        knownPeers[id] = data.node.name;

        console.log(`Added IPFS peer: ${did} ${JSON.stringify(knownNodes[did], null, 4)}`);
    }
    catch (error) {
        if (!(did in badPeers)) {
            // Store time of first error so we can later implement a retry mechanism
            badPeers[did] = Date.now();
            mediatorErrors.inc({ operation: 'peer' });
            console.error(`Error adding IPFS peer: ${did}`, error);
        }
    }
}

async function receiveMsg(peerKey: string, json: string): Promise<void> {
    const conn = connectionInfo[peerKey];
    let msg;

    try {
        msg = JSON.parse(json);
    }
    catch (error) {
        mediatorErrors.inc({ operation: 'parse' });
        const jsonPreview = json.length > 80 ? `${json.slice(0, 40)}...${json.slice(-40)}` : json;
        console.log(`received invalid message from: ${conn.peerName}, JSON: ${jsonPreview}`);
        return;
    }

    const nodeName = msg.node || 'anon';
    mediatorMessagesReceived.inc({ type: msg.type });

    console.log(`received ${msg.type} from: ${shortName(peerKey)} (${nodeName})`);
    connectionInfo[peerKey].lastSeen = new Date().getTime();

    if (msg.type === 'batch') {
        if (newBatch(msg.data)) {
            importQueue.push({ name: peerKey, msg });
        } else {
            mediatorDuplicateBatches.inc();
        }
        return;
    }

    if (msg.type === 'queue') {
        if (newBatch(msg.data)) {
            importQueue.push({ name: peerKey, msg });
            msg.relays.push(peerKey);
            await relayMsg(msg);
        } else {
            mediatorDuplicateBatches.inc();
        }
        return;
    }

    if (msg.type === 'sync') {
        exportQueue.push({ name: peerKey, msg, conn: conn.connection });
        return;
    }

    if (msg.type === 'ping') {
        connectionInfo[peerKey].nodeName = nodeName;

        if (msg.peers) {
            for (const did of msg.peers) {
                addPeer(did);
            }
        }

        return;
    }

    console.log(`unknown message type: ${msg.type}`);
}

async function flushQueue(): Promise<void> {
    const batch = await gatekeeper.getQueue(REGISTRY);
    console.log(`${REGISTRY} queue: ${JSON.stringify(batch, null, 4)}`);

    if (batch.length > 0) {
        const msg: BatchMessage = {
            type: 'queue',
            time: new Date().toISOString(),
            node: nodeInfo.name,
            relays: [],
            data: batch,
        };

        await gatekeeper.clearQueue(REGISTRY, batch);
        await relayMsg(msg);
        await mergeBatch(batch);
    }
}

async function exportLoop(): Promise<void> {
    try {
        await flushQueue();
    } catch (error) {
        mediatorErrors.inc({ operation: 'export' });
        console.error(`Error in exportLoop: ${error}`);
    }

    const importQueueLength = importQueue.length();

    if (importQueueLength > 0) {
        const delay = 60;
        console.log(`export loop waiting ${delay}s for import queue to clear: ${importQueueLength}...`);
        setTimeout(exportLoop, delay * 1000);
    }
    else {
        console.log(`export loop waiting ${config.exportInterval}s...`);
        setTimeout(exportLoop, config.exportInterval * 1000);
    }
}

async function checkConnections(): Promise<void> {
    if (Object.keys(connectionInfo).length === 0) {
        console.log("No active connections, rejoining the topic...");
        await createSwarm();
        return;
    }

    const expireLimit = 3 * 60 * 1000; // 3 minutes in milliseconds
    const now = Date.now();

    for (const peerKey in connectionInfo) {
        const conn = connectionInfo[peerKey];
        const timeSinceLastSeen = now - conn.lastSeen;

        if (timeSinceLastSeen > expireLimit) {
            console.log(`Removing stale connection info for: ${conn.peerName} (${conn.nodeName}), last seen ${timeSinceLastSeen / 1000}s ago`);
            delete connectionInfo[peerKey];
        }
    }
}

async function connectionLoop(): Promise<void> {
    try {
        console.log(`Node info: ${JSON.stringify(nodeInfo, null, 4)}`);
        console.log(`Connected to hyperswarm protocol: ${config.protocol}`);

        await checkConnections();

        const msg: PingMessage = {
            type: 'ping',
            time: new Date().toISOString(),
            node: nodeInfo.name,
            relays: [],
            peers: Object.keys(knownNodes),
        };

        await relayMsg(msg);

        const peeringPeers = await ipfs.getPeeringPeers();
        console.log(`IPFS peers: ${peeringPeers.length}`);
        for (const peer of peeringPeers) {
            console.log(`* peer ${peer.ID} (${knownPeers[peer.ID]})`);
        }

        console.log('connection loop waiting 60s...');
    } catch (error) {
        console.error(`Error in pingLoop: ${error}`);
    }
    setTimeout(connectionLoop, 60 * 1000);
}

process.on('uncaughtException', (error) => {
    console.error('Unhandled exception caught', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

process.stdin.on('data', d => {
    if (d.toString().startsWith('q')) {
        process.exit();
    }
});

// Join a common topic
const hash = sha256(config.protocol);
const networkID = Buffer.from(hash).toString('hex');
const topic = Buffer.from(b4a.from(networkID, 'hex'));

async function main(): Promise<void> {
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

    if (!config.nodeID) {
        console.log('nodeID is not set. Please set the nodeID in the config file.');
        exit(1);
    }

    const { didDocument } = await keymaster.resolveDID(config.nodeID);

    if (!didDocument) {
        console.error(`DID document not found for nodeID: ${config.nodeID}`);
        exit(1);
    }

    const nodeDID = didDocument.id;

    if (!nodeDID) {
        console.error(`DID not found in the DID document for nodeID: ${config.nodeID}`);
        exit(1);
    }

    console.log(`Using nodeID: ${config.nodeID} (${nodeDID})`);

    await ipfs.connect({
        url: config.ipfsURL,
        waitUntilReady: true,
        intervalSeconds: 5,
        chatty: true,
    });
    await ipfs.resetPeeringPeers();

    const ipfsID = await ipfs.getPeerID();
    const ipfsAddresses = await ipfs.getAddresses();
    console.log(`Using IPFS nodeID: ${JSON.stringify(ipfsID, null, 4)}`);

    nodeInfo = {
        name: config.nodeName,
        ipfs: {
            id: ipfsID,
            addresses: ipfsAddresses,
        },
    };

    knownNodes[nodeDID] = nodeInfo;

    startMetricsServer();

    await exportLoop();
    await keymaster.mergeData(nodeDID, { node: nodeInfo });
    await connectionLoop();
}

main();
