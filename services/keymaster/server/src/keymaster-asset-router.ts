import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

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
            res.status(500).send({ error: error.toString() });
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
            res.status(500).send({ error: error.toString() });
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
            res.status(404).send({ error: 'Asset not found' });
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
            res.status(500).send({ error: error.toString() });
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
            res.status(500).send({ error: error.toString() });
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
            res.status(500).send({ error: error.toString() });
        }
    });


    return router;
}
