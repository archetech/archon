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
const state: { ready: boolean; lastPoll?: string; lastRebuild?: string } = { ready: false };

const serviceVersionInfo = new promClient.Gauge({
    name: 'service_version_info',
    help: 'Service version information',
    labelNames: ['version', 'commit'],
});
const heldGauge = new promClient.Gauge({ name: 'memeplex_indexer_dids', help: 'DIDs whose histories the index holds' });
const publicationsGauge = new promClient.Gauge({ name: 'memeplex_indexer_publications', help: 'Objects with an attributed version' });
const syncDuration = new promClient.Histogram({
    name: 'memeplex_indexer_sync_duration_seconds',
    help: 'Time for a poll of the Gatekeeper to bring the index up to date',
    buckets: [0.01, 0.1, 1, 10, 60, 600],
});
const syncErrors = new promClient.Counter({
    name: 'memeplex_indexer_sync_errors_total',
    help: 'Polls of the Gatekeeper that failed',
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

    // One poll at a time. A poll that finds one running is dropped: another
    // follows shortly, and takes in whatever that one did not.
    let running = false;
    const poll = async (): Promise<void> => {
        if (running) {
            return;
        }
        running = true;

        const end = syncDuration.startTimer();

        try {
            const result = await sync.poll();
            const now = new Date().toISOString();

            state.lastPoll = now;
            if (result.rebuilt) {
                state.lastRebuild = now;
            }
            state.ready = sync.complete;

            if (result.rebuilt || result.histories > 0) {
                console.log(`${result.rebuilt ? 'rebuild' : 'poll'}: ${result.histories} histories, ${index.size.publications} publications`);
            }
        }
        catch (error) {
            syncErrors.inc();
            console.error(`poll failed: ${error}`);
        }
        finally {
            end();
            heldGauge.set(index.size.dids);
            publicationsGauge.set(index.size.publications);
            running = false;
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

    // The first poll reads everything, and the index answers once it has.
    await poll();
    setInterval(() => void poll(), config.pollInterval * 1000);
}

// Fatal until startup is complete: a process that is listening with no
// Gatekeeper behind it would pass a health check and answer nothing.
main(installProcessGuards('Memeplex indexer')).catch(error => {
    console.error(`Memeplex indexer failed to start: ${error}`);
    process.exit(1);
});
