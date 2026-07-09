import express from 'express';
import { ResolveDIDOptions, Operation } from '@didcid/gatekeeper/types';
import type { CreateV1RouterOptions } from './v1-router-types.js';
import { createRequireAdminKey } from './v1-admin.js';
import {
    CONFIRM_FALLBACK_HEADER,
    resolveFromConfirmFallback,
    shouldTryConfirmFallback,
} from './confirm-fallback.js';

export function createDidRouter(options: CreateV1RouterOptions): express.Router {
    const { gatekeeper, config, logger, didOperationsTotal } = options;
    const requireAdminKey = createRequireAdminKey(config);
    const router = express.Router();

    /**
     * @swagger
     * /api/v1/did:
     *   post:
     *     summary: Create, update, or delete a DID
     *
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             oneOf:
     *               - type: object
     *                 required: [ type, created, registration, signature ]
     *                 properties:
     *                   type:
     *                     type: string
     *                     enum: [ "create" ]
     *                     description: Must be "create" to create a new DID.
     *                   created:
     *                     type: string
     *                     format: date-time
     *                     description: Timestamp of when the operation was created.
     *                   registration:
     *                     type: object
     *                     required: [ version, type, registry ]
     *                     properties:
     *                       version:
     *                         type: integer
     *                         description: Protocol version (e.g., 1).
     *                       type:
     *                         type: string
     *                         enum: [ "agent", "asset" ]
     *                         description: DID type.
     *                       registry:
     *                         type: string
     *                         description: Registry where the DID is created.
     *                       validUntil:
     *                         type: string
     *                         format: date-time
     *                         description: Optional expiration time for ephemeral DIDs.
     *                     description: Registration metadata fields for creation.
     *                   signature:
     *                     type: object
     *                     description: Cryptographic signature verifying the create operation.
     *                     required: [ value, signed ]
     *                     properties:
     *                       value:
     *                         type: string
     *                         description: The signature value (base64, hex, etc.).
     *                       signed:
     *                         type: string
     *                         format: date-time
     *                         description: When the signature was created.
     *                       signer:
     *                         type: string
     *                         description: The DID of the signer (for asset creation, should match `controller`).
     *                       hash:
     *                         type: string
     *                         description: Hash of the operation payload, if applicable.
     *                   publicJwk:
     *                     type: object
     *                     description: Required if register.type = "agent". Contains the public key in JWK format.
     *                   controller:
     *                     type: string
     *                     description: Required if register.type = "asset". Must match the `signer` in `signature`.
     *
     *               - type: object
     *                 required: [ type, did, signature ]
     *                 properties:
     *                   type:
     *                     type: string
     *                     enum: [ "update" ]
     *                     description: Must be "update" to modify an existing DID document.
     *                   did:
     *                     type: string
     *                     description: The DID to update.
     *                   doc:
     *                     type: object
     *                     description: The updated DID document or subset of data.
     *                   previd:
     *                     type: string
     *                     description: Reference to the previous version CID/hash.
     *                   signature:
     *                     type: object
     *                     required: [ value, signed ]
     *                     description: Cryptographic signature verifying this update operation.
     *                     properties:
     *                       value:
     *                         type: string
     *                         description: The signature value (base64, hex, etc.).
     *                       signed:
     *                         type: string
     *                         format: date-time
     *                         description: When the signature was created.
     *                       signer:
     *                         type: string
     *                         description: The DID of the signer (often the same as `did`).
     *                       hash:
     *                         type: string
     *                         description: Optional hash of the operation payload.
     *
     *               - type: object
     *                 required: [ type, did, signature ]
     *                 properties:
     *                   type:
     *                     type: string
     *                     enum: [ "delete" ]
     *                     description: Must be "delete" to deactivate an existing DID.
     *                   did:
     *                     type: string
     *                     description: The DID to deactivate.
     *                   signature:
     *                     type: object
     *                     required: [ value, signed ]
     *                     description: Cryptographic signature verifying this delete operation.
     *                     properties:
     *                       value:
     *                         type: string
     *                         description: The signature value (base64, hex, etc.).
     *                       signed:
     *                         type: string
     *                         format: date-time
     *                         description: When the signature was created.
     *                       signer:
     *                         type: string
     *                         description: The DID of the signer, who must have authority to delete.
     *                       hash:
     *                         type: string
     *                         description: Optional hash of the operation payload.
     *
     *     responses:
     *       200:
     *         description: >
     *           - If `type = "create"`, returns the newly created DID as a string.
     *           - Otherwise (for update or delete), returns a boolean value indicating success.
     *         content:
     *           text/plain:
     *             schema:
     *               oneOf:
     *                 - type: string
     *                   description: A DID string (when a create operation succeeds).
     *                   example: did:cid:z3v8AuahvBGDMXvCTWedYbxnH6C9ZrsEtEJAvip2XPzcZb8yo6A
     *                 - type: boolean
     *                   description: A success indicator for update/delete operations.
     *                   example: true
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.post('/did', async (req, res) => {
        try {
            const operation = req.body;
            const opType = operation?.type || 'unknown';
            const registry = operation?.registration?.registry || 'unknown';
            let result;
            if (operation && operation.type === "create") {
                result = await gatekeeper.createDID(operation);
            } else {
                result = await gatekeeper.updateDID(operation);
            }
            didOperationsTotal.inc({ operation: opType, registry, status: 'success' });
            res.json(result);
        } catch (error: any) {
            const opType = req.body?.type || 'unknown';
            const registry = req.body?.registration?.registry || 'unknown';
            didOperationsTotal.inc({ operation: opType, registry, status: 'error' });
            console.error(error);
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /api/v1/did/generate:
     *   post:
     *     summary: Generate a DID from an operation (no persistence)
     *
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             description: An Operation object.
     *             required: [ type, registration ]
     *             properties:
     *               type:
     *                 type: string
     *                 description: The operation type. Typically "create" when generating a DID.
     *               created:
     *                 type: string
     *                 format: date-time
     *                 description: Optional creation timestamp (used by create operations elsewhere).
     *               did:
     *                 type: string
     *                 description: Optional DID (usually absent for create when generating).
     *               registration:
     *                 type: object
     *                 description: Registration metadata for the operation.
     *                 required: [ version, type, registry ]
     *                 properties:
     *                   version:
     *                     type: integer
     *                     example: 1
     *                   type:
     *                     type: string
     *                     enum: [ agent, asset ]
     *                     example: agent
     *                   registry:
     *                     type: string
     *                     description: Registry name.
     *                     example: local
     *                   prefix:
     *                     type: string
     *                     description: Optional DID prefix override. If omitted, server default is used.
     *                     example: did:cid
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: Optional expiry timestamp for ephemeral DIDs.
     *               publicJwk:
     *                 type: object
     *                 description: Public key JWK (typically required for agent creates).
     *               controller:
     *                 type: string
     *                 description: Controller DID (typically required for asset creates).
     *               data:
     *                 type: object
     *                 description: Optional arbitrary DID document data (often used for assets).
     *               signature:
     *                 type: object
     *                 description: Optional signature object (not required for mere DID generation).
     *
     *     responses:
     *       200:
     *         description: The generated DID string.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     *       400:
     *         description: Bad Request (missing or invalid operation).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post("/did/generate", async (req, res) => {
        try {
            const operation = req.body as Operation;
    
            if (!operation) {
                res.status(400).json({ error: "missing operation" })
                return;
            }
    
            const did = await gatekeeper.generateDID(operation);
            res.json(did);
        } catch (err: any) {
            res.status(400).json(err?.response?.data ?? err);
        }
    });
    
    /**
     * @swagger
     * /api/v1/did/{did}:
     *   get:
     *     summary: Resolve a DID Document
     *     description: >
     *       Resolves a DID Document from the local database. If local resolution fails,
     *       falls back to a configurable universal resolver (default: https://dev.uniresolver.io).
     *       Set `ARCHON_GATEKEEPER_FALLBACK_URL` to override the resolver URL (empty string disables fallback).
     *       Set `ARCHON_GATEKEEPER_FALLBACK_TIMEOUT` to override the timeout in milliseconds (default: 5000).
     *       Set `ARCHON_GATEKEEPER_CONFIRM_FALLBACK_URL` to delegate unconfirmed `confirm=true`
     *       responses to another Gatekeeper node (empty string disables fallback).
     *
     *     parameters:
     *       - in: path
     *         name: did
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID to resolve.
     *       - in: query
     *         name: versionTime
     *         required: false
     *         schema:
     *           type: string
     *           format: date-time
     *         description: >
     *           Timestamp to return the state of the DID as of this specific time.
     *       - in: query
     *         name: versionSequence
     *         required: false
     *         schema:
     *           type: integer
     *         description: >
     *           Specific version of the DID Document to retrieve. Versioning increments each time an `update` or `delete` operation occurs.
     *       - in: query
     *         name: confirm
     *         required: false
     *         schema:
     *           type: boolean
     *         description: >
     *           If `true`, returns the DID Document if it is fully confirmed.
     *       - in: query
     *         name: verify
     *         required: false
     *         schema:
     *           type: boolean
     *         description: >
     *           If `true`, verifies the signature(s) of the DID operation(s) before returning the DID Document.
     *           If a signature is invalid, an error is thrown.
     *     responses:
     *       200:
     *         description: Successfully resolved DID Document.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               description: The fully-resolved DID Document along with metadata describing its state.
     *               properties:
     *                 "@context":
     *                   type: string
     *                   description: DID resolution context.
     *                 didDocument:
     *                   type: object
     *                   description: The DID Document itself.
     *                   properties:
     *                     "@context":
     *                       type: array
     *                       items:
     *                         type: string
     *                       description: DID document context.
     *                     id:
     *                       type: string
     *                       description: The DID.
     *                     controller:
     *                       type: string
     *                       description: The controller DID (for assets).
     *                     verificationMethod:
     *                       type: array
     *                       description: An array of verification methods (keys).
     *                       items:
     *                         type: object
     *                         properties:
     *                           id:
     *                             type: string
     *                             description: Identifier for the verification method.
     *                           controller:
     *                             type: string
     *                             description: The DID or entity controlling this key.
     *                           type:
     *                             type: string
     *                             description: Type of key.
     *                           publicKeyJwk:
     *                             type: object
     *                             description: Public key data in JWK format.
     *                     authentication:
     *                       type: array
     *                       items:
     *                         type: string
     *                       description: Refers to the verification methods used for authentication.
     *                 didDocumentMetadata:
     *                   type: object
     *                   description: Metadata associated with the DID Document.
     *                   properties:
     *                     created:
     *                       type: string
     *                       format: date-time
     *                       description: Timestamp indicating when the DID was created.
     *                     updated:
     *                       type: string
     *                       format: date-time
     *                       description: Timestamp indicating the last update to the DID, if any.
     *                     deleted:
     *                       type: string
     *                       format: date-time
     *                       description: Timestamp of when the DID was deleted (if it was deleted).
     *                     version:
     *                       type: integer
     *                       description: Current version number of the DID Document.
     *                     versionId:
     *                       type: string
     *                       description: CID (or similar) identifying the current version’s content.
     *                     canonicalId:
     *                       type: string
     *                       description: The canonical DID if a custom prefix was used.
     *                     confirmed:
     *                       type: boolean
     *                       description: Indicates whether the DID is fully confirmed.
     *                     deactivated:
     *                       type: boolean
     *                       description: Indicates if the DID is deactivated (via a delete operation).
     *                 didDocumentData:
     *                   type: object
     *                   description: Arbitrary data attached to the DID (for assets).
     *                 didDocumentRegistration:
     *                   type: object
     *                   description: Registration metadata fields.
     *                   properties:
     *                     type:
     *                       type: string
     *                       enum: [ "agent", "asset" ]
     *                       description: The DID type.
     *                     registry:
     *                       type: string
     *                       pattern: '^[A-Za-z0-9][A-Za-z0-9:_-]*$'
     *                       description: Registry in which this DID is maintained.
     *                     version:
     *                       type: integer
     *                       description: Supported protocol version.
     *                     validUntil:
     *                       type: string
     *                       format: date-time
     *                       description: Optional expiration timestamp for ephemeral DIDs.
     *                     registration:
     *                       type: string
     *                       description: Blockchain or other registry reference for an updated or deleted DID.
     *       404:
     *         description: DID not found. The DID either does not exist or cannot be resolved.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *       500:
     *         description: Internal Server Error.
     */
    async function resolveFromUniversalResolver(did: string): Promise<any | null> {
        if (!config.fallbackURL) {
            return null;
        }
    
        try {
            const baseURL = config.fallbackURL.replace(/\/+$/, '');
            const url = `${baseURL}/1.0/identifiers/${encodeURIComponent(did)}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), config.fallbackTimeout);
    
            try {
                const response = await fetch(url, { signal: controller.signal });
    
                if (!response.ok) {
                    return null;
                }
    
                return await response.json();
            } finally {
                clearTimeout(timeout);
            }
        } catch (error) {
            logger.error({ did, error }, 'Universal resolver fallback failed');
            return null;
        }
    }
    
    router.get('/did/:did', async (req, res) => {
        try {
            const options: ResolveDIDOptions = {};
            const { versionTime, versionSequence, confirm, verify } = req.query;
    
            if (typeof versionTime === 'string') {
                options.versionTime = versionTime;
            }
    
            if (typeof versionSequence === 'string') {
                const parsed = parseInt(versionSequence, 10);
                if (!isNaN(parsed)) {
                    options.versionSequence = parsed;
                }
            }
    
            if (confirm) {
                options.confirm = confirm === 'true';
            }
    
            if (verify) {
                options.verify = verify === 'true';
            }
    
            const doc = await gatekeeper.resolveDID(req.params.did, options);
    
            if (doc.didResolutionMetadata?.error) {
                const resolved = await resolveFromUniversalResolver(req.params.did);
                if (resolved) {
                    res.json(resolved);
                    return;
                }
            }
    
            if (shouldTryConfirmFallback(
                doc,
                options,
                config.confirmFallbackURL,
                Boolean(req.get(CONFIRM_FALLBACK_HEADER))
            )) {
                try {
                    const resolved = await resolveFromConfirmFallback(
                        req.params.did,
                        options,
                        config.confirmFallbackURL,
                        config.fallbackTimeout
                    );
    
                    if (resolved) {
                        res.json(resolved);
                        return;
                    }
                } catch (error) {
                    logger.error({ did: req.params.did, error }, 'Confirmed Gatekeeper fallback failed');
                }
            }
    
            res.json(doc);
        } catch (error: any) {
            res.status(404).send({ error: 'DID not found' });
        }
    });
    
    /**
     * @swagger
     * /api/v1/dids/:
     *   post:
     *     summary: Retrieve a list of DIDs or DID Documents.
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
     *                 description: A list of specific DIDs to check. If omitted, all known DIDs are retrieved.
     *                 items:
     *                   type: string
     *               updatedAfter:
     *                 type: string
     *                 format: date-time
     *                 description: Only return DIDs/DID Docs updated *after* this time.
     *               updatedBefore:
     *                 type: string
     *                 format: date-time
     *                 description: Only return DIDs/DID Docs updated *before* this time.
     *               confirm:
     *                 type: boolean
     *                 description: If true, only return DID Docs that are fully confirmed.
     *               verify:
     *                 type: boolean
     *                 description: If true, verifies signatures during DID resolution. If signature checks fail, an error is thrown.
     *               resolve:
     *                 type: boolean
     *                 description: If true, return DID Documents instead of just string identifiers.
     *
     *     responses:
     *       200:
     *         description: An array of DIDs or DID Documents.
     *         content:
     *           application/json:
     *             schema:
     *               oneOf:
     *                 - type: array
     *                   description: An array of DID strings.
     *                   items:
     *                     type: string
     *                 - type: array
     *                   description: An array of DID Document objects (if `resolve` is true).
     *                   items:
     *                     type: object
     *                     properties:
     *                       "@context":
     *                         type: string
     *                       didDocument:
     *                         type: object
     *                         description: DID Document contents
     *                       didDocumentMetadata:
     *                         type: object
     *                       didDocumentRegistration:
     *                         type: object
     *
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.post('/dids/', async (req, res) => {
        try {
            const dids = await gatekeeper.getDIDs(req.body);
            res.json(dids);
        } catch (error: any) {
            console.error(error);
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /api/v1/dids/remove:
     *   post:
     *     summary: Remove one or more DIDs
     *
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: array
     *             items:
     *               type: string
     *               description: A valid DID.
     *
     *     responses:
     *       200:
     *         description: Indicates whether the operation succeeded.
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
    router.post('/dids/remove', requireAdminKey, async (req, res) => {
        try {
            const dids = req.body;
            const response = await gatekeeper.removeDIDs(dids);
            res.json(response);
        } catch (error: any) {
            console.error(error);
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /api/v1/dids/export:
     *   post:
     *     summary: Export events for one or more DIDs
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
     *                 description: A list of DIDs to export. If omitted, all known DIDs are exported.
     *                 items:
     *                   type: string
     *
     *     responses:
     *       200:
     *         description: Returns an array of arrays, where each sub-array contains the event objects for a single DID.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               description: Each element corresponds to a DID's event list.
     *               items:
     *                 type: array
     *                 description: An array of event objects for a single DID.
     *                 items:
     *                   type: object
     *                   description: A single event in the DID's event history.
     *                   properties:
     *                     registry:
     *                       type: string
     *                       description: The registry.
     *                     time:
     *                       type: string
     *                       format: date-time
     *                       description: Timestamp indicating when this event occurred.
     *                     ordinal:
     *                       oneOf:
     *                         - type: integer
     *                           description: A single integer ordinal (often 0 if unused)
     *                         - type: array
     *                           description: A tuple of integers for multi-part ordinal keys
     *                           items:
     *                             type: integer
     *                     operation:
     *                       type: object
     *                       description: The DID operation that defines changes.
     *                     did:
     *                       type: string
     *                       description: The DID this event belongs to.
     *
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.post('/dids/export', async (req, res) => {
        try {
            const { dids } = req.body;
            const response = await gatekeeper.exportDIDs(dids);
            res.json(response);
        } catch (error: any) {
            console.error(error);
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /api/v1/dids/import:
     *   post:
     *     summary: Import one or more DIDs
     *
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: array
     *             description: >
     *               An array where each item is itself an array of event objects corresponding
     *               to a single DID’s history.
     *             items:
     *               type: array
     *               description: A list of all events that define one DID's state.
     *               items:
     *                 type: object
     *                 required: [ did, operation, registry, time ]
     *                 properties:
     *                   did:
     *                     type: string
     *                     description: The DID these events belong to.
     *                   operation:
     *                     type: object
     *                     description: The DID operation including signatures and other data.
     *                     properties:
     *                       type:
     *                         type: string
     *                         description: The operation type ("create", "update", or "delete").
     *                       created:
     *                         type: string
     *                         format: date-time
     *                         description: Creation timestamp (if `type = "create"`).
     *                       registration:
     *                         type: object
     *                         description: Registration metadata.
     *                       publicJwk:
     *                         type: object
     *                         description: Public key in JWK format (required for agent creates).
     *                       signature:
     *                         type: object
     *                         description: Cryptographic signature
     *                     required:
     *                       - type
     *                       - signature
     *                   registry:
     *                     type: string
     *                     description: The registry this event belongs to.
     *                   time:
     *                     type: string
     *                     format: date-time
     *                     description: Timestamp when this event was recorded.
     *                   ordinal:
     *                     oneOf:
     *                       - type: integer
     *                         description: A single integer ordinal (often 0 if unused)
     *                       - type: array
     *                         description: A tuple of integers for multi-part ordinal keys
     *                         items:
     *                           type: integer
     *
     *     responses:
     *       200:
     *         description: Summary of the import operation.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               description: Object containing counts of how many events were queued, processed (duplicates), rejected, and the current queue total.
     *               properties:
     *                 queued:
     *                   type: integer
     *                   description: Number of new events queued.
     *                 processed:
     *                   type: integer
     *                   description: Number of events recognized as duplicates (already known).
     *                 rejected:
     *                   type: integer
     *                   description: Number of events that failed validation (bad signature, size limit, etc.).
     *                 total:
     *                   type: integer
     *                   description: Total number of events in the queue after this import.
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.post('/dids/import', requireAdminKey, async (req, res) => {
        try {
            const dids = req.body;
            const response = await gatekeeper.importDIDs(dids);
            res.json(response);
        } catch (error: any) {
            console.error(error);
            res.status(500).send(error.toString());
        }
    });

    return router;
}
