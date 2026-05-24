import axios from 'axios';
import express from 'express';
import { readFile } from 'fs/promises';
import promClient from 'prom-client';

import CipherNode from '@didcid/cipher/node';
import GatekeeperClient from '@didcid/gatekeeper/client';
import config from './config.js';
import { JsonPinStore } from './state.js';
import { processFilecoinQueue } from './sync.js';

const REGISTRY = 'pin';
const gatekeeper = new GatekeeperClient();
const cipher = new CipherNode();
const store = new JsonPinStore(config.statePath);

const register = promClient.register;
promClient.collectDefaultMetrics({ register });

const filecoinQueueDepth = new promClient.Gauge({
    name: 'filecoin_mediator_queue_depth',
    help: 'Number of operations in the pin Gatekeeper queue',
});

const filecoinPinsTotal = new promClient.Counter({
    name: 'filecoin_mediator_pins_total',
    help: 'Total Filecoin pin attempts',
    labelNames: ['status'],
});

const filecoinPinRecords = new promClient.Gauge({
    name: 'filecoin_mediator_pin_records',
    help: 'Number of locally recorded Filecoin pin records',
    labelNames: ['status'],
});

const filecoinImportActive = new promClient.Gauge({
    name: 'filecoin_mediator_import_active',
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

function adminHeaders(): Record<string, string> {
    return config.adminApiKey ? { 'X-Archon-Admin-Key': config.adminApiKey } : {};
}

async function walletPin(cid: string, fingerprint: string, registry?: string): Promise<unknown> {
    const response = await axios.post(
        `${config.walletURL}/api/v1/wallet/pin`,
        { cid, fingerprint, registry },
        { headers: adminHeaders(), timeout: 300_000 }
    );
    return response.data;
}

async function walletGetVersion(): Promise<any> {
    const response = await axios.get(`${config.walletURL}/api/v1/wallet/version`, {
        headers: adminHeaders(),
        timeout: 30_000,
    });
    return response.data;
}

function fundingAddressFromVersion(version: any): string | undefined {
    return typeof version?.address === 'string' ? version.address : undefined;
}

function missingFundingToken(error: string | undefined): string | undefined {
    if (!error) {
        return undefined;
    }
    if (error.includes('Insufficient FIL')) {
        return 'FIL';
    }
    if (error.includes('USDFC')) {
        return 'USDFC';
    }
    return undefined;
}

async function importQueue(): Promise<void> {
    if (importRunning) {
        return;
    }

    importRunning = true;
    filecoinImportActive.set(1);

    try {
        const result = await processFilecoinQueue(REGISTRY, gatekeeper, store, cipher, walletPin);
        filecoinQueueDepth.set(result.queued);

        if (result.queued === 0) {
            console.log(`empty ${REGISTRY} queue`);
            return;
        }

        if (result.pinned > 0) {
            filecoinPinsTotal.inc({ status: 'pinned' }, result.pinned);
            console.log(`Pinned ${result.pinned} ${REGISTRY} operation(s) to Filecoin`);
        }

        if (result.failed > 0) {
            filecoinPinsTotal.inc({ status: 'failed' }, result.failed);
            const suffix = result.lastError ? `: ${result.lastError}` : '';
            console.error(`Filecoin pin failed${suffix}; leaving remaining operation(s) queued`);
            const token = missingFundingToken(result.lastError);
            if (token) {
                try {
                    const version = await walletGetVersion();
                    const address = fundingAddressFromVersion(version);
                    if (address) {
                        const network = version.network ? `${version.network} ` : '';
                        console.log(`Filecoin wallet needs ${network}${token}. Send ${network}${token} to ${address}`);
                    }
                } catch (error: any) {
                    console.error(`Unable to fetch Filecoin wallet funding address: ${error?.message || String(error)}`);
                }
            }
        }

        filecoinPinRecords.set({ status: 'pinned' }, store.count('pinned'));
        filecoinPinRecords.set({ status: 'failed' }, store.count('failed'));
    } finally {
        filecoinImportActive.set(0);
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
            const response = await axios.get(`${config.walletURL}/api/v1/wallet/version`, {
                headers: adminHeaders(),
                timeout: 5_000,
            });
            res.json({ ready: await gatekeeper.isReady() && Boolean(response.data) });
        } catch {
            res.json({ ready: false });
        }
    });

    app.get('/version', (_req, res) => {
        res.json({ version: serviceVersion, commit: serviceCommit });
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
    console.log(`Starting Filecoin mediator v${serviceVersion} (${serviceCommit})`);
    console.log(`Connecting to gatekeeper at ${config.gatekeeperURL}/api/v1`);
    await gatekeeper.connect({ url: config.gatekeeperURL, apiKey: config.adminApiKey });

    console.log(`Connecting to Filecoin wallet at ${config.walletURL}`);
    startMetricsServer();

    if (config.importInterval > 0) {
        console.log(`Importing Filecoin storage queue every ${config.importInterval} minute(s)`);
        await importQueue();
        setInterval(importQueue, config.importInterval * 60_000);
    } else {
        console.log('Filecoin import loop disabled');
    }
}

main().catch(error => {
    console.error('Filecoin mediator failed:', error);
    process.exit(1);
});
