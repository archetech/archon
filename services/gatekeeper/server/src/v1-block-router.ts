import express from 'express';
import type { CreateV1RouterOptions } from './v1-router-types.js';
import { createRequireAdminKey } from './v1-admin.js';

export function createBlockRouter(options: CreateV1RouterOptions): express.Router {
    const { gatekeeper } = options;
    const requireAdminKey = createRequireAdminKey(options.config);
    const router = express.Router();

    /**
     * @swagger
     * /block/{registry}/latest:
     *   get:
     *     summary: Retrieve the latest block for a specific registry
     *     parameters:
     *       - in: path
     *         name: registry
     *         required: true
     *         schema:
     *           type: string
     *         description: The name of the registry to retrieve the latest block from.
     *     responses:
     *       200:
     *         description: Successfully retrieved the latest block.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 hash:
     *                   type: string
     *                   description: The hash of the latest block.
     *                 height:
     *                   type: integer
     *                   description: The height of the latest block.
     *                 time:
     *                   type: integer
     *                   description: The timestamp of the latest block in seconds since the Unix epoch.
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.get('/block/:registry/latest', async (req, res) => {
        try {
            const { registry } = req.params;
            const block = await gatekeeper.getBlock(registry);
            res.json(block);
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /block/{registry}/{blockId}:
     *   get:
     *     summary: Retrieve a specific block for a given registry
     *     parameters:
     *       - in: path
     *         name: registry
     *         required: true
     *         schema:
     *           type: string
     *         description: The name of the registry to retrieve the block from.
     *       - in: path
     *         name: blockId
     *         required: true
     *         schema:
     *           oneOf:
     *             - type: string
     *               description: The hash of the block.
     *             - type: integer
     *               description: The height of the block.
     *         description: >
     *           The identifier of the block to retrieve. Can be either a block hash (string) or a block height (integer).
     *     responses:
     *       200:
     *         description: Successfully retrieved the block.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 hash:
     *                   type: string
     *                   description: The hash of the block.
     *                 height:
     *                   type: integer
     *                   description: The height of the block.
     *                 time:
     *                   type: integer
     *                   description: The timestamp of the block in seconds since the Unix epoch.
     *                 timeISO:
     *                   type: string
     *                   format: date-time
     *                   description: The timestamp of the block in ISO 8601 format.
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.get('/block/:registry/:blockId', async (req, res) => {
        try {
            const { registry, blockId } = req.params;
            const parsedBlockId = /^\d+$/.test(blockId) ? parseInt(blockId, 10) : blockId;
            const block = await gatekeeper.getBlock(registry, parsedBlockId);
            res.json(block);
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /block/{registry}:
     *   post:
     *     summary: Add a new block to a specific registry
     *     parameters:
     *       - in: path
     *         name: registry
     *         required: true
     *         schema:
     *           type: string
     *         description: The name of the registry to which the block will be added.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required:
     *               - hash
     *               - height
     *               - time
     *             properties:
     *               hash:
     *                 type: string
     *                 description: The hash of the block.
     *               height:
     *                 type: integer
     *                 description: The height of the block.
     *               time:
     *                 type: integer
     *                 description: The timestamp of the block in seconds since the Unix epoch.
     *     responses:
     *       200:
     *         description: Successfully added the block.
     *         content:
     *           application/json:
     *             schema:
     *               type: boolean
     *               example: true
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.post('/block/:registry', requireAdminKey, async (req, res) => {
        try {
            const { registry } = req.params;
            const block = req.body;
            const ok = await gatekeeper.addBlock(registry, block);
            res.json(ok);
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    return router;
}
