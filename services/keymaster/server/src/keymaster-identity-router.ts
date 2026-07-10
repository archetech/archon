import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createIdentityRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster, walletOperationsTotal, didNotFound: DIDNotFound } = options;
    const router = express.Router();

    /**
     * @swagger
     * /did/{id}:
     *   get:
     *     summary: Resolve a DID Document.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or name to resolve.
     *       - in: query
     *         name: versionTime
     *         required: false
     *         schema:
     *           type: string
     *           format: date-time
     *         description: >
     *           Timestamp to return the state of the DID as of this specific time (RFC3339/ISO8601 format).
     *       - in: query
     *         name: versionSequence
     *         required: false
     *         schema:
     *           type: integer
     *         description: >
     *           Specific version of the DID Document to retrieve. Increments each time an `update` or `delete` operation occurs.
     *       - in: query
     *         name: confirm
     *         required: false
     *         schema:
     *           type: boolean
     *         description: >
     *           If true, returns the DID Document only if it is fully confirmed on the registry it references.
     *       - in: query
     *         name: verify
     *         required: false
     *         schema:
     *           type: boolean
     *         description: >
     *           If true, verifies the proof(s) of the DID operation(s) before returning the DID Document.
     *           If a proof is invalid, an error is thrown.
     *     responses:
     *       200:
     *         description: Successfully resolved the DID Document.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 docs:
     *                   type: object
     *                   description: The resolved DID Document and its metadata.
     *                   properties:
     *                     "@context":
     *                       type: string
     *                       description: DID resolution context (usually "https://w3id.org/did-resolution/v1").
     *                     didDocument:
     *                       type: object
     *                       description: The actual DID Document, if it exists.
     *                       properties:
     *                         "@context":
     *                           type: array
     *                           items:
     *                             type: string
     *                           description: DID Document contexts.
     *                         id:
     *                           type: string
     *                           description: The DID this document represents.
     *                         controller:
     *                           type: string
     *                           description: The DID or entity controlling this asset (if applicable).
     *                         verificationMethod:
     *                           type: array
     *                           description: An array of verification methods (keys).
     *                           items:
     *                             type: object
     *                             properties:
     *                               id:
     *                                 type: string
     *                               controller:
     *                                 type: string
     *                               type:
     *                                 type: string
     *                               publicKeyJwk:
     *                                 type: object
     *                                 description: Public key in JWK format.
     *                         authentication:
     *                           type: array
     *                           items:
     *                             type: string
     *                           description: Verification method references used for authentication.
     *                     didDocumentMetadata:
     *                       type: object
     *                       description: Metadata about the DID Document.
     *                       properties:
     *                         created:
     *                           type: string
     *                           format: date-time
     *                         updated:
     *                           type: string
     *                           format: date-time
     *                         deleted:
     *                           type: string
     *                           format: date-time
     *                         version:
     *                           type: integer
     *                         versionId:
     *                           type: string
     *                           description: A CID or similar identifier for the version.
     *                         canonicalId:
     *                           type: string
     *                         confirmed:
     *                           type: boolean
     *                         deactivated:
     *                           type: boolean
     *                     didDocumentData:
     *                       type: object
     *                       description: Arbitrary data attached to the DID (only present for assets).
     *                     didDocumentRegistration:
     *                       type: object
     *                       description: Registration metadata fields.
     *                       properties:
     *                         type:
     *                           type: string
     *                           enum: [ "agent", "asset" ]
     *                         registry:
     *                           type: string
     *                           enum: [ "local", "hyperswarm", "BTC:mainnet", "BTC:testnet4", "BTC:signet" ]
     *                         version:
     *                           type: integer
     *                         validUntil:
     *                           type: string
     *                           format: date-time
     *                         registration:
     *                           type: string
     *       404:
     *         description: DID not found or cannot be resolved.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.get('/did/:id', async (req, res) => {
        try {
            const docs = await getKeymaster().resolveDID(req.params.id, req.query);
            res.json({ docs });
        } catch (error: any) {
            res.status(404).send(DIDNotFound);
        }
    });

    /**
     * @swagger
     * /did/{id}:
     *   delete:
     *     summary: Revoke a DID.
     *     description: Removes an existing DID from the system, effectively revoking it.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID to revoke.
     *     responses:
     *       200:
     *         description: Indicates whether the DID was successfully revoked.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *                   description: true if the DID was successfully revoked, otherwise false.
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
    router.delete('/did/:id', async (req, res) => {
        try {
            const ok = await getKeymaster().revokeDID(req.params.id);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /did/{id}:
     *   put:
     *     summary: Update a DID document.
     *     description: Updates the DID document with the provided data.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID to update.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               doc:
     *                 type: object
     *                 description: The DID document fields to update.
     *     responses:
     *       200:
     *         description: Indicates whether the DID was successfully updated.
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
    router.put('/did/:id', async (req, res) => {
        try {
            const ok = await getKeymaster().updateDID(req.params.id, req.body.doc);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /ids/current:
     *   get:
     *     summary: Retrieve the current ID name.
     *     responses:
     *       200:
     *         description: The current ID name.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 current:
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
    router.get('/ids/current', async (req, res) => {
        try {
            const current = await getKeymaster().getCurrentId();
            res.json({ current });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /ids/current:
     *   put:
     *     summary: Set the current ID.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               name:
     *                 type: string
     *                 description: The name of the ID to set as current.
     *             required:
     *               - name
     *     responses:
     *       200:
     *         description: Indicates if the current ID was successfully updated.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Invalid name or unknown ID.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.put('/ids/current', async (req, res) => {
        try {
            const { name } = req.body;
            const ok = await getKeymaster().setCurrentId(name);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /ids:
     *   get:
     *     summary: List all ID names in the wallet.
     *     responses:
     *       200:
     *         description: A list of ID names.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ids:
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
    router.get('/ids', async (req, res) => {
        try {
            const ids = await getKeymaster().listIds();
            res.json({ ids });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /ids:
     *   post:
     *     summary: Create a new ID in the wallet.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               name:
     *                 type: string
     *                 description: The name of the new ID.
     *               options:
     *                 type: object
     *                 description: Optional parameters.
     *                 properties:
     *                   registry:
     *                     type: string
     *                     enum: [ "local", "hyperswarm", "BTC:testnet4", "BTC:signet" ]
     *     responses:
     *       200:
     *         description: The DID created for the new ID.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *                   description: A DID string identifying the new ID.
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
    router.post('/ids', async (req, res) => {
        try {
            const { name, options } = req.body;
            const did = await getKeymaster().createId(name, options);
            walletOperationsTotal.inc({ operation: 'createId', status: 'success' });
            res.json({ did });
        } catch (error: any) {
            walletOperationsTotal.inc({ operation: 'createId', status: 'error' });
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /ids/{id}:
     *   get:
     *     summary: Resolve an ID to a DID Document.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID to resolve.
     *     responses:
     *       200:
     *         description: The resolved DID Document.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 docs:
     *                   type: object
     *                   description: The DID Document and associated metadata.
     *       404:
     *         description: ID not found.
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
    router.get('/ids/:id', async (req, res) => {
        try {
            const docs = await getKeymaster().resolveDID(req.params.id);
            res.json({ docs });
        } catch (error: any) {
            res.status(404).send({ error: 'ID not found' });
        }
    });

    /**
     * @swagger
     * /ids/{id}:
     *   delete:
     *     summary: Remove an existing ID from the wallet.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The name of the ID to remove.
     *     responses:
     *       200:
     *         description: Indicates whether the ID was successfully removed.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Invalid ID or request error.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.delete('/ids/:id', async (req, res) => {
        try {
            const ok = await getKeymaster().removeId(req.params.id);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /ids/{id}/rename:
     *   post:
     *     summary: Rename an existing ID in the wallet.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The current name of the ID to be renamed.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               name:
     *                 type: string
     *                 description: The new name for the ID.
     *             required:
     *               - name
     *     responses:
     *       200:
     *         description: Indicates whether the rename was successful.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Invalid ID or the new name is unavailable.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/ids/:id/rename', async (req, res) => {
        try {
            const { name } = req.body;
            const ok = await getKeymaster().renameId(req.params.id, name);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /ids/{id}/change-registry:
     *   post:
     *     summary: Change the registry for an existing DID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The ID name or DID to change the registry for.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               registry:
     *                 type: string
     *             required:
     *               - registry
     *     responses:
     *       200:
     *         description: Indicates whether the registry change was successful.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Invalid registry or other error.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/ids/:id/change-registry', async (req, res) => {
        try {
            const { registry } = req.body;
            const ok = await getKeymaster().changeRegistry(req.params.id, registry);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /ids/{id}/backup:
     *   post:
     *     summary: Backup the specified ID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The ID name or DID to back up.
     *     responses:
     *       200:
     *         description: Indicates whether the backup operation succeeded.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Invalid ID or request error.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/ids/:id/backup', async (req, res) => {
        try {
            const ok = await getKeymaster().backupId(req.params.id);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /ids/{id}/recover:
     *   post:
     *     summary: Recover an existing ID from a backup reference.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The ID name or DID to recover.
     *     responses:
     *       200:
     *         description: The ID name that was recovered and is now current.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 recovered:
     *                   type: string
     *       404:
     *         description: Backup DID not found or invalid ID.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *       500:
     *         description: Other error when recovering the ID.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/ids/:id/recover', async (req, res) => {
        try {
            const current = await getKeymaster().recoverId(req.params.id);
            res.json({ recovered: current });
        } catch (error: any) {
            if (error.error === DIDNotFound.error) {
                res.status(404).send(DIDNotFound);
            }
            else {
                res.status(500).send({ error: error.toString() });
            }
        }
    });

    /**
     * @swagger
     * /aliases:
     *   get:
     *     summary: List all alias-to-DID mappings in the wallet.
     *     responses:
     *       200:
     *         description: A list of all alias-to-DID mappings.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 aliases:
     *                   type: object
     *                   additionalProperties:
     *                     type: string
     *                   description: An object where each key is an alias, and each value is the associated DID.
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
    router.get('/aliases', async (req, res) => {
        try {
            const aliases = await getKeymaster().listAliases();
            res.json({ aliases });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /aliases:
     *   post:
     *     summary: Add a new alias-to-DID mapping.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               alias:
     *                 type: string
     *                 description: The human-readable alias to associate with the DID.
     *               did:
     *                 type: string
     *                 description: The DID that this alias should refer to.
     *             required:
     *               - alias
     *               - did
     *     responses:
     *       200:
     *         description: Indicates whether the mapping was successfully created.
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
    router.post('/aliases', async (req, res) => {
        try {
            const { alias, did } = req.body;
            const ok = await getKeymaster().addAlias(alias, did);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /aliases/{alias}:
     *   get:
     *     summary: Retrieve the DID associated with a specific alias.
     *     description: Returns the DID for the provided human-readable alias, if it exists.
     *     parameters:
     *       - in: path
     *         name: alias
     *         required: true
     *         schema:
     *           type: string
     *         description: The alias for which you want the associated DID.
     *     responses:
     *       200:
     *         description: The DID associated with the requested alias.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *       404:
     *         description: The requested alias was not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.get('/aliases/:alias', async (req, res) => {
        try {
            const did = await getKeymaster().getAlias(req.params.alias);
            res.json({ did });
        } catch (error: any) {
            res.status(404).send(DIDNotFound);
        }
    });

    /**
     * @swagger
     * /aliases/{alias}:
     *   delete:
     *     summary: Remove an existing alias-to-DID mapping.
     *     parameters:
     *       - in: path
     *         name: alias
     *         required: true
     *         schema:
     *           type: string
     *         description: The alias whose mapping should be removed.
     *     responses:
     *       200:
     *         description: Indicates whether the mapping was successfully removed.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: The requested alias was invalid or could not be removed.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.delete('/aliases/:alias', async (req, res) => {
        try {
            const ok = await getKeymaster().removeAlias(req.params.alias);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    return router;
}
