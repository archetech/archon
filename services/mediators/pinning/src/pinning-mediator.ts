import express from 'express';
import { readFile } from 'fs/promises';
import promClient from 'prom-client';

import CipherNode from '@didcid/cipher/node';
import GatekeeperClient from '@didcid/clients/gatekeeper';
import config from './config.js';
import { createProvider } from './provider.js';
import { JsonPinStore } from './state.js';
import { processPinningQueue } from './sync.js';

const REGISTRY = 'pin';
const gatekeeper = new GatekeeperClient();
const cipher = new CipherNode();
const store = new JsonPinStore(config.statePath);
const provider = createProvider();

const register = promClient.register;
promClient.collectDefaultMetrics({ register });

const queueDepth = new promClient.Gauge({
    name: 'pinning_mediator_queue_depth',
    help: 'Number of operations in the pin Gatekeeper queue',
});

const pinsTotal = new promClient.Counter({
    name: 'pinning_mediator_pins_total',
    help: 'Total generic pinning attempts',
    labelNames: ['provider', 'status'],
});

const pinRecords = new promClient.Gauge({
    name: 'pinning_mediator_pin_records',
    help: 'Number of locally recorded pin records',
    labelNames: ['provider', 'status'],
});

const importActive = new promClient.Gauge({
    name: 'pinning_mediator_import_active',
    help: '1 if the import loop is currently executing',
});

const serviceVersionInfo = new promClient.Gauge({
    name: 'service_version_info',
    help: 'Service version information',
    labelNames: ['version', 'commit'],
});

let serviceVersion = 'unknown';
const serviceCommit = (process.env.GIT_COMMIT || 'unknown').slice(0, 7);
let importRunning = false;

readFile(new URL('../package.json', import.meta.url), 'utf-8').then(data => {
    const pkg = JSON.parse(data);
    serviceVersion = pkg.version;
    serviceVersionInfo.set({ version: serviceVersion, commit: serviceCommit }, 1);
}).catch(() => {
    serviceVersionInfo.set({ version: 'unknown', commit: serviceCommit }, 1);
});

async function importQueue(): Promise<void> {
    if (importRunning) {
        return;
    }

    importRunning = true;
    importActive.set(1);

    try {
        const result = await processPinningQueue(REGISTRY, gatekeeper, store, cipher, provider, config.origins);
        queueDepth.set(result.queued);

        if (result.queued === 0) {
            console.log(`empty ${REGISTRY} queue`);
            return;
        }

        if (result.pinned > 0) {
            pinsTotal.inc({ provider: provider.name, status: 'pinned' }, result.pinned);
            console.log(`Pinned ${result.pinned} ${REGISTRY} operation(s) with ${provider.name}`);
        }

        if (result.pending > 0) {
            pinsTotal.inc({ provider: provider.name, status: 'pinning' }, result.pending);
            console.log(`${result.pending} ${REGISTRY} operation(s) still pending with ${provider.name}`);
        }

        if (result.failed > 0) {
            pinsTotal.inc({ provider: provider.name, status: 'failed' }, result.failed);
            const suffix = result.lastError ? `: ${result.lastError}` : '';
            console.error(`Pinning failed${suffix}; leaving remaining operation(s) queued`);
        }

        pinRecords.set({ provider: provider.name, status: 'queued' }, store.count('queued', provider.name));
        pinRecords.set({ provider: provider.name, status: 'pinning' }, store.count('pinning', provider.name));
        pinRecords.set({ provider: provider.name, status: 'pinned' }, store.count('pinned', provider.name));
        pinRecords.set({ provider: provider.name, status: 'failed' }, store.count('failed', provider.name));
    } finally {
        importActive.set(0);
        importRunning = false;
    }
}

function startMetricsServer(): void {
    const app = express();

    app.get('/health', (_req, res) => {
        res.json({ ok: true });
    });

    app.get('/ready', async (_req, res) => {
        try {
            res.json({ ready: await gatekeeper.isReady(), provider: provider.name });
        } catch {
            res.json({ ready: false, provider: provider.name });
        }
    });

    app.get('/version', (_req, res) => {
        res.json({ version: serviceVersion, commit: serviceCommit, provider: provider.name });
    });

    app.get('/metrics', async (_req, res) => {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    });

    app.listen(config.metricsPort, () => {
        console.log(`Metrics server listening on port ${config.metricsPort}`);
    });
}

async function main(): Promise<void> {
    console.log(`Starting Pinning mediator v${serviceVersion} (${serviceCommit})`);
    console.log(`Connecting to gatekeeper at ${config.gatekeeperURL}/api/v1`);
    await gatekeeper.connect({ url: config.gatekeeperURL, apiKey: config.adminApiKey });
    console.log(`Using ${provider.name} pinning provider at ${config.apiUrl}`);
    startMetricsServer();

    if (config.importInterval > 0) {
        console.log(`Importing pin queue every ${config.importInterval} minute(s)`);
        await importQueue();
        setInterval(importQueue, config.importInterval * 60_000);
    } else {
        console.log('Pinning import loop disabled');
    }
}

main().catch(error => {
    console.error('Pinning mediator failed:', error);
    process.exit(1);
});
