import { readFile } from 'fs/promises';
import promClient from 'prom-client';

import GatekeeperClient from '@didcid/clients/gatekeeper';
import { installProcessGuards } from '@didcid/common/process-guards';
import { MemeplexIndex } from '@didcid/memeplex';
import config from './config.js';
import { createIndexerApp } from './api.js';
import type { IndexerStatus } from './api.js';
import { Sync } from './sync.js';
import type { FeedGatekeeper } from './sync.js';

const index = new MemeplexIndex();
const state: { ready: boolean; lastPoll?: string; lastReconcile?: string } = { ready: false };

const serviceVersionInfo = new promClient.Gauge({
    name: 'service_version_info',
    help: 'Service version information',
    labelNames: ['version', 'commit'],
});
const heldGauge = new promClient.Gauge({ name: 'memeplex_indexer_dids', help: 'DIDs whose histories the index holds' });
const publicationsGauge = new promClient.Gauge({ name: 'memeplex_indexer_publications', help: 'Objects with an attributed version' });
const syncDuration = new promClient.Histogram({
    name: 'memeplex_indexer_sync_duration_seconds',
    help: 'Time to read the feed and refresh the index',
    labelNames: ['pass'],
    buckets: [0.01, 0.1, 1, 10, 60, 600],
});
const syncErrors = new promClient.Counter({
    name: 'memeplex_indexer_sync_errors_total',
    help: 'Failed reads of the feed',
    labelNames: ['pass'],
});

function status(): IndexerStatus {
    return { ...state, ...index.size };
}

async function main(startupComplete: () => void): Promise<void> {
    const commit = (process.env.GIT_COMMIT || 'unknown').slice(0, 7);
    let version = 'unknown';

    try {
        version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
    }
    catch {
        // The version stays unknown.
    }
    serviceVersionInfo.set({ version, commit }, 1);
    console.log(`Starting Memeplex indexer v${version} (${commit})`);

    const gatekeeper = new GatekeeperClient();

    await gatekeeper.connect({
        url: config.gatekeeperURL,
        waitUntilReady: true,
        intervalSeconds: 5,
        chatty: true,
        timeoutMs: config.gatekeeperTimeout * 1000,
    });

    const sync = new Sync({ gatekeeper: gatekeeper as unknown as FeedGatekeeper, index });

    // One pass at a time: a poll and a reconciliation read the same feed. A poll
    // that finds a pass running is dropped, since another follows shortly. A
    // reconciliation is kept and run when that pass ends.
    let running = false;
    let reconcileWaiting = false;
    const pass = async (name: 'poll' | 'reconcile'): Promise<void> => {
        if (running) {
            reconcileWaiting = reconcileWaiting || name === 'reconcile';
            return;
        }
        running = true;

        const end = syncDuration.startTimer({ pass: name });

        try {
            const result = name === 'poll' ? await sync.poll() : await sync.reconcile();
            const now = new Date().toISOString();

            if (name === 'poll') {
                state.lastPoll = now;
            }
            else {
                state.lastReconcile = now;
            }
            // Either kind of pass may be the first to read the whole feed.
            state.ready = sync.complete;
            if (name === 'reconcile' || result.histories > 0) {
                console.log(`${name}: ${result.events} events, ${result.histories} histories, ${index.size.publications} publications`);
            }
        }
        catch (error) {
            syncErrors.inc({ pass: name });
            console.error(`${name} failed: ${error}`);
        }
        finally {
            end();
            heldGauge.set(index.size.dids);
            publicationsGauge.set(index.size.publications);
            running = false;
        }

        if (reconcileWaiting) {
            reconcileWaiting = false;
            await pass('reconcile');
        }
    };

    const app = createIndexerApp({ index, status, version: { version, commit } });

    app.get('/metrics', async (_req, res) => {
        res.set('Content-Type', promClient.register.contentType);
        res.end(await promClient.register.metrics());
    });

    await new Promise<void>((resolve, reject) => {
        const server = app.listen(config.port, config.bindAddress, () => {
            console.log(`Memeplex indexer listening on ${config.bindAddress}:${config.port}`);
            resolve();
        });

        server.once('error', reject);
    });

    // The Gatekeeper answers and the port is bound. From here a failure is
    // logged, and the passes that follow try again.
    startupComplete();

    // The first pass reads everything, and the index answers once it has.
    await pass('reconcile');
    setInterval(() => void pass('poll'), config.pollInterval * 1000);
    setInterval(() => void pass('reconcile'), config.reconcileInterval * 1000);
}

// Fatal until startup is complete: a process that is listening with no
// Gatekeeper behind it would pass a health check and answer nothing.
main(installProcessGuards('Memeplex indexer')).catch(error => {
    console.error(`Memeplex indexer failed to start: ${error}`);
    process.exit(1);
});
