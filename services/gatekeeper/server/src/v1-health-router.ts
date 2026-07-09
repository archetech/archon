import express from 'express';
import { createRequire } from 'module';
import type { CreateV1RouterOptions } from './v1-router-types.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const commit = (process.env.GIT_COMMIT || 'unknown').slice(0, 7);

export function createHealthRouter(options: CreateV1RouterOptions): express.Router {
    const { isReady, getStatus } = options;
    const router = express.Router();

    /**
     * @swagger
     * /ready:
     *   get:
     *     summary: Check if the Gatekeeper service is ready.
     *     responses:
     *       200:
     *         description: Gatekeeper service is ready.
     *         content:
     *           text/plain:
     *             schema:
     *               type: boolean
     */
    router.get('/ready', async (req, res) => {
        try {
            res.json(isReady());
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /version:
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
     *       500:
     *         description: Internal Server Error.
     */
    router.get('/version', (_req, res) => {
        res.json({ version: pkg.version, commit });
    });
    
    /**
     * @swagger
     * /status:
     *   get:
     *     summary: Retrieve server status
     *     responses:
     *       200:
     *         description: Status information retrieved successfully.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 uptimeSeconds:
     *                   type: integer
     *                   description: The number of seconds since the server started.
     *                 dids:
     *                   type: object
     *                   description: Detailed statistics of DID checks.
     *                   properties:
     *                     total:
     *                       type: integer
     *                       description: Total number of DIDs processed.
     *                     byType:
     *                       type: object
     *                       description: Breakdown of DIDs by type.
     *                       properties:
     *                         agents:
     *                           type: integer
     *                           description: Number of DIDs of type "agent".
     *                         assets:
     *                           type: integer
     *                           description: Number of DIDs of type "asset".
     *                         confirmed:
     *                           type: integer
     *                           description: Number of DIDs that have been confirmed.
     *                         unconfirmed:
     *                           type: integer
     *                           description: Number of DIDs that remain unconfirmed.
     *                         ephemeral:
     *                           type: integer
     *                           description: Number of DIDs with an expiration (validUntil) set.
     *                         invalid:
     *                           type: integer
     *                           description: Number of DIDs that could not be resolved or are invalid.
     *                     byRegistry:
     *                       type: object
     *                       description: Count of DIDs grouped by registry.
     *                       additionalProperties:
     *                         type: integer
     *                     byVersion:
     *                       type: object
     *                       description: Count of DIDs grouped by version.
     *                       additionalProperties:
     *                         type: integer
     *                     eventsQueue:
     *                       type: object
     *                       description: Details of the events queue.
     *                 memoryUsage:
     *                   type: object
     *                   description: Memory usage statistics provided by Node.
     *                   properties:
     *                     rss:
     *                       type: integer
     *                       description: Resident Set Size – total memory allocated for the process.
     *                     heapTotal:
     *                       type: integer
     *                       description: Total size of the allocated heap.
     *                     heapUsed:
     *                       type: integer
     *                       description: Actual memory used during execution.
     *                     external:
     *                       type: integer
     *                       description: Memory usage of C++ objects bound to JavaScript objects managed by V8.
     *                     arrayBuffers:
     *                       type: integer
     *                       description: Memory allocated for ArrayBuffers and SharedArrayBuffers.
     *       500:
     *         description: Internal Server Error.
     */
    router.get('/status', async (req, res) => {
        try {
            const status = await getStatus();
            res.json(status);
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    return router;
}
