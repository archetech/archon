import express from 'express';

import {
    handleGetPayments,
    handleL402Status,
    handlePaymentCompletion,
    handleRevokeMacaroon,
} from './middleware/l402-auth.js';
import { createRequireAdminKey } from './v1-admin.js';
import type { CreateV1RouterOptions } from './v1-router-types.js';

export function createV1Router(options: CreateV1RouterOptions): express.Router {
    const {
        gatekeeper,
        config,
        logger,
        l402Options,
        authMiddleware,
        getServiceVersion,
        serviceCommit,
        resolveDidCommEndpoint,
        proxyLightningMediatorRequest,
    } = options;

    const v1router = express.Router();
    const requireAdminKey = createRequireAdminKey(config);

    // --- Unprotected routes ---

    v1router.get('/ready', async (_req, res) => {
        try {
            const upstream = await gatekeeper.isReady();
            res.json(upstream);
        } catch {
            res.json(false);
        }
    });

    v1router.get('/version', (_req, res) => {
        res.json({ version: getServiceVersion(), commit: serviceCommit });
    });

    // Advertise which optional services this node offers, so clients can gate
    // features and fail clearly instead of discovering absence via transport
    // errors. A service is "offered" when its downstream URL is configured
    // (non-empty); an operator opts out by setting the URL empty. This reflects
    // node *intent*, not live health — a configured-but-down service still
    // surfaces a runtime error to the caller.
    v1router.get('/capabilities', (_req, res) => {
        res.json({
            didcomm: config.didcommURL !== '',
            lightning: config.lightningMediatorURL !== '',
            names: config.heraldURL !== '',
        });
    });

    // Public DIDComm relay endpoint, so `publishDidComm` can auto-discover it
    // (the way publishLightning learns its public host): an explicit public host,
    // else the Tor onion fronting this Drawbridge. Null when neither is available.
    v1router.get('/didcomm-endpoint', async (_req, res) => {
        res.json({ endpoint: await resolveDidCommEndpoint() });
    });

    v1router.get('/status', async (_req, res) => {
        try {
            const upstreamStatus = await gatekeeper.getStatus();
            res.json({
                service: 'drawbridge',
                upstream: upstreamStatus,
                uptime: process.uptime(),
                memoryUsage: process.memoryUsage(),
            });
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper status error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    // --- L402 management routes ---

    v1router.post('/l402/pay', async (req, res) => {
        await handlePaymentCompletion(l402Options, req, res);
    });

    v1router.get('/l402/status', requireAdminKey, async (req, res) => {
        await handleL402Status(l402Options, req, res);
    });

    v1router.post('/l402/revoke', requireAdminKey, async (req, res) => {
        await handleRevokeMacaroon(l402Options, req, res);
    });

    v1router.get('/l402/payments/:did', requireAdminKey, async (req, res) => {
        await handleGetPayments(l402Options, req, res);
    });

    // --- Gatekeeper proxy routes (auth required) ---

    v1router.get('/registries', ...authMiddleware, async (_req, res) => {
        try {
            const result = await gatekeeper.listRegistries();
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/did', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.createDID(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/did/generate', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.generateDID(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.get('/did/:did', ...authMiddleware, async (req, res) => {
        try {
            const options: any = {};
            if (req.query.versionTime) options.versionTime = req.query.versionTime;
            if (req.query.versionSequence) options.versionSequence = Number(req.query.versionSequence);
            if (req.query.confirm) options.confirm = req.query.confirm === 'true';
            if (req.query.verify) options.verify = req.query.verify === 'true';

            const result = await gatekeeper.resolveDID(req.params.did as string, Object.keys(options).length ? options : undefined);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/dids', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.getDIDs(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/dids/export', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.exportDIDs(req.body?.dids);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    // IPFS routes

    v1router.post('/ipfs/json', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.addJSON(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.get('/ipfs/json/:cid', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.getJSON(req.params.cid as string);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/ipfs/text', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.addText(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.get('/ipfs/text/:cid', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.getText(req.params.cid as string);
            res.send(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/ipfs/data', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.addData(req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.get('/ipfs/data/:cid', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.getData(req.params.cid as string);
            if (result) {
                res.set('Content-Type', 'application/octet-stream');
                res.send(result);
            } else {
                res.status(404).send('Not found');
            }
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    // IPFS streaming routes (no body-size limit)

    v1router.post('/ipfs/stream', ...authMiddleware, async (req, res) => {
        try {
            const cid = await gatekeeper.addDataStream(req);
            res.send(cid);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.get('/ipfs/stream/:cid', ...authMiddleware, async (req, res) => {
        try {
            const contentType = (req.query.type as string) || 'application/octet-stream';
            const filename = req.query.filename as string;
            if (filename) {
                res.attachment(filename);
            }
            res.setHeader('Content-Type', contentType);
            for await (const chunk of gatekeeper.getDataStream(req.params.cid as string)) {
                res.write(chunk);
            }
            res.end();
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    // Block routes

    v1router.get('/block/:registry/latest', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.getBlock(req.params.registry as string);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.get('/block/:registry/:blockId', ...authMiddleware, async (req, res) => {
        try {
            const blockId = /^\d+$/.test(req.params.blockId as string) ? parseInt(req.params.blockId as string) : req.params.blockId as string;
            const result = await gatekeeper.getBlock(req.params.registry as string, blockId);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    // Search routes

    v1router.get('/search', ...authMiddleware, async (req, res) => {
        try {
            const q = (Array.isArray(req.query.q) ? req.query.q[0] : req.query.q) as string;
            const result = await gatekeeper.searchDocs(q);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    v1router.post('/query', ...authMiddleware, async (req, res) => {
        try {
            const result = await gatekeeper.queryDocs(req.body?.where || req.body);
            res.json(result);
        } catch (error: any) {
            logger.error({ err: error }, 'Gatekeeper proxy error');
            res.status(502).json({ error: 'Upstream gatekeeper error' });
        }
    });

    // --- Lightning routes proxied to lightning-mediator ---

    v1router.use('/lightning', async (req, res) => {
        if (config.lightningMediatorURL === '') {
            res.status(501).json({ error: 'Lightning is not enabled on this node' });
            return;
        }
        try {
            await proxyLightningMediatorRequest(req, res, req.originalUrl);
        } catch (error: any) {
            logger.error({ err: error, path: req.originalUrl }, 'Lightning mediator proxy error');
            res.status(502).json({ error: 'Upstream lightning mediator error' });
        }
    });

    return v1router;
}
