/**
 * Filecoin Mediator for Archon
 *
 * Autonomous repair agent: polls the filecoin-wallet for failed pins and
 * retries them. Runs independently on a configurable interval, providing
 * self-healing storage without any user intervention.
 */
import express from 'express';
import axios from 'axios';
import pino from 'pino';
import { register, Counter, Gauge, collectDefaultMetrics } from 'prom-client';
import { readFile } from 'fs/promises';
import config from './config.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

collectDefaultMetrics();

const verifyCyclesTotal = new Counter({
    name: 'filecoin_mediator_verify_cycles_total',
    help: 'Total verification cycles run',
    labelNames: ['result'],
});

const pinsRetriedTotal = new Counter({
    name: 'filecoin_mediator_pins_retried_total',
    help: 'Total failed pins retried',
    labelNames: ['result'],
});

const pinsHealthy = new Gauge({
    name: 'filecoin_mediator_pins_healthy',
    help: 'Number of successfully pinned CIDs at last check',
});

const pinsFailed = new Gauge({
    name: 'filecoin_mediator_pins_failed',
    help: 'Number of failed pins at last check',
});

const WALLET_HEADERS = () => ({
    'Content-Type': 'application/json',
    'x-archon-admin-key': config.adminApiKey,
});

interface PinRecord {
    requestid: string;
    status: 'queued' | 'pinning' | 'pinned' | 'failed';
    pin: { cid: string; did: string; name?: string };
    error?: string;
}

async function listPins(status?: string): Promise<PinRecord[]> {
    const url = status
        ? `${config.walletUrl}/api/v1/wallet/pins?status=${status}`
        : `${config.walletUrl}/api/v1/wallet/pins`;
    const { data } = await axios.get<{ count: number; results: PinRecord[] }>(url, {
        headers: WALLET_HEADERS(),
    });
    return data.results;
}

async function repin(pin: PinRecord): Promise<string> {
    const { data } = await axios.post(
        `${config.walletUrl}/api/v1/wallet/anchor`,
        { cid: pin.pin.cid, did: pin.pin.did, name: pin.pin.name },
        { headers: WALLET_HEADERS() }
    );
    return data.requestid as string;
}

async function removePin(requestid: string): Promise<void> {
    await axios.delete(
        `${config.walletUrl}/api/v1/wallet/pin/${requestid}`,
        { headers: WALLET_HEADERS() }
    );
}

async function verifyCycle(): Promise<void> {
    let allPins: PinRecord[];

    try {
        allPins = await listPins();
    } catch (err: any) {
        logger.error({ err }, 'Failed to fetch pin list from filecoin-wallet');
        verifyCyclesTotal.inc({ result: 'error' });
        return;
    }

    const healthy = allPins.filter(p => p.status === 'pinned');
    const failed = allPins.filter(p => p.status === 'failed');
    const inFlight = allPins.filter(p => p.status === 'queued' || p.status === 'pinning');

    pinsHealthy.set(healthy.length);
    pinsFailed.set(failed.length);

    logger.info(
        { total: allPins.length, pinned: healthy.length, failed: failed.length, inFlight: inFlight.length },
        'Verified pin status'
    );

    if (failed.length === 0) {
        verifyCyclesTotal.inc({ result: 'ok' });
        return;
    }

    logger.info({ count: failed.length }, 'Retrying failed pins');

    for (const pin of failed) {
        try {
            // Remove the stale failed record then resubmit
            await removePin(pin.requestid);
            const newRequestid = await repin(pin);
            logger.info({ cid: pin.pin.cid, did: pin.pin.did, requestid: newRequestid }, 'Repin submitted');
            pinsRetriedTotal.inc({ result: 'submitted' });
        } catch (err: any) {
            logger.error({ err, cid: pin.pin.cid, did: pin.pin.did }, 'Repin failed');
            pinsRetriedTotal.inc({ result: 'failed' });
        }
    }

    verifyCyclesTotal.inc({ result: 'repinned' });
}

let serviceVersion = 'unknown';

async function main() {
    try {
        const data = await readFile(new URL('../package.json', import.meta.url), 'utf-8');
        serviceVersion = JSON.parse(data).version;
    } catch {}

    logger.info(`Filecoin mediator v${serviceVersion} starting`);
    logger.info(`Wallet: ${config.walletUrl}`);
    logger.info(`Verify interval: ${config.exportIntervalMs}ms`);

    const app = express();
    app.get('/status', (_req, res) => {
        res.json({
            service: 'filecoin-mediator',
            version: serviceVersion,
            walletUrl: config.walletUrl,
            verifyIntervalMs: config.exportIntervalMs,
        });
    });
    app.listen(config.port, () => {
        logger.info(`Status endpoint on port ${config.port}`);
    });

    const metricsApp = express();
    metricsApp.get('/metrics', async (_req, res) => {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    });
    metricsApp.listen(config.metricsPort, () => {
        logger.info(`Metrics on port ${config.metricsPort}`);
    });

    await verifyCycle();
    const interval = setInterval(verifyCycle, config.exportIntervalMs);

    const shutdown = () => {
        logger.info('Shutting down filecoin mediator...');
        clearInterval(interval);
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(err => {
    logger.error('Failed to start filecoin mediator:', err);
    process.exit(1);
});
