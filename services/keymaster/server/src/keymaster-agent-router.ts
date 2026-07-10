import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createAgentRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

    /**
     * @swagger
     * /agents/{id}/test:
     *   post:
     *     summary: Check whether the given ID (or DID) is an agent.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The ID name or DID to test.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             description: No body required for this endpoint.
     *     responses:
     *       200:
     *         description: Whether the specified DID is recognized as an agent.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 test:
     *                   type: boolean
     *                   description: true if the DID is an agent; otherwise `false`.
     *       400:
     *         description: Invalid request or DID.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/agents/:id/test', async (req, res) => {
        try {
            const test = await getKeymaster().testAgent(req.params.id);
            res.json({ test });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });


    return router;
}
