import express from 'express';
import type { CreateV1RouterOptions } from './v1-router-types.js';

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

    return router;
}
