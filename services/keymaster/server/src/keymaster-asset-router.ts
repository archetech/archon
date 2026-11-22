import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';
import { sendError, sendNotFound } from './keymaster-error-status.js';

export function createAssetRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

    /**
     * @swagger
     * /assets:
     *   post:
     *     summary: Create a new asset DID.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               data:
     *                 type: object
     *                 description: Arbitrary data to store in this asset.
     *               options:
     *                 type: object
     *                 description: Additional creation parameters.
     *                 properties:
     *                   registry:
     *                     type: string
     *                     description: Where to create the asset DID (e.g., "local", "hyperswarm").
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: Expiration date/time for an ephemeral asset. Omit for a permanent asset.
     *                   controller:
     *                     type: string
     *                     description: Specific ID or DID to act as the asset’s controller. Defaults to the current ID.
     *                   alias:
     *                     type: string
     *                     description: A human-readable alias for the asset.

     *     responses:
     *       200:
     *         description: The DID of the newly created asset.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *       500:
     *         description: Internal server error (e.g., invalid parameters or wallet error).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/assets', async (req, res) => {
        try {
            const { data, options } = req.body;
            const did = await getKeymaster().createAsset(data, options);
            res.json({ did });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /assets:
     *   get:
     *     summary: List all asset DIDs owned by the current ID.
     *     responses:
     *       200:
     *         description: A list of asset DIDs.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 assets:
     *                   type: array
     *                   items:
     *                     type: string
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
    router.get('/assets', async (req, res) => {
        try {
            const assets = await getKeymaster().listAssets();
            res.json({ assets });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /revocations:
     *   get:
     *     summary: List the assets whose deletion a node has accepted and their chain registry has yet to anchor.
     *     description: >
     *       An asset leaves this list once its deletion is anchored on its registry. An asset the node resolves as
     *       live is returned once, as `displaced`, and then leaves the list.
     *     parameters:
     *       - in: query
     *         name: owner
     *         required: false
     *         schema:
     *           type: string
     *         description: The ID name or DID whose revocations to list. Defaults to the current ID.
     *     responses:
     *       200:
     *         description: The revocations awaiting anchoring.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 revocations:
     *                   type: array
     *                   items:
     *                     type: object
     *                     required:
     *                       - did
     *                       - status
     *                     properties:
     *                       did:
     *                         type: string
     *                       registry:
     *                         type: string
     *                         description: The asset's registry. Absent when the node could not resolve the asset.
     *                       status:
     *                         type: string
     *                         enum: [pending, displaced, unresolved]
     *                         description: >
     *                           `pending` when the deletion is not anchored yet, `displaced` when another change took
     *                           the deletion's place and the asset is live, `unresolved` when the node could not
     *                           resolve the asset.
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
    router.get('/revocations', async (req, res) => {
        try {
            const owner = typeof req.query.owner === 'string' ? req.query.owner : undefined;
            const revocations = await getKeymaster().listRevocations(owner);
            res.json({ revocations });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /grants:
     *   post:
     *     summary: Create a Memeplex grant from a grant link.
     *     description: >
     *       Creates the grant a client asks for with an `archon://grant?request=` link, as an asset of the granting
     *       identity. Refuses a link that does not decode or does not carry a valid grant request, a registry a grant
     *       may not be created on, the request does not list or the node does not support, a granting identity registered on `local`, a request
     *       that names the granting identity as its client, and a scope wider than the request asks for.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required:
     *               - link
     *             properties:
     *               link:
     *                 type: string
     *                 description: The grant link the client presents.
     *               options:
     *                 type: object
     *                 properties:
     *                   registry:
     *                     type: string
     *                     description: >
     *                       One of the registries the request lists, which are among `BTC:mainnet`, `ZEC:mainnet`,
     *                       `ETH:mainnet` and `SOL:mainnet-beta`. Defaults to the first of those four that the node
     *                       supports and the request lists.
     *                   controller:
     *                     type: string
     *                     description: The ID name or DID that grants. Defaults to the current ID.
     *                   alias:
     *                     type: string
     *                     description: An alias for the grant.
     *                   actions:
     *                     type: array
     *                     items:
     *                       type: string
     *                     description: >
     *                       A subset of the actions the request asks for, or of the core actions when it lists none.
     *                       Defaults to what the request asks for.
     *                   expiresAt:
     *                     type: string
     *                     format: date-time
     *                     nullable: true
     *                     description: >
     *                       When the grant expires. Defaults to the expiry the request asks for; `null` for a grant
     *                       that lasts until it is revoked.
     *     responses:
     *       200:
     *         description: The DID of the grant.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *       400:
     *         description: The link, the registry, the granting identity or the scope is refused.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *   get:
     *     summary: List the Memeplex grants among an identity's assets.
     *     description: >
     *       A grant whose deletion a node has accepted is not listed: `GET /revocations` has it until the deletion is
     *       anchored.
     *     parameters:
     *       - in: query
     *         name: owner
     *         required: false
     *         schema:
     *           type: string
     *         description: The ID name or DID whose grants to list. Defaults to the current ID.
     *     responses:
     *       200:
     *         description: The grants, each as its latest version states it.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 grants:
     *                   type: array
     *                   items:
     *                     type: object
     *                     required:
     *                       - did
     *                       - status
     *                     properties:
     *                       did:
     *                         type: string
     *                       status:
     *                         type: string
     *                         enum: [anchored, pending, unresolved]
     *                         description: >
     *                           `anchored` when the latest version of the grant is anchored on its registry, `pending`
     *                           when it is not and so has no effect yet, `unresolved` when the node could not resolve
     *                           the asset, which may or may not be a grant.
     *                       grant:
     *                         type: object
     *                         required:
     *                           - v
     *                           - client
     *                         properties:
     *                           v:
     *                             type: integer
     *                             enum: [1]
     *                           client:
     *                             type: string
     *                             description: The DID of the client the grant lets publish.
     *                           actions:
     *                             type: array
     *                             items:
     *                               type: string
     *                             description: The actions the grant permits. Absent when it permits every core kind.
     *                           nonce:
     *                             type: string
     *                           expiresAt:
     *                             type: string
     *                             format: date-time
     *                       registry:
     *                         type: string
     *                       created:
     *                         type: boolean
     *                         description: Whether the latest version is the grant's creation.
     *       400:
     *         description: The owner is not an ID in the wallet.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/grants', async (req, res) => {
        try {
            const { link, options } = req.body;
            const did = await getKeymaster().createGrant(link, options);
            res.json({ did });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    router.get('/grants', async (req, res) => {
        try {
            const owner = typeof req.query.owner === 'string' ? req.query.owner : undefined;
            const grants = await getKeymaster().listGrants(owner);
            res.json({ grants });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /grants/{id}:
     *   put:
     *     summary: Change the scope of a Memeplex grant of the current ID.
     *     description: >
     *       Changes `actions`, `expiresAt` or both, and keeps every other field of the grant. Refuses a DID that is
     *       not a live, valid grant of the current ID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or alias of the grant.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required:
     *               - changes
     *             properties:
     *               changes:
     *                 type: object
     *                 properties:
     *                   actions:
     *                     type: array
     *                     nullable: true
     *                     items:
     *                       type: string
     *                     description: >
     *                       The actions the grant permits, from the core actions and the extension kinds it lists.
     *                       `null` for every core kind.
     *                   expiresAt:
     *                     type: string
     *                     format: date-time
     *                     nullable: true
     *                     description: When the grant expires. `null` removes the expiry.
     *     responses:
     *       200:
     *         description: Whether the node accepted the change.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: The DID is not a grant of the current ID, or the change is refused.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *   delete:
     *     summary: Revoke a Memeplex grant of the current ID.
     *     description: >
     *       Deletes the grant's asset. The client can publish until the deletion is anchored on the grant's registry;
     *       `GET /revocations` lists it until then.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or alias of the grant.
     *     responses:
     *       200:
     *         description: Whether the node accepted the revocation.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: The DID is not a grant of the current ID.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.put('/grants/:id', async (req, res) => {
        try {
            const { changes } = req.body;
            const ok = await getKeymaster().updateGrant(req.params.id, changes);
            res.json({ ok });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    router.delete('/grants/:id', async (req, res) => {
        try {
            const ok = await getKeymaster().revokeGrant(req.params.id);
            res.json({ ok });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /assets/{id}:
     *   get:
     *     summary: Resolve (retrieve) an asset by DID or name.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The asset name or DID to resolve.
     *     responses:
     *       200:
     *         description: The resolved asset data.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 asset:
     *                   type: object
     *                   description: The `didDocumentData` for the asset, or null if not found.
     *       404:
     *         description: Asset not found or is deactivated.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.get('/assets/:id', async (req, res) => {
        try {
            const asset = await getKeymaster().resolveAsset(req.params.id);
            res.json({ asset });
        } catch (error: any) {
            sendNotFound(res, error, { error: 'Asset not found' });
        }
    });

    /**
     * @swagger
     * /assets/{id}:
     *   put:
     *     summary: Update an existing asset.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The asset DID or name to update.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               data:
     *                 type: object
     *                 description: The new data to store in this asset's DID Document.
     *     responses:
     *       200:
     *         description: Indicates whether the update was successful.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
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
    router.put('/assets/:id', async (req, res) => {
        try {
            const { data } = req.body;
            const ok = await getKeymaster().mergeData(req.params.id, data);
            res.json({ ok });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /assets/{id}/transfer:
     *   post:
     *     summary: Transfer ownership of an asset.
     *     description: >
     *       Transfers the ownership of the specified asset (identified by its DID or name) to a new controller.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or name of the asset to transfer.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               controller:
     *                 type: string
     *                 description: The DID of the new controller to transfer ownership to.
     *             required:
     *               - controller
     *     responses:
     *       200:
     *         description: Indicates whether the transfer was successful.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *                   description: true if the transfer was successful, otherwise `false`.
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
    router.post('/assets/:id/transfer', async (req, res) => {
        try {
            const { controller } = req.body;
            const ok = await getKeymaster().transferAsset(req.params.id, controller);
            res.json({ ok });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /assets/{id}/clone:
     *   post:
     *     summary: Clone an existing asset.
     *     description: >
     *       Creates a new asset by cloning the data of an existing asset identified by its DID or name.
     *       The cloned asset will include a reference to the original asset in its metadata.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or name of the asset to clone.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               options:
     *                 type: object
     *                 description: Additional parameters for cloning the asset.
     *                 properties:
     *                   registry:
     *                     type: string
     *                     description: The registry in which to create the cloned asset (e.g., "local", "hyperswarm").
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: Expiration timestamp for the cloned asset.
     *     responses:
     *       200:
     *         description: The DID of the newly created cloned asset.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *                   description: The DID of the cloned asset.
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
    router.post('/assets/:id/clone', async (req, res) => {
        try {
            const { options } = req.body;
            const did = await getKeymaster().cloneAsset(req.params.id, options);
            res.json({ did });
        } catch (error: any) {
            sendError(res, error);
        }
    });


    return router;
}
