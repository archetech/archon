import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createCredentialWorkflowRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

    /**
     * @swagger
     * /credentials/bind:
     *   post:
     *     summary: Prepare (bind) a credential without issuing it.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               subject:
     *                 type: string
     *                 description: The subject DID (or name) for whom this credential is bound.
     *               options:
     *                 type: object
     *                 description: Optional parameters for credential creation.
     *                 properties:
     *                   schema:
     *                     type: string
     *                     description: The schema DID or name to which this credential conforms.
     *                   claims:
     *                     type: object
     *                     description: Claims to include in the credential. If omitted, defaults are generated from the schema.
     *                   types:
     *                     type: array
     *                     items:
     *                       type: string
     *                     description: Additional semantic types to add to the credential type array.
     *                   validFrom:
     *                     type: string
     *                     format: date-time
     *                     description: The date/time the credential becomes valid. Defaults to the current time if omitted.
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: The date/time the credential expires. Omit for an open-ended credential.
     *     responses:
     *       200:
     *         description: The prepared credential object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 credential:
     *                   type: object
     *                   description: The bound credential.
     *       400:
     *         description: Invalid parameters or schema/subject issues.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/credentials/bind', async (req, res) => {
        try {
            const { subject, options } = req.body;
            const credential = await getKeymaster().bindCredential(subject, options);
            res.json({ credential });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /credentials/held:
     *   get:
     *     summary: List all credentials currently held by the active ID.
     *     responses:
     *       200:
     *         description: The list of held credential DIDs.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 held:
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
    router.get('/credentials/held', async (req, res) => {
        try {
            const held = await getKeymaster().listCredentials();
            res.json({ held });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /credentials/held:
     *   post:
     *     summary: Accept a credential into the "held" list of the current ID.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               did:
     *                 type: string
     *                 description: The credential DID to hold.
     *             required:
     *               - did
     *     responses:
     *       200:
     *         description: Whether the acceptance was successful.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Invalid DID or failure to accept the credential.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/credentials/held', async (req, res) => {
        try {
            const { did } = req.body;
            const ok = await getKeymaster().acceptCredential(did);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /credentials/held/{did}:
     *   get:
     *     summary: Retrieve (decrypt) a held credential.
     *     parameters:
     *       - in: path
     *         name: did
     *         required: true
     *         schema:
     *           type: string
     *         description: The credential DID to retrieve.
     *     responses:
     *       200:
     *         description: The decrypted credential.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 credential:
     *                   type: object
     *                   description: The credential contents (VC).
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
    router.get('/credentials/held/:did', async (req, res) => {
        try {
            const credential = await getKeymaster().getCredential(req.params.did);
            res.json({ credential });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /credentials/held/{did}:
     *   delete:
     *     summary: Remove a credential from the "held" list.
     *     parameters:
     *       - in: path
     *         name: did
     *         required: true
     *         schema:
     *           type: string
     *         description: The credential DID to remove from holdings.
     *     responses:
     *       200:
     *         description: Whether the removal was successful.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Invalid DID or request error.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.delete('/credentials/held/:did', async (req, res) => {
        try {
            const ok = await getKeymaster().removeCredential(req.params.did);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /credentials/held/{did}/publish:
     *   post:
     *     summary: Publish a held credential publicly.
     *     parameters:
     *       - in: path
     *         name: did
     *         required: true
     *         schema:
     *           type: string
     *         description: The credential DID to publish from the holder's wallet.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               options:
     *                 type: object
     *                 description: Additional parameters controlling the publication.
     *                 properties:
     *                   reveal:
     *                     type: boolean
     *                     default: false
     *                     description: Whether to include the full credential data or just a reference.
     *     responses:
     *       200:
     *         description: Indicates whether the publish operation was successful.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: object
     *                   description: The updated DID Document or partial success info.
     *       400:
     *         description: Credential not held by this ID or invalid request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/credentials/held/:did/publish', async (req, res) => {
        try {
            const did = req.params.did;
            const { options } = req.body;
            const ok = await getKeymaster().publishCredential(did, options);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /credentials/held/{did}/unpublish:
     *   post:
     *     summary: Remove a published credential from the holder’s DID Document manifest.
     *     parameters:
     *       - in: path
     *         name: did
     *         required: true
     *         schema:
     *           type: string
     *         description: The credential DID to unpublish.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             description: No additional parameters by default.
     *     responses:
     *       200:
     *         description: Indicates whether the unpublish operation was successful.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: string
     *                   description: Status message or success flag.
     *       400:
     *         description: Credential not found in the DID Document's manifest or invalid request.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/credentials/held/:did/unpublish', async (req, res) => {
        try {
            const did = req.params.did;
            const ok = await getKeymaster().unpublishCredential(did);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /credentials/issued:
     *   get:
     *     summary: List all credentials issued by the current ID.
     *     responses:
     *       200:
     *         description: The list of credential DIDs issued by the current ID.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 issued:
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
    router.get('/credentials/issued', async (req, res) => {
        try {
            const issued = await getKeymaster().listIssued();
            res.json({ issued });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /credentials/issued:
     *   post:
     *     summary: Issue a new credential.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               credential:
     *                 type: object
     *                 description: A valid credential object. If omitted, `options.schema` and `options.subject` can be used to generate one.
     *               options:
     *                 type: object
     *                 description: Additional issuance parameters.
     *                 properties:
     *                   schema:
     *                     type: string
     *                     description: DID or name of the schema, used if `credential` is not fully provided.
     *                   subject:
     *                     type: string
     *                     description: DID or name of the subject for which the credential is being issued.
     *                   registry:
     *                     type: string
     *                     description: Where to create the credential DID (e.g., "local", "hyperswarm").
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: Expiration for the credential DID, if ephemeral.
     *                   retries:
     *                     type: integer
     *                     default: 0
     *                     description: Retries for DID creation or resolution if needed.
     *                   delay:
     *                     type: integer
     *                     default: 1000
     *                     description: Delay between retries in milliseconds.
     *                   encryptForSender:
     *                     type: boolean
     *                     description: Include an encrypted copy for the issuer. Defaults to true.
     *                   includeHash:
     *                     type: boolean
     *                     description: Embed a hash of the credential in the asset. Defaults to false.
     *                   controller:
     *                     type: string
     *                     description: Specific ID or DID to set as the controller of the new asset. Defaults to the issuer’s current ID.
     *     responses:
     *       200:
     *         description: The DID of the newly issued credential asset.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *       400:
     *         description: Invalid credential data or issuance error.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/credentials/issued', async (req, res) => {
        try {
            const { credential, options } = req.body;
            const did = await getKeymaster().issueCredential(credential, options);
            res.json({ did });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /credentials/issued/{did}:
     *   get:
     *     summary: Retrieve an issued credential by DID.
     *     parameters:
     *       - in: path
     *         name: did
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the issued credential to retrieve.
     *     responses:
     *       200:
     *         description: The decrypted credential object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 credential:
     *                   type: object
     *                   description: The credential data.
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
    // eslint-disable-next-line
    router.get('/credentials/issued/:did', async (req, res) => {
        try {
            const did = req.params.did;
            const credential = await getKeymaster().getCredential(did);
            res.json({ credential });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /credentials/issued/{did}/send:
     *   post:
     *     summary: Send an issued credential to its subject.
     *     description: >
     *       Creates a notice to deliver the specified issued credential to its credentialSubject.
     *       The notice is created in the ephemeral registry and is valid for 7 days by default.
     *       Returns null if the credential cannot be found.
     *     parameters:
     *       - in: path
     *         name: did
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the issued credential to send.
     *     responses:
     *       200:
     *         description: The DID of the created notice, or null if the credential was not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *                   nullable: true
     *                   description: The DID of the notice created to deliver the credential, or null if the credential doesn't exist.
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
    router.post('/credentials/issued/:did/send', async (req, res) => {
        try {
            const { options } = req.body;
            const did = await getKeymaster().sendCredential(req.params.did, options);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /credentials/issued/{did}:
     *   post:
     *     summary: Update an existing issued credential.
     *     parameters:
     *       - in: path
     *         name: did
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the issued credential to update.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               credential:
     *                 type: object
     *                 description: The new credential data to store.
     *             required:
     *               - credential
     *     responses:
     *       200:
     *         description: Whether the update was successful.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Invalid credential or operation error.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/credentials/issued/:did', async (req, res) => {
        try {
            const did = req.params.did;
            const { credential } = req.body;
            const ok = await getKeymaster().updateCredential(did, credential);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /credentials/issued/{did}:
     *   delete:
     *     summary: Revoke a previously issued credential.
     *     parameters:
     *       - in: path
     *         name: did
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the credential to revoke.
     *     responses:
     *       200:
     *         description: Whether the revocation (delete) operation was successful.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       400:
     *         description: Invalid DID or revocation error.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.delete('/credentials/issued/:did', async (req, res) => {
        try {
            const did = req.params.did;
            const ok = await getKeymaster().revokeCredential(did);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });


    return router;
}
