import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createPublicRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { config, isReady, getServiceVersion, serviceCommit } = options;
    const router = express.Router();

    /**
     * @swagger
     * /ready:
     *   get:
     *     summary: Check if the Keymaster service is ready.
     *     description: Returns a JSON object indicating the readiness status of the Keymaster service.
     *     responses:
     *       200:
     *         description: Keymaster service readiness status.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ready:
     *                   type: boolean
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
    router.get('/ready', async (req, res) => {
        try {
            res.json({ ready: isReady() });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /api/v1/version:
     *   get:
     *     summary: Retrieve the API version
     *     responses:
     *       200:
     *         description: The API version and commit hash.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 version:
     *                   type: string
     *                 commit:
     *                   type: string
     */
    router.get('/version', (_req, res) => {
        res.json({ version: getServiceVersion(), commit: serviceCommit });
    });

    router.post('/login', async (req, res) => {
        const { passphrase } = req.body;

        if (!config.keymasterPassphrase) {
            // No passphrase configured — return key directly (dev mode)
            res.json({ adminApiKey: config.adminApiKey || '' });
            return;
        }

        if (passphrase !== config.keymasterPassphrase) {
            res.status(401).json({ error: 'Incorrect passphrase' });
            return;
        }

        res.json({ adminApiKey: config.adminApiKey || '' });
    });

    return router;
}
