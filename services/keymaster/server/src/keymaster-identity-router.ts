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

    /**
     * @swagger
     * /addresses:
     *   get:
     *     summary: List addresses stored for the current wallet.
     *     responses:
     *       200:
     *         description: A map of flattened `name@domain` addresses to metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 addresses:
     *                   type: object
     *                   additionalProperties:
     *                     type: object
     *                     properties:
     *                       added:
     *                         type: string
     *                         format: date-time
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
    router.get('/addresses', async (_req, res) => {
        try {
            const addresses = await getKeymaster().listAddresses();
            res.json({ addresses });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /addresses/{domain}:
     *   get:
     *     summary: Get the current stored address for a specific domain.
     *     parameters:
     *       - in: path
     *         name: domain
     *         required: true
     *         schema:
     *           type: string
     *         description: URL-encoded domain to look up.
     *     responses:
     *       200:
     *         description: Address record for the requested domain or null if none is stored.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 address:
     *                   nullable: true
     *                   type: object
     *                   properties:
     *                     domain:
     *                       type: string
     *                     name:
     *                       type: string
     *                     address:
     *                       type: string
     *                     added:
     *                       type: string
     *                       format: date-time
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.get('/addresses/:domain', async (req, res) => {
        try {
            const domain = decodeURIComponent(req.params.domain);
            const addresses = await getKeymaster().listAddresses();
            const entry = Object.entries(addresses).find(([address]) => address.endsWith(`@${domain}`));
            const address = entry
                ? {
                    domain,
                    name: entry[0].slice(0, -(domain.length + 1)),
                    address: entry[0],
                    ...entry[1],
                }
                : null;
            res.json({ address });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /addresses/import:
     *   post:
     *     summary: Import existing addresses for the current identity from a domain registry.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               domain:
     *                 type: string
     *             required:
     *               - domain
     *     responses:
     *       200:
     *         description: Imported flattened `name@domain` addresses and metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 addresses:
     *                   type: object
     *                   additionalProperties:
     *                     type: object
     *                     properties:
     *                       added:
     *                         type: string
     *                         format: date-time
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/addresses/import', async (req, res) => {
        try {
            const { domain } = req.body;
            const addresses = await getKeymaster().importAddress(domain);
            res.json({ addresses });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /addresses/check/{address}:
     *   get:
     *     summary: Check whether an address is claimed, available, unsupported, or unreachable.
     *     parameters:
     *       - in: path
     *         name: address
     *         required: true
     *         schema:
     *           type: string
     *         description: URL-encoded `name@domain` address to check.
     *     responses:
     *       200:
     *         description: Address availability result.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 address:
     *                   type: string
     *                 status:
     *                   type: string
     *                   enum: [claimed, available, unsupported, unreachable]
     *                 available:
     *                   type: boolean
     *                 did:
     *                   type: string
     *                   nullable: true
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.get('/addresses/check/:address', async (req, res) => {
        try {
            const address = decodeURIComponent(req.params.address);
            const result = await getKeymaster().checkAddress(address);
            res.json(result);
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /addresses:
     *   post:
     *     summary: Claim an address for the current identity.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               address:
     *                 type: string
     *             required:
     *               - address
     *     responses:
     *       200:
     *         description: Indicates whether the address was successfully claimed.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/addresses', async (req, res) => {
        try {
            const { address } = req.body;
            const ok = await getKeymaster().addAddress(address);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /addresses/publish:
     *   post:
     *     summary: Publish a stored address to the current identity DID document.
     *     description: Sets `didDocumentData.address` to the selected stored address. If the stored address has a Herald relay, also publishes an `Email` DID service endpoint using `mailto:<address>`.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               address:
     *                 type: string
     *                 description: Optional `name@domain` address to publish. Required when the identity has more than one stored address.
     *               name:
     *                 type: string
     *                 description: Optional identity name. Defaults to the current identity.
     *     responses:
     *       200:
     *         description: Indicates whether the address was successfully published.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/addresses/publish', async (req, res) => {
        try {
            const { address, name } = req.body || {};
            const ok = await getKeymaster().publishAddress(address, name);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /addresses/publish:
     *   delete:
     *     summary: Remove the published address from the current identity DID document.
     *     description: Removes `didDocumentData.address` and the `#email` DID service endpoint from the selected identity.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               name:
     *                 type: string
     *                 description: Optional identity name. Defaults to the current identity.
     *     responses:
     *       200:
     *         description: Indicates whether the address was successfully unpublished.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.delete('/addresses/publish', async (req, res) => {
        try {
            const { name } = req.body || {};
            const ok = await getKeymaster().unpublishAddress(name);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /didcomm/publish:
     *   post:
     *     summary: Publish an X25519 key-agreement key (and optional DIDComm service) to the current identity DID document.
     *     description: Derives the identity's deterministic X25519 key-agreement key and writes it into the DID document as a `keyAgreement` verification method, enabling DIDComm v2 encrypted messaging. If an endpoint is supplied, also publishes a `DIDCommMessaging` DID service endpoint.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               endpoint:
     *                 type: string
     *                 description: Optional DIDComm service endpoint URI. When provided, a `DIDCommMessaging` service entry is published.
     *               name:
     *                 type: string
     *                 description: Optional identity name. Defaults to the current identity.
     *               routingKeys:
     *                 type: array
     *                 items:
     *                   type: string
     *                 description: Optional mediator routing keys or DIDs. When present, the published `DIDCommMessaging` service advertises the object form (uri/accept/routingKeys) so senders wrap messages in a Forward to the mediator.
     *     responses:
     *       200:
     *         description: Indicates whether the key agreement key was successfully published.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/didcomm/publish', async (req, res) => {
        try {
            const { endpoint, name, routingKeys } = req.body || {};
            const ok = await getKeymaster().publishDidComm(endpoint, name, routingKeys);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /didcomm/publish:
     *   delete:
     *     summary: Remove the DIDComm key-agreement key and service from the current identity DID document.
     *     description: Removes the `keyAgreement` verification method and the `#didcomm` DID service endpoint from the selected identity.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               name:
     *                 type: string
     *                 description: Optional identity name. Defaults to the current identity.
     *     responses:
     *       200:
     *         description: Indicates whether the DIDComm key was successfully unpublished.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.delete('/didcomm/publish', async (req, res) => {
        try {
            const { name } = req.body || {};
            const ok = await getKeymaster().unpublishDidComm(name);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /didcomm/pack:
     *   post:
     *     summary: Pack a DIDComm v2 message (encrypted, optionally signed) for one or more recipients.
     *     description: Resolves each recipient DID's X25519 key-agreement key and produces a DIDComm encrypted (JWE) envelope. Authenticated-sender (authcrypt) by default; pass `anoncrypt` for an anonymous sender, and `sign` to add an ES256K signature (non-repudiation).
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               message:
     *                 type: object
     *                 description: The DIDComm plaintext message (type, body, and optional headers). `from`/`to` are set automatically.
     *               to:
     *                 oneOf:
     *                   - type: string
     *                   - type: array
     *                     items:
     *                       type: string
     *                 description: Recipient DID or array of recipient DIDs.
     *               options:
     *                 type: object
     *                 properties:
     *                   sign:
     *                     type: boolean
     *                   anoncrypt:
     *                     type: boolean
     *                   encryption:
     *                     type: string
     *                     enum: [A256CBC-HS512, XC20P, A256GCM]
     *                   name:
     *                     type: string
     *     responses:
     *       200:
     *         description: The packed DIDComm message.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 packed:
     *                   type: string
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/didcomm/pack', async (req, res) => {
        try {
            const { message, to, options } = req.body || {};
            const packed = await getKeymaster().packDidComm(message, to, options);
            res.json({ packed });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /didcomm/unpack:
     *   post:
     *     summary: Unpack (decrypt and verify) a DIDComm v2 message addressed to the current identity.
     *     description: Decrypts the envelope with the identity's X25519 key-agreement key, verifies the authenticated sender (authcrypt) and any nested ES256K signature, and returns the plaintext message with metadata.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               packed:
     *                 type: string
     *                 description: The packed DIDComm message.
     *               options:
     *                 type: object
     *                 properties:
     *                   name:
     *                     type: string
     *                     description: Optional identity name. Defaults to the current identity.
     *     responses:
     *       200:
     *         description: The unpacked message and metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 result:
     *                   type: object
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/didcomm/unpack', async (req, res) => {
        try {
            const { packed, options } = req.body || {};
            const result = await getKeymaster().unpackDidComm(packed, options);
            res.json({ result });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /didcomm/send:
     *   post:
     *     summary: Pack a DIDComm message and deliver it to each recipient's DIDCommMessaging mailbox.
     *     description: Packs the message (authcrypt by default; `anoncrypt`/`sign` options) and POSTs it to each recipient's resolved `DIDCommMessaging` endpoint. Returns the stored message ids.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               message:
     *                 type: object
     *               to:
     *                 oneOf:
     *                   - type: string
     *                   - type: array
     *                     items:
     *                       type: string
     *               options:
     *                 type: object
     *     responses:
     *       200:
     *         description: Delivered. Returns stored message ids.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ids:
     *                   type: array
     *                   items:
     *                     type: string
     *       400:
     *         description: Bad request.
     */
    router.post('/didcomm/send', async (req, res) => {
        try {
            const { message, to, options } = req.body || {};
            const ids = await getKeymaster().sendDidComm(message, to, options);
            res.json({ ids });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /didcomm/receive:
     *   post:
     *     summary: Fetch and unpack queued DIDComm messages from the current identity's mailbox.
     *     description: Proves DID control with a signed challenge, fetches queued envelopes from the identity's `DIDCommMessaging` endpoint, unpacks them, and acknowledges (removes) the ones that unpacked.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               options:
     *                 type: object
     *                 properties:
     *                   name:
     *                     type: string
     *                   endpoint:
     *                     type: string
     *     responses:
     *       200:
     *         description: The unpacked messages with metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 results:
     *                   type: array
     *                   items:
     *                     type: object
     *       400:
     *         description: Bad request.
     */
    router.post('/didcomm/receive', async (req, res) => {
        try {
            const { options } = req.body || {};
            const results = await getKeymaster().receiveDidComm(options);
            res.json({ results });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /didcomm/mediate:
     *   post:
     *     summary: Run the mediator relay — fetch Forward messages for this identity and relay each to its final recipient.
     *     description: For an identity acting as a DIDComm mediator. Fetches queued Forward envelopes from its mailbox, unpacks each, and relays the inner envelope to the recipient (`next`). Returns relayed/skipped counts.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               options:
     *                 type: object
     *                 properties:
     *                   name:
     *                     type: string
     *                   endpoint:
     *                     type: string
     *     responses:
     *       200:
     *         description: Relay result counts.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 result:
     *                   type: object
     *       400:
     *         description: Bad request.
     */
    router.post('/didcomm/mediate', async (req, res) => {
        try {
            const { options } = req.body || {};
            const result = await getKeymaster().mediateDidComm(options);
            res.json({ result });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /addresses/{address}:
     *   delete:
     *     summary: Remove the stored address for the current identity and revoke it remotely.
     *     parameters:
     *       - in: path
     *         name: address
     *         required: true
     *         schema:
     *           type: string
     *         description: URL-encoded `name@domain` address to remove.
     *     responses:
     *       200:
     *         description: Indicates whether the address was successfully removed.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.delete('/addresses/:address', async (req, res) => {
        try {
            const address = decodeURIComponent(req.params.address);
            const ok = await getKeymaster().removeAddress(address);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /nostr:
     *   post:
     *     summary: Add Nostr keys to the current identity.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               id:
     *                 type: string
     *                 description: "Identity name (optional, defaults to current)."
     *     responses:
     *       200:
     *         description: The generated Nostr keys.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 npub:
     *                   type: string
     *                 pubkey:
     *                   type: string
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/nostr', async (req, res) => {
        try {
            const { id } = req.body;
            const nostr = await getKeymaster().addNostr(id);
            res.json(nostr);
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /nostr:
     *   delete:
     *     summary: Remove Nostr keys from the current identity.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               id:
     *                 type: string
     *                 description: "Identity name (optional, defaults to current)."
     *     responses:
     *       200:
     *         description: Whether the removal succeeded.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.delete('/nostr', async (req, res) => {
        try {
            const { id } = req.body;
            const ok = await getKeymaster().removeNostr(id);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /nostr/import:
     *   post:
     *     summary: Import a Nostr private key (nsec) for the current identity.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               nsec:
     *                 type: string
     *                 description: Bech32-encoded Nostr private key.
     *               id:
     *                 type: string
     *                 description: "Identity name (optional, defaults to current)."
     *             required:
     *               - nsec
     *     responses:
     *       200:
     *         description: The imported Nostr public keys.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 npub:
     *                   type: string
     *                 pubkey:
     *                   type: string
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/nostr/import', async (req, res) => {
        try {
            const { nsec, id } = req.body;
            const nostr = await getKeymaster().importNostr(nsec, id);
            res.json(nostr);
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /nostr/nsec:
     *   post:
     *     summary: Export the Nostr private key (nsec) for the current identity.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               id:
     *                 type: string
     *                 description: "Identity name (optional, defaults to current)."
     *     responses:
     *       200:
     *         description: The bech32-encoded nsec private key.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 nsec:
     *                   type: string
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/nostr/nsec', async (req, res) => {
        try {
            const { id } = req.body;
            const nsec = await getKeymaster().exportNsec(id);
            res.json({ nsec });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /nostr/sign:
     *   post:
     *     summary: Sign a Nostr event with the current identity's key.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               event:
     *                 type: object
     *                 properties:
     *                   created_at:
     *                     type: integer
     *                   kind:
     *                     type: integer
     *                   tags:
     *                     type: array
     *                     items:
     *                       type: array
     *                       items:
     *                         type: string
     *                   content:
     *                     type: string
     *     responses:
     *       200:
     *         description: The signed Nostr event with id, pubkey, and sig fields.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 id:
     *                   type: string
     *                 pubkey:
     *                   type: string
     *                 created_at:
     *                   type: integer
     *                 kind:
     *                   type: integer
     *                 tags:
     *                   type: array
     *                   items:
     *                     type: array
     *                     items:
     *                       type: string
     *                 content:
     *                   type: string
     *                 sig:
     *                   type: string
     *       400:
     *         description: Bad request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/nostr/sign', async (req, res) => {
        try {
            const { event } = req.body;
            const signed = await getKeymaster().signNostrEvent(event);
            res.json(signed);
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    // Lightning routes

    /**
     * @swagger
     * /lightning:
     *   post:
     *     summary: Create a Lightning wallet for the current identity.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: Lightning wallet configuration.
     *       400:
     *         description: Error creating Lightning wallet.
     */
    router.post('/lightning', async (req, res) => {
        try {
            const { id } = req.body;
            const config = await getKeymaster().addLightning(id);
            res.json(config);
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /lightning:
     *   delete:
     *     summary: Remove Lightning wallet from the current identity.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: Success.
     *       400:
     *         description: Error removing Lightning wallet.
     */
    router.delete('/lightning', async (req, res) => {
        try {
            const { id } = req.body;
            const ok = await getKeymaster().removeLightning(id);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /lightning/balance:
     *   post:
     *     summary: Get Lightning wallet balance for the current identity.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: Balance in sats.
     *       400:
     *         description: Error getting balance.
     */
    router.post('/lightning/balance', async (req, res) => {
        try {
            const { id } = req.body;
            const balance = await getKeymaster().getLightningBalance(id);
            res.json(balance);
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /lightning/invoice:
     *   post:
     *     summary: Create a Lightning invoice to receive sats.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required:
     *               - amount
     *               - memo
     *             properties:
     *               amount:
     *                 type: number
     *                 description: Amount in sats.
     *               memo:
     *                 type: string
     *                 description: Invoice description.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: Lightning invoice.
     *       400:
     *         description: Error creating invoice.
     */
    router.post('/lightning/invoice', async (req, res) => {
        try {
            const { amount, memo, id } = req.body;
            const invoice = await getKeymaster().createLightningInvoice(amount, memo, id);
            res.json(invoice);
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /lightning/pay:
     *   post:
     *     summary: Pay a Lightning invoice.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required:
     *               - bolt11
     *             properties:
     *               bolt11:
     *                 type: string
     *                 description: BOLT11 invoice string.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: Payment result.
     *       400:
     *         description: Error paying invoice.
     */
    router.post('/lightning/pay', async (req, res) => {
        try {
            const { bolt11, id } = req.body;
            const payment = await getKeymaster().payLightningInvoice(bolt11, id);
            res.json(payment);
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /lightning/payment:
     *   post:
     *     summary: Check status of a Lightning payment.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required:
     *               - paymentHash
     *             properties:
     *               paymentHash:
     *                 type: string
     *                 description: Payment hash to check.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: Payment status.
     *       400:
     *         description: Error checking payment.
     */
    router.post('/lightning/payment', async (req, res) => {
        try {
            const { paymentHash, id } = req.body;
            const status = await getKeymaster().checkLightningPayment(paymentHash, id);
            res.json(status);
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /lightning/decode:
     *   post:
     *     summary: Decode a Lightning BOLT11 invoice.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               bolt11:
     *                 type: string
     *     responses:
     *       200:
     *         description: Decoded invoice details.
     *       400:
     *         description: Error decoding invoice.
     */
    router.post('/lightning/decode', async (req, res) => {
        try {
            const { bolt11 } = req.body;
            const info = await getKeymaster().decodeLightningInvoice(bolt11);
            res.json(info);
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /lightning/publish:
     *   post:
     *     summary: Publish Lightning service endpoint for a DID.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               id:
     *                 type: string
     *     responses:
     *       200:
     *         description: Lightning published successfully.
     *       400:
     *         description: Error publishing Lightning.
     */
    router.post('/lightning/publish', async (req, res) => {
        try {
            const id = req.body?.id;
            const ok = await getKeymaster().publishLightning(id);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /lightning/unpublish:
     *   post:
     *     summary: Unpublish Lightning service endpoint for a DID.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               id:
     *                 type: string
     *     responses:
     *       200:
     *         description: Lightning unpublished successfully.
     *       400:
     *         description: Error unpublishing Lightning.
     */
    router.post('/lightning/unpublish', async (req, res) => {
        try {
            const id = req.body?.id;
            const ok = await getKeymaster().unpublishLightning(id);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /lightning/zap:
     *   post:
     *     summary: Send sats to a DID via Lightning.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               did:
     *                 type: string
     *               amount:
     *                 type: integer
     *               memo:
     *                 type: string
     *               id:
     *                 type: string
     *     responses:
     *       200:
     *         description: Payment result with preimage.
     *       400:
     *         description: Error sending payment.
     */
    router.post('/lightning/zap', async (req, res) => {
        try {
            const { did, amount, memo, id } = req.body;
            const result = await getKeymaster().zapLightning(did, amount, memo, id);
            res.json(result);
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /lightning/payments:
     *   post:
     *     summary: Get Lightning payment history.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               id:
     *                 type: string
     *     responses:
     *       200:
     *         description: List of payments.
     *       400:
     *         description: Error fetching payments.
     */
    router.post('/lightning/payments', async (req, res) => {
        try {
            const { id } = req.body;
            const payments = await getKeymaster().getLightningPayments(id);
            res.json({ payments });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    return router;
}
