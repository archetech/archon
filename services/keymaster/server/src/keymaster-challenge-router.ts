import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createChallengeRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

    /**
     * @swagger
     * /challenge:
     *   get:
     *     summary: Create a default challenge DID with no parameters.
     *     responses:
     *       200:
     *         description: A DID representing the newly created challenge.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *                   description: The DID for the newly created challenge.
     *       500:
     *         description: Internal server error.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.get('/challenge', async (req, res) => {
        try {
            const did = await getKeymaster().createChallenge();
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });


    /**
     * @swagger
     * /challenge:
     *   post:
     *     summary: Create a challenge DID with custom data or options.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               challenge:
     *                 type: object
     *                 description: Arbitrary challenge data.
     *               options:
     *                 type: object
     *                 description: Additional options.
     *                 properties:
     *                   registry:
     *                     type: string
     *                     enum: [ "local", "hyperswarm", "BTC:testnet4", "BTC:signet" ]
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *     responses:
     *       200:
     *         description: DID representing the newly created challenge.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *       400:
     *         description: Bad request (invalid parameters).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *       500:
     *         description: Internal server error.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/challenge', async (req, res) => {
        try {
            const { challenge, options } = req.body;
            const did = await getKeymaster().createChallenge(challenge, options);
            res.json({ did });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });


    return router;
}
