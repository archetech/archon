import express from 'express';
import morgan from 'morgan';
import pino from 'pino';
import { readFile } from 'fs/promises';
import { Counter, Gauge, collectDefaultMetrics, register } from 'prom-client';
import GatekeeperClient from '@didcid/gatekeeper/client';
import { socksDispatcher } from 'fetch-socks';

import config from './config.js';
import { LightningPaymentError } from './errors.js';
import * as cln from './lightning.js';
import * as lnbits from './lnbits.js';
import { RedisStore } from './store.js';
import type { PendingInvoiceData, ReadinessStatus } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

collectDefaultMetrics();

const httpRequestsTotal = new Counter({
    name: 'lightning_mediator_http_requests_total',
    help: 'Total HTTP requests handled by the Lightning mediator',
    labelNames: ['method', 'route', 'status'],
});

const lightningMediatorVersionInfo = new Gauge({
    name: 'lightning_mediator_version_info',
    help: 'Lightning mediator version information',
    labelNames: ['version', 'commit'],
});

let serviceVersion = 'unknown';
const serviceCommit = (process.env.GIT_COMMIT || 'unknown').slice(0, 7);
const TOR_HOSTNAME_FILE = '/data/tor/hostname';

readFile(new URL('../package.json', import.meta.url), 'utf-8').then(data => {
    const pkg = JSON.parse(data);
    serviceVersion = pkg.version;
    lightningMediatorVersionInfo.set({ version: serviceVersion, commit: serviceCommit }, 1);
}).catch(() => {
    lightningMediatorVersionInfo.set({ version: 'unknown', commit: serviceCommit }, 1);
});

async function checkRedis(redisUrl: string): Promise<boolean> {
    try {
        const redis = new RedisStore(redisUrl);
        await redis.disconnect();
        return true;
    } catch {
        return false;
    }
}

let gatekeeperPromise: Promise<any> | undefined;

function getGatekeeper() {
    if (!gatekeeperPromise) {
        gatekeeperPromise = GatekeeperClient.create({
            url: config.gatekeeperUrl,
            waitUntilReady: true,
            chatty: false,
        });
    }

    return gatekeeperPromise;
}

function isPrivateHost(hostname: string): boolean {
    return /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname);
}

function parsePositiveInteger(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

let cachedPublicHost: string | undefined;

async function getPublicHost(): Promise<string | undefined> {
    if (cachedPublicHost) {
        return cachedPublicHost;
    }

    if (config.drawbridgePublicHost) {
        cachedPublicHost = config.drawbridgePublicHost;
        return cachedPublicHost;
    }

    if (config.publicHost) {
        cachedPublicHost = config.publicHost;
        return cachedPublicHost;
    }

    try {
        const onion = (await readFile(TOR_HOSTNAME_FILE, 'utf-8')).trim();
        if (onion) {
            cachedPublicHost = `http://${onion}:${config.drawbridgePort}`;
            logger.info({ publicHost: cachedPublicHost }, 'Resolved public host from Tor hostname');
            return cachedPublicHost;
        }
    } catch {
        // File not available yet
    }

    return undefined;
}

async function buildReadinessStatus(): Promise<ReadinessStatus> {
    const redisReady = await checkRedis(config.redisUrl);

    return {
        ready: redisReady,
        dependencies: {
            redis: redisReady,
            clnConfigured: Boolean(config.clnRune && config.clnRestUrl),
            lnbitsConfigured: Boolean(config.lnbitsUrl),
        },
    };
}

async function main(): Promise<void> {
    const app = express();
    const v1router = express.Router();
    const store = new RedisStore(config.redisUrl);

    app.use(express.json({ limit: '1mb' }));
    app.use(morgan('dev'));

    app.use((req, res, next) => {
        res.on('finish', () => {
            httpRequestsTotal.inc({
                method: req.method,
                route: req.path,
                status: String(res.statusCode),
            });
        });
        next();
    });

    app.get('/ready', async (_req, res) => {
        const status = await buildReadinessStatus();
        res.status(status.ready ? 200 : 503).json(status);
    });

    app.get('/version', (_req, res) => {
        res.json({ version: serviceVersion, commit: serviceCommit });
    });

    app.get('/metrics', async (_req, res) => {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    });

    v1router.get('/lightning/supported', (_req, res) => {
        res.json({
            supported: true,
            mediator: 'lightning-mediator',
            clnConfigured: Boolean(config.clnRune && config.clnRestUrl),
            lnbitsConfigured: Boolean(config.lnbitsUrl),
        });
    });

    v1router.post('/lightning/wallet', async (req, res) => {
        if (!config.lnbitsUrl) {
            res.status(503).json({ error: 'Lightning (LNBits) not configured' });
            return;
        }

        try {
            const { name } = req.body;
            const result = await lnbits.createWallet(config.lnbitsUrl, name || 'archon');
            res.json(result);
        } catch (error: any) {
            const status = error instanceof LightningPaymentError ? 400 : 502;
            logger.error({ err: error }, 'LNBits wallet error');
            res.status(status).json({ error: error.message || 'LNBits error' });
        }
    });

    v1router.post('/lightning/balance', async (req, res) => {
        if (!config.lnbitsUrl) {
            res.status(503).json({ error: 'Lightning (LNBits) not configured' });
            return;
        }

        try {
            const { invoiceKey } = req.body;
            const balance = await lnbits.getBalance(config.lnbitsUrl, invoiceKey);
            res.json({ balance });
        } catch (error: any) {
            const status = error instanceof LightningPaymentError ? 400 : 502;
            logger.error({ err: error }, 'LNBits balance error');
            res.status(status).json({ error: error.message || 'LNBits error' });
        }
    });

    v1router.post('/lightning/invoice', async (req, res) => {
        if (!config.lnbitsUrl) {
            res.status(503).json({ error: 'Lightning (LNBits) not configured' });
            return;
        }

        try {
            const amount = parsePositiveInteger(req.body?.amount);
            const { invoiceKey } = req.body;
            const memo = String(req.body?.memo || '');

            if (!invoiceKey || !amount) {
                res.status(400).json({ error: 'invoiceKey and positive amount are required' });
                return;
            }

            const result = await lnbits.createInvoice(config.lnbitsUrl, invoiceKey, amount, memo);
            res.json(result);
        } catch (error: any) {
            const status = error instanceof LightningPaymentError ? 400 : 502;
            logger.error({ err: error }, 'LNBits invoice error');
            res.status(status).json({ error: error.message || 'LNBits error' });
        }
    });

    v1router.post('/lightning/pay', async (req, res) => {
        if (!config.lnbitsUrl) {
            res.status(503).json({ error: 'Lightning (LNBits) not configured' });
            return;
        }

        try {
            const { adminKey, bolt11 } = req.body;
            if (!adminKey || !bolt11) {
                res.status(400).json({ error: 'adminKey and bolt11 are required' });
                return;
            }

            const result = await lnbits.payInvoice(config.lnbitsUrl, adminKey, bolt11);
            res.json(result);
        } catch (error: any) {
            const status = error instanceof LightningPaymentError ? 400 : 502;
            logger.error({ err: error }, 'LNBits payment error');
            res.status(status).json({ error: error.message || 'LNBits error' });
        }
    });

    v1router.post('/lightning/payment', async (req, res) => {
        if (!config.lnbitsUrl) {
            res.status(503).json({ error: 'Lightning (LNBits) not configured' });
            return;
        }

        try {
            const { invoiceKey, paymentHash } = req.body;
            if (!invoiceKey || !paymentHash) {
                res.status(400).json({ error: 'invoiceKey and paymentHash are required' });
                return;
            }

            const status = await lnbits.checkPayment(config.lnbitsUrl, invoiceKey, paymentHash);
            res.json({ ...status, paymentHash });
        } catch (error: any) {
            const status = error instanceof LightningPaymentError ? 400 : 502;
            logger.error({ err: error }, 'LNBits payment status error');
            res.status(status).json({ error: error.message || 'LNBits error' });
        }
    });

    v1router.post('/lightning/payments', async (req, res) => {
        if (!config.lnbitsUrl) {
            res.status(503).json({ error: 'Lightning (LNBits) not configured' });
            return;
        }

        try {
            const { adminKey } = req.body;
            if (!adminKey) {
                res.status(400).json({ error: 'adminKey is required' });
                return;
            }

            const payments = await lnbits.getPayments(config.lnbitsUrl, adminKey);
            res.json({ payments });
        } catch (error: any) {
            const status = error instanceof LightningPaymentError ? 400 : 502;
            logger.error({ err: error }, 'LNBits payments error');
            res.status(status).json({ error: error.message || 'LNBits error' });
        }
    });

    v1router.post('/lightning/publish', async (req, res) => {
        try {
            const { did, invoiceKey } = req.body;
            if (!did || !invoiceKey) {
                res.status(400).json({ error: 'did and invoiceKey are required' });
                return;
            }

            const publicHost = await getPublicHost();
            if (!publicHost) {
                res.status(503).json({
                    error: 'Lightning public host is not available yet',
                });
                return;
            }

            await store.savePublishedLightning(did, invoiceKey);
            res.json({ ok: true, publicHost });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to publish Lightning');
            res.status(500).json({ error: error.message || 'Failed to publish Lightning' });
        }
    });

    v1router.delete('/lightning/publish/:did', async (req, res) => {
        try {
            const did = req.params.did as string;
            await store.deletePublishedLightning(did);
            res.json({ ok: true });
        } catch (error: any) {
            logger.error({ err: error }, 'Failed to unpublish Lightning');
            res.status(500).json({ error: error.message || 'Failed to unpublish Lightning' });
        }
    });

    v1router.post('/lightning/zap', async (req, res) => {
        if (!config.lnbitsUrl) {
            res.status(503).json({ error: 'Lightning (LNBits) not configured' });
            return;
        }

        try {
            const { adminKey, did } = req.body;
            const amount = parsePositiveInteger(req.body?.amount);
            const memo = String(req.body?.memo || '');

            if (!adminKey || !did) {
                res.status(400).json({ error: 'adminKey and did are required' });
                return;
            }
            if (!amount) {
                res.status(400).json({ error: 'amount must be a positive integer' });
                return;
            }

            let paymentRequest: string;
            const isLud16 = did.includes('@') && !did.startsWith('did:');

            if (isLud16) {
                const parts = did.split('@');
                if (parts.length !== 2 || !parts[0] || !parts[1]) {
                    res.status(400).json({ error: 'Invalid Lightning Address format' });
                    return;
                }

                const [name, domain] = parts;
                const lnurlUrl = new URL(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`);
                if (isPrivateHost(lnurlUrl.hostname)) {
                    res.status(400).json({ error: 'Invalid Lightning Address: private addresses not allowed' });
                    return;
                }

                const lnurlResponse = await fetch(lnurlUrl.toString());
                if (!lnurlResponse.ok) {
                    res.status(502).json({ error: `Lightning Address lookup failed: ${lnurlResponse.statusText}` });
                    return;
                }

                const lnurlData = await lnurlResponse.json() as any;
                if (lnurlData.status === 'ERROR') {
                    res.status(502).json({ error: `Lightning Address error: ${lnurlData.reason || 'unknown'}` });
                    return;
                }

                const { callback, minSendable, maxSendable } = lnurlData;
                if (!callback) {
                    res.status(502).json({ error: 'No callback URL in Lightning Address response' });
                    return;
                }

                const callbackUrl = new URL(callback);
                if (callbackUrl.protocol !== 'https:' || isPrivateHost(callbackUrl.hostname)) {
                    res.status(400).json({ error: 'Invalid callback URL' });
                    return;
                }

                const amountMsats = amount * 1000;
                if (minSendable && amountMsats < minSendable) {
                    res.status(400).json({ error: `Amount too low: minimum ${Math.ceil(minSendable / 1000)} sats` });
                    return;
                }
                if (maxSendable && amountMsats > maxSendable) {
                    res.status(400).json({ error: `Amount too high: maximum ${Math.floor(maxSendable / 1000)} sats` });
                    return;
                }

                let invoiceUrl = `${callback}${callback.includes('?') ? '&' : '?'}amount=${amountMsats}`;
                if (memo) {
                    invoiceUrl += `&comment=${encodeURIComponent(memo)}`;
                }

                const invoiceResponse = await fetch(invoiceUrl);
                if (!invoiceResponse.ok) {
                    const error = await invoiceResponse.json().catch(() => ({ error: invoiceResponse.statusText }));
                    res.status(502).json({ error: `Invoice request failed: ${error.error || invoiceResponse.statusText}` });
                    return;
                }

                const invoiceData = await invoiceResponse.json() as any;
                if (invoiceData.status === 'ERROR') {
                    res.status(502).json({ error: `Invoice error: ${invoiceData.reason || 'unknown'}` });
                    return;
                }

                paymentRequest = invoiceData.pr;
                if (!paymentRequest) {
                    res.status(502).json({ error: 'No payment request returned from Lightning Address' });
                    return;
                }
            } else {
                const gatekeeper = await getGatekeeper();
                const doc = await gatekeeper.resolveDID(did);
                const services = doc.didDocument?.service || [];
                const lightningService = services.find((service: any) => service.type === 'Lightning');

                if (!lightningService) {
                    res.status(404).json({ error: 'Recipient DID has no Lightning service endpoint' });
                    return;
                }

                const url = new URL(lightningService.serviceEndpoint);
                const isOnion = url.hostname.endsWith('.onion');
                if (isOnion && url.protocol !== 'http:') {
                    res.status(400).json({ error: 'Invalid service endpoint: .onion must use http' });
                    return;
                }
                if (!isOnion && url.protocol !== 'https:') {
                    res.status(400).json({ error: 'Invalid service endpoint: must use https' });
                    return;
                }
                if (!isOnion && isPrivateHost(url.hostname)) {
                    res.status(400).json({ error: 'Invalid service endpoint: private addresses not allowed' });
                    return;
                }

                let invoiceUrl = `${lightningService.serviceEndpoint}?amount=${amount}`;
                if (memo) {
                    invoiceUrl += `&memo=${encodeURIComponent(memo)}`;
                }

                const fetchOptions: any = {};
                if (isOnion && config.torProxy) {
                    const [host, port] = config.torProxy.split(':');
                    fetchOptions.dispatcher = socksDispatcher({
                        type: 5,
                        host: host || 'localhost',
                        port: parseInt(port || '9050', 10),
                    });
                }

                const invoiceResponse = await fetch(invoiceUrl, fetchOptions);
                if (!invoiceResponse.ok) {
                    const error = await invoiceResponse.json().catch(() => ({ error: invoiceResponse.statusText }));
                    res.status(502).json({ error: `Invoice request failed: ${error.error || invoiceResponse.statusText}` });
                    return;
                }

                const invoiceJson = await invoiceResponse.json() as any;
                paymentRequest = invoiceJson.paymentRequest;
                if (!paymentRequest) {
                    res.status(502).json({ error: 'No payment request returned from recipient' });
                    return;
                }
            }

            const result = await lnbits.payInvoice(config.lnbitsUrl, adminKey, paymentRequest);
            res.json(result);
        } catch (error: any) {
            const status = error instanceof LightningPaymentError ? 400 : 502;
            logger.error({ err: error }, 'Lightning zap error');
            res.status(status).json({ error: error.message || 'Lightning zap failed' });
        }
    });

    v1router.post('/l402/invoice', async (req, res) => {
        try {
            const amountSat = parsePositiveInteger(req.body?.amountSat);
            const memo = String(req.body?.memo || '');
            if (!amountSat) {
                res.status(400).json({ error: 'amountSat must be a positive integer' });
                return;
            }

            const result = await cln.createInvoice(
                {
                    restUrl: config.clnRestUrl,
                    rune: config.clnRune,
                },
                amountSat,
                memo
            );
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'L402 invoice error');
            res.status(502).json({ error: error.message || 'Invoice creation failed' });
        }
    });

    v1router.post('/l402/check', async (req, res) => {
        try {
            const paymentHash = String(req.body?.paymentHash || '');
            if (!paymentHash) {
                res.status(400).json({ error: 'paymentHash is required' });
                return;
            }

            const result = await cln.checkInvoice(
                {
                    restUrl: config.clnRestUrl,
                    rune: config.clnRune,
                },
                paymentHash
            );
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'L402 invoice check error');
            res.status(502).json({ error: error.message || 'Invoice check failed' });
        }
    });

    v1router.post('/l402/pending', async (req, res) => {
        try {
            const pendingInvoice = req.body as Partial<PendingInvoiceData>;
            const amountSat = parsePositiveInteger(pendingInvoice?.amountSat);
            const expiresAt = parsePositiveInteger(pendingInvoice?.expiresAt);
            const createdAt = parsePositiveInteger(pendingInvoice?.createdAt);

            if (!pendingInvoice?.paymentHash ||
                !pendingInvoice?.macaroonId ||
                !pendingInvoice?.serializedMacaroon ||
                !pendingInvoice?.did ||
                !Array.isArray(pendingInvoice?.scope) ||
                !amountSat ||
                !expiresAt ||
                !createdAt) {
                res.status(400).json({ error: 'Invalid pending invoice payload' });
                return;
            }

            await store.savePendingInvoice({
                paymentHash: pendingInvoice.paymentHash,
                macaroonId: pendingInvoice.macaroonId,
                serializedMacaroon: pendingInvoice.serializedMacaroon,
                did: pendingInvoice.did,
                scope: pendingInvoice.scope.map(item => String(item)),
                amountSat,
                expiresAt,
                createdAt,
            });

            res.status(201).json({ ok: true, paymentHash: pendingInvoice.paymentHash });
        } catch (error: any) {
            logger.error({ err: error }, 'L402 pending invoice save error');
            res.status(500).json({ error: error.message || 'Failed to save pending invoice' });
        }
    });

    v1router.get('/l402/pending/:paymentHash', async (req, res) => {
        try {
            const paymentHash = String(req.params.paymentHash || '');
            if (!paymentHash) {
                res.status(400).json({ error: 'paymentHash is required' });
                return;
            }

            const pendingInvoice = await store.getPendingInvoice(paymentHash);
            if (!pendingInvoice) {
                res.status(404).json({ error: 'No pending invoice found for this payment hash' });
                return;
            }

            res.json(pendingInvoice);
        } catch (error: any) {
            logger.error({ err: error }, 'L402 pending invoice lookup error');
            res.status(500).json({ error: error.message || 'Failed to get pending invoice' });
        }
    });

    v1router.delete('/l402/pending/:paymentHash', async (req, res) => {
        try {
            const paymentHash = String(req.params.paymentHash || '');
            if (!paymentHash) {
                res.status(400).json({ error: 'paymentHash is required' });
                return;
            }

            await store.deletePendingInvoice(paymentHash);
            res.json({ ok: true, paymentHash });
        } catch (error: any) {
            logger.error({ err: error }, 'L402 pending invoice delete error');
            res.status(500).json({ error: error.message || 'Failed to delete pending invoice' });
        }
    });

    app.get('/invoice/:did', async (req, res) => {
        if (!config.lnbitsUrl) {
            res.status(503).json({ error: 'Lightning not configured' });
            return;
        }

        try {
            const did = req.params.did as string;
            const amount = parsePositiveInteger(req.query.amount);
            const memo = String(req.query.memo || '');

            if (!amount) {
                res.status(400).json({ error: 'amount is required and must be positive (sats)' });
                return;
            }

            const invoiceKey = await store.getPublishedLightning(did);
            if (!invoiceKey) {
                res.status(404).json({ error: 'DID has not published Lightning' });
                return;
            }

            const result = await lnbits.createInvoice(config.lnbitsUrl, invoiceKey, amount, memo);
            res.json(result);
        } catch (error: any) {
            const status = error instanceof LightningPaymentError ? 400 : 502;
            logger.error({ err: error }, 'Public invoice error');
            res.status(status).json({ error: error.message || 'Invoice creation failed' });
        }
    });

    app.use('/api/v1', v1router);

    app.listen(config.port, config.bindAddress, () => {
        logger.info(`Lightning mediator v${serviceVersion} (${serviceCommit}) running on ${config.bindAddress}:${config.port}`);
    });
}

main().catch((error: unknown) => {
    logger.error({ err: error }, 'Failed to start lightning mediator');
    process.exit(1);
});
