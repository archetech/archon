import express from 'express';
import type { CreateV1RouterOptions } from './v1-router-types.js';
import { createRequireAdminKey } from './v1-admin.js';

export function createSyncRouter(options: CreateV1RouterOptions): express.Router {
    const { gatekeeper } = options;
    const requireAdminKey = createRequireAdminKey(options.config);
    const router = express.Router();

    /**
     * @swagger
     * /batch/export:
     *   post:
     *     summary: Export non-local DID events in a single sorted batch
     *
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               dids:
     *                 type: array
     *                 description: A list of DIDs to export. If omitted, all known DIDs are used for exporting.
     *                 items:
     *                   type: string
     *
     *     responses:
     *       200:
     *         description: A single sorted array of all non-local events for the specified DIDs.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               description: Each item is an event object, sorted by the signature’s signed timestamp.
     *               items:
     *                 type: object
     *                 properties:
     *                   registry:
     *                     type: string
     *                     description: Registry for this event. Local registry events are excluded.
     *                   time:
     *                     type: string
     *                     format: date-time
     *                     description: When this event was recorded in the database.
     *                   ordinal:
     *                     oneOf:
     *                       - type: integer
     *                         description: A single integer ordinal (often 0 if unused)
     *                       - type: array
     *                         description: A tuple of integers for multi-part ordinal keys
     *                         items:
     *                           type: integer
     *                   operation:
     *                     type: object
     *                     description: Details of the DID operation.
     *                     properties:
     *                       type:
     *                         type: string
     *                         description: The operation type.
     *                       did:
     *                         type: string
     *                         description: The DID for which this event applies.
     *                       signature:
     *                         type: object
     *                         description: Cryptographic signature.
     *                   did:
     *                     type: string
     *                     description: The DID this event belongs to, generally matching operation.did.
     *
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.post('/batch/export', requireAdminKey, async (req, res) => {
        try {
            const { dids } = req.body;
            const response = await gatekeeper.exportBatch(dids);
            res.json(response);
        } catch (error: any) {
            console.error(error);
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /batch/import:
     *   post:
     *     summary: Import a batch of DID events
     *
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: array
     *             description: An array of event objects representing DID operations.
     *             items:
     *               type: object
     *               required: [ did, operation, registry, time ]
     *               properties:
     *                 did:
     *                   type: string
     *                   description: The DID to which this event pertains.
     *                 operation:
     *                   type: object
     *                   description: A DID operation, such as "create", "update", or "delete".
     *                   properties:
     *                     type:
     *                       type: string
     *                       description: Operation type.
     *                       example: "create"
     *                     created:
     *                       type: string
     *                       format: date-time
     *                       description: Timestamp when the DID was created (if `type = "create"`).
     *                     registration:
     *                       type: object
     *                       description: Registration metadata (type, version, registry).
     *                     publicJwk:
     *                       type: object
     *                       description: Public key in JWK format, required for "agent" creation.
     *                     signature:
     *                       type: object
     *                       description: Cryptographic signature.
     *                 registry:
     *                   type: string
     *                   description: The registry to which this event belongs.
     *                   example: "local"
     *                 time:
     *                   type: string
     *                   format: date-time
     *                   description: Timestamp when the event was recorded.
     *                 ordinal:
     *                   oneOf:
     *                     - type: integer
     *                       description: A single integer ordinal (often 0 if unused)
     *                     - type: array
     *                       description: A tuple of integers for multi-part ordinal keys
     *                       items:
     *                         type: integer
     *
     *     responses:
     *       200:
     *         description: An object summarizing how many events were queued, processed, rejected, and the current queue size.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 queued:
     *                   type: integer
     *                   description: Number of new, valid events that were queued.
     *                 processed:
     *                   type: integer
     *                   description: Number of events recognized as duplicates.
     *                 rejected:
     *                   type: integer
     *                   description: Number of events that failed validation.
     *                 total:
     *                   type: integer
     *                   description: The total event queue size after this import.
     *
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.post('/batch/import', requireAdminKey, async (req, res) => {
        try {
            const batch = req.body;
            const response = await gatekeeper.importBatch(batch);
            res.json(response);
        } catch (error: any) {
            console.error(error);
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /batch/import/cids:
     *   post:
     *     summary: Import a batch of DID operations by their CIDs
     *
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [cids, metadata]
     *             properties:
     *               cids:
     *                 type: array
     *                 items:
     *                   type: string
     *                 description: Array of operation CIDs to import
     *               metadata:
     *                 type: object
     *                 required: [registry, time, ordinal]
     *                 properties:
     *                   registry:
     *                     type: string
     *                     description: The registry for the batch
     *                   time:
     *                     type: string
     *                     format: date-time
     *                     description: Timestamp for the batch
     *                   ordinal:
     *                     type: array
     *                     items:
     *                       type: number
     *                     description: Ordinal for ordering events
     *                   registration:
     *                     type: object
     *                     description: Optional blockchain registration metadata
     *
     *     responses:
     *       200:
     *         description: Result of the import operation
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 queued:
     *                   type: number
     *                 processed:
     *                   type: number
     *                 rejected:
     *                   type: number
     *                 total:
     *                   type: number
     */
    router.post('/batch/import/cids', requireAdminKey, async (req, res) => {
        try {
            const { cids, metadata } = req.body;
            const response = await gatekeeper.importBatchByCids(cids, metadata);
            res.json(response);
        } catch (error: any) {
            console.error(error);
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /queue/{registry}:
     *   get:
     *     summary: Retrieve the queued events for a specific registry
     *
     *     parameters:
     *       - in: path
     *         name: registry
     *         required: true
     *         schema:
     *           type: string
     *         description: >
     *           The name of the registry whose queue is being retrieved.
     *           Registry names must match `[A-Za-z0-9][A-Za-z0-9:_-]*`.
     *
     *     responses:
     *       200:
     *         description: An array of queued event objects for the specified registry.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 type: object
     *                 description: An individual event in the queue.
     *                 properties:
     *                   registry:
     *                     type: string
     *                     description: The registry to which the event belongs.
     *                   time:
     *                     type: string
     *                     format: date-time
     *                     description: Timestamp when this event was added to the queue.
     *                   ordinal:
     *                     oneOf:
     *                       - type: integer
     *                         description: A single integer ordinal (often 0 if unused)
     *                       - type: array
     *                         description: A tuple of integers for multi-part ordinal keys
     *                         items:
     *                           type: integer
     *                   operation:
     *                     type: object
     *                     description: Details of the DID operation.
     *                     properties:
     *                       type:
     *                         type: string
     *                         description: The operation type.
     *                       did:
     *                         type: string
     *                         description: The DID to which this event applies.
     *                       signature:
     *                         type: object
     *                         description: Cryptographic signature.
     *                   did:
     *                     type: string
     *                     description: The DID that this queue event references (often identical to `operation.did`).
     *
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.get('/queue/:registry', requireAdminKey, async (req, res) => {
        try {
            const queue = await gatekeeper.getQueue(req.params.registry);
            res.json(queue);
        } catch (error: any) {
            console.error(error);
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /queue/{registry}/clear:
     *   post:
     *     summary: Remove specified DIDs from the queue
     *
     *     parameters:
     *       - in: path
     *         name: registry
     *         required: true
     *         schema:
     *           type: string
     *         description: >
     *           The name of the registry from which events will be cleared.
     *           Must be a valid, supported registry.
     *
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: array
     *             description: An array of DID operation event objects to remove from the queue.
     *             items:
     *               type: object
     *               description: A queued DID operation event.
     *               properties:
     *                 type:
     *                   type: string
     *                   description: The operation type.
     *                 did:
     *                   type: string
     *                   description: The DID targeted by this operation.
     *                 doc:
     *                   type: object
     *                   description: The (optional) DID document content, present if type is "update" or "create" with doc data.
     *                 previd:
     *                   type: string
     *                   description: Reference to the previous version (optional).
     *                 signature:
     *                   type: object
     *                   description: Cryptographic signature.
     *               required:
     *                 - type
     *                 - did
     *                 - signature
     *
     *     responses:
     *       200:
     *         description: The updated queue after clearing the specified events.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               description: An array of remaining events in the queue. Could be empty if all events were cleared.
     *               items:
     *                 type: object
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.post('/queue/:registry/clear', requireAdminKey, async (req, res) => {
        try {
            const events = req.body;
            const queue = await gatekeeper.clearQueue(req.params.registry, events);
            res.json(queue);
        } catch (error: any) {
            console.error(error);
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /registries:
     *   get:
     *     summary: Retrieve supported registries
     *     responses:
     *       200:
     *         description: An array of registry names.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 type: string
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.get('/registries', async (req, res) => {
        try {
            const registries = await gatekeeper.listRegistries();
            res.json(registries);
        } catch (error: any) {
            console.error(error);
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /db/reset:
     *   get:
     *     summary: Reset the database
     *
     *     responses:
     *       200:
     *         description: The database was successfully reset.
     *         content:
     *           application/json:
     *             schema:
     *               type: boolean
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.get('/db/reset', requireAdminKey, async (req, res) => {
        if (process.env.NODE_ENV === 'production') {
            res.status(403).json({ error: 'Database reset is disabled in production' });
            return;
        }
        try {
            await gatekeeper.resetDb();
            res.json(true);
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /db/verify:
     *   get:
     *     summary: Verify all DIDs in the database
     *
     *     responses:
     *       200:
     *         description: Verification results for all DIDs in the database.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 total:
     *                   type: integer
     *                   description: The total number of DIDs that were checked.
     *                 verified:
     *                   type: integer
     *                   description: The count of DIDs that passed verification.
     *                 expired:
     *                   type: integer
     *                   description: The count of DIDs that had expired and were removed.
     *                 invalid:
     *                   type: integer
     *                   description: The count of DIDs that failed verification and were removed.
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.get('/db/verify', requireAdminKey, async (req, res) => {
        try {
            const response = await gatekeeper.verifyDb();
            res.json(response);
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /events/process:
     *   post:
     *     summary: Process queued events
     *     description: >
     *       Iterates over all queued events, importing them if they are valid (adding or merging).
     *       Continues until no more new events can be processed. If `processEvents` is already running,
     *       it may return `{ busy: true }` to indicate that processing is in progress.
     *
     *     responses:
     *       200:
     *         description: >
     *           A summary of how many events were added, merged, rejected, or still pending in the queue.
     *           Or `{ busy: true }` if processing is already underway.
     *         content:
     *           application/json:
     *             schema:
     *               oneOf:
     *                 - type: object
     *                   properties:
     *                     busy:
     *                       type: boolean
     *                       description: Indicates that the processing is already in progress.
     *                 - type: object
     *                   properties:
     *                     added:
     *                       type: integer
     *                       description: Number of newly imported events.
     *                     merged:
     *                       type: integer
     *                       description: Number of duplicate events merged.
     *                     rejected:
     *                       type: integer
     *                       description: Number of events that failed validation.
     *                     pending:
     *                       type: integer
     *                       description: Number of events still left in the queue after processing.
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.post('/events/process', requireAdminKey, async (req, res) => {
        try {
            const response = await gatekeeper.processEvents();
            res.json(response);
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    return router;
}
