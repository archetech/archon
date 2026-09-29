import express from 'express';
import { InvalidParameterError } from '@didcid/common/errors';
import type { CreateV1RouterOptions } from './v1-router-types.js';

// Absent parameters use the gatekeeper's defaults. A repeated value, or a count
// that is not plain digits, is passed on as invalid so both ports reject it.
function queryString(value: unknown): string | undefined {
    return value === undefined ? undefined : typeof value === 'string' ? value : '';
}

function queryInteger(value: unknown): number | undefined {
    return value === undefined ? undefined : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
}

export function createSearchRouter(options: CreateV1RouterOptions): express.Router {
    const { gatekeeper } = options;
    const router = express.Router();

    /**
     * @swagger
     * /api/v1/search:
     *   get:
     *     summary: Search DIDs by text query
     *     parameters:
     *       - in: query
     *         name: q
     *         schema:
     *           type: string
     *         required: true
     *         description: The search query string
     *     responses:
     *       200:
     *         description: Array of matching DID strings.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 type: string
     *       500:
     *         description: Internal Server Error.
     */
    router.get('/search', async (req, res) => {
        try {
            const q = req.query.q?.toString() || "";
            if (!q) {
                res.json([]);
                return;
            }
            const dids = await gatekeeper.searchDocs(q);
            res.json(dids);
        } catch (error: any) {
            console.error("/api/v1/search error:", error);
            res.status(500).json({ error: error.toString() });
        }
    });
    
    /**
     * @swagger
     * /api/v1/query:
     *   post:
     *     summary: Query DIDs using structured MongoDB-style query
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               where:
     *                 type: object
     *                 description: Query filter object supporting $in operator
     *     responses:
     *       200:
     *         description: Array of matching DID strings.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 type: string
     *       400:
     *         description: Bad Request - missing or invalid where parameter.
     *       500:
     *         description: Internal Server Error.
     */
    router.post('/query', async (req, res) => {
        try {
            const where = req.body?.where;
            if (!where || typeof where !== "object") {
                res.status(400).json({ error: "`where` must be an object" });
                return;
            }
            const dids = await gatekeeper.queryDocs(where);
            res.json(dids);
        } catch (error: any) {
            console.error("/api/v1/query error:", error);
            res.status(500).json({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /api/v1/events:
     *   get:
     *     summary: List accepted events across all DIDs, newest first
     *     description: >
     *       Pages through the events in every DID's accepted history, ordered by
     *       event time (newest first), then DID, then later history position.
     *       Served from an index maintained as histories change, so a page does
     *       not scan the whole database.
     *     parameters:
     *       - in: query
     *         name: after
     *         schema:
     *           type: string
     *           format: date-time
     *         description: Only events after this time (exclusive).
     *       - in: query
     *         name: before
     *         schema:
     *           type: string
     *           format: date-time
     *         description: Only events before this time (exclusive).
     *       - in: query
     *         name: registry
     *         schema:
     *           type: string
     *         description: Only events in this registry.
     *       - in: query
     *         name: limit
     *         schema:
     *           type: integer
     *           minimum: 1
     *           maximum: 1000
     *           default: 50
     *         description: Page size.
     *       - in: query
     *         name: offset
     *         schema:
     *           type: integer
     *           minimum: 0
     *           default: 0
     *         description: Number of matching events to skip.
     *     responses:
     *       200:
     *         description: One page of matching events and the total across all pages.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 total:
     *                   type: integer
     *                   description: Number of events matching the filters.
     *                 events:
     *                   type: array
     *                   description: Event records as exported, each with the DID it belongs to.
     *                   items:
     *                     type: object
     *                     properties:
     *                       registry:
     *                         type: string
     *                       time:
     *                         type: string
     *                         format: date-time
     *                       ordinal:
     *                         type: array
     *                         items:
     *                           type: integer
     *                       operation:
     *                         type: object
     *                       opid:
     *                         type: string
     *                       registration:
     *                         type: object
     *                         description: Chain registration metadata, present on anchored events.
     *                         properties:
     *                           height:
     *                             type: integer
     *                           index:
     *                             type: integer
     *                           opidx:
     *                             type: integer
     *                           txid:
     *                             type: string
     *                           batch:
     *                             type: string
     *                       did:
     *                         type: string
     *       400:
     *         description: Invalid time, registry, limit or offset.
     *       500:
     *         description: Internal Server Error.
     */
    router.get('/events', async (req, res) => {
        try {
            const result = await gatekeeper.listEvents({
                after: queryString(req.query.after),
                before: queryString(req.query.before),
                registry: queryString(req.query.registry),
                limit: queryInteger(req.query.limit),
                offset: queryInteger(req.query.offset),
            });
            res.json(result);
        } catch (error: any) {
            if (error?.type === InvalidParameterError.type) {
                res.status(400).json({ error: error.message });
                return;
            }
            console.error("/api/v1/events error:", error);
            res.status(500).json({ error: error.toString() });
        }
    });

    return router;
}
