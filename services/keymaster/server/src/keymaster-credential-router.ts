import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createCredentialRouter(options: CreateKeymasterRouterOptions): express.Router {
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

    /**
     * @swagger
     * /response:
     *   post:
     *     summary: Create a response to an existing challenge DID.
     *     description: >
     *       Accepts a challenge DID (the DID of a previously created challenge) and an `options` object, then returns a new DID containing the
     *       response. Internally, the Keymaster finds matching credentials and bundles them into verifiable presentations. The response is
     *       encrypted for the original challenge's controller and stored as a new asset DID.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               challenge:
     *                 type: string
     *                 description: DID of the challenge to respond to.
     *               options:
     *                 type: object
     *                 description: Additional parameters controlling how the response is created and stored.
     *                 properties:
     *                   registry:
     *                     type: string
     *                     description: The registry where the new response DID will be created (e.g., "local", "hyperswarm").
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: Expiration time for the response DID. If omitted, defaults to 1 hour from now.
     *                   retries:
     *                     type: integer
     *                     description: How many times to retry resolving the challenge DID if it is not immediately resolvable.
     *                     default: 0
     *                   delay:
     *                     type: integer
     *                     description: Milliseconds to wait between retries.
     *                     default: 1000
     *                   encryptForSender:
     *                     type: boolean
     *                     description: Whether to include an encrypted copy for the sender (the responding party). Defaults to true.
     *                   includeHash:
     *                     type: boolean
     *                     description: Whether to embed a hash of the plaintext in the stored asset. Defaults to false.
     *                   controller:
     *                     type: string
     *                     description: A specific ID or DID to act as the controller of the newly created asset. If not set, the current ID is used.
     *     responses:
     *       200:
     *         description: A DID containing the response to the challenge.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *                   description: The DID of the newly created response asset.
     *       400:
     *         description: Invalid input (e.g., challenge not found, or required parameters missing).
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
    router.post('/response', async (req, res) => {
        try {
            const { challenge, options } = req.body;
            const did = await getKeymaster().createResponse(challenge, options);
            res.json({ did });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /response/verify:
     *   post:
     *     summary: Verify a response to a challenge.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               response:
     *                 type: string
     *                 description: DID of the challenge response asset to verify.
     *               options:
     *                 type: object
     *                 description: Additional verification parameters.
     *                 properties:
     *                   retries:
     *                     type: integer
     *                     description: How many times to retry resolving the response DID if initially not found.
     *                     default: 0
     *                   delay:
     *                     type: integer
     *                     description: How many milliseconds to wait between resolution retries.
     *                     default: 1000
     *                   versionTime:
     *                     type: string
     *                     format: date-time
     *                     description: If provided, attempts to resolve the response DID as of a specific point in time.
     *                   versionSequence:
     *                     type: integer
     *                     description: If provided, attempts to resolve the response DID at a specific version.
     *                   confirm:
     *                     type: boolean
     *                     description: If true, only returns the DID if it is fully confirmed on its registry.
     *                   verify:
     *                     type: boolean
     *                     description: If true, verifies the proof(s) of the response operation(s) before returning the DID Document.
     *     responses:
     *       200:
     *         description: The result of the verification process.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 verify:
     *                   type: object
     *                   description: A detailed verification result.
     *                   properties:
     *                     challenge:
     *                       type: string
     *                       description: The DID of the original challenge.
     *                     credentials:
     *                       type: array
     *                       items:
     *                         type: object
     *                       description: Each credential pair (vc, vp) the response included.
     *                     match:
     *                       type: boolean
     *                       description: true if the response satisfies all challenge requirements, otherwise `false`.
     *                     vps:
     *                       type: array
     *                       description: Any verifiable presentations that passed verification.
     *                       items:
     *                         type: object
     *                     responder:
     *                       type: string
     *                       description: The DID (controller) of the responder.
     *       400:
     *         description: Verification failed or request was invalid.
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
    router.post('/response/verify', async (req, res) => {
        try {
            const { response, options } = req.body;
            const verify = await getKeymaster().verifyResponse(response, options);
            res.json({ verify });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /groups:
     *   get:
     *     summary: List all group DIDs owned by (or associated with) a specific ID.
     *     parameters:
     *       - in: query
     *         name: owner
     *         required: false
     *         schema:
     *           type: string
     *         description: The name or DID of the owner ID for which to list groups.
     *     responses:
     *       200:
     *         description: An array of group DIDs.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 groups:
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
    router.get('/groups', async (req, res) => {
        try {
            const param = typeof req.query.owner === 'string' ? req.query.owner : undefined;
            const groups = await getKeymaster().listGroups(param);
            res.json({ groups });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /groups:
     *   post:
     *     summary: Create a new group asset (DID).
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               name:
     *                 type: string
     *                 description: The human-readable name of the group.
     *               options:
     *                 type: object
     *                 description: Additional parameters for creating the group.
     *                 properties:
     *                   members:
     *                     type: array
     *                     items:
     *                       type: string
     *                     description: An array of member DIDs or sub-group DIDs to include initially.
     *                   registry:
     *                     type: string
     *                     description: The registry in which to create the group DID (e.g., "local", "hyperswarm").
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: Timestamp indicating when this group asset should expire (optional).
     *                   retries:
     *                     type: integer
     *                     default: 0
     *                     description: How many times to retry DID creation if immediate creation fails.
     *                   delay:
     *                     type: integer
     *                     default: 1000
     *                     description: Delay in milliseconds between retries.
     *                   encryptForSender:
     *                     type: boolean
     *                     description: Whether to include an encrypted copy for the current ID. Defaults to true if encryption is used.
     *                   includeHash:
     *                     type: boolean
     *                     description: Whether to embed a hash of the group's data in the created asset. Defaults to false.
     *                   controller:
     *                     type: string
     *                     description: An ID or DID that should be set as the controller of this new group asset. Defaults to the current ID if omitted.
     *     responses:
     *       200:
     *         description: The DID representing the newly created group.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
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
    router.post('/groups', async (req, res) => {
        try {
            const { name, options } = req.body;
            const did = await getKeymaster().createGroup(name, options);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /groups/{name}:
     *   get:
     *     summary: Retrieve an existing group.
     *     description: Returns the stored group object (including its name and members) for the given group DID or name.
     *     parameters:
     *       - in: path
     *         name: name
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the group to retrieve.
     *     responses:
     *       200:
     *         description: The group object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 group:
     *                   type: object
     *                   properties:
     *                     name:
     *                       type: string
     *                     members:
     *                       type: array
     *                       items:
     *                         type: string
     *       404:
     *         description: The requested group was not found.
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
    router.get('/groups/:name', async (req, res) => {
        try {
            const group = await getKeymaster().getGroup(req.params.name);
            res.json({ group });
        } catch (error: any) {
            res.status(404).send({ error: 'Group not found' });
        }
    });

    /**
     * @swagger
     * /groups/{name}/add:
     *   post:
     *     summary: Add a member to an existing group.
     *     description: Adds a DID (or group) as a member of the specified group.
     *     parameters:
     *       - in: path
     *         name: name
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the group to update.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               member:
     *                 type: string
     *                 description: The DID (or group DID) to add as a member.
     *             required:
     *               - member
     *     responses:
     *       200:
     *         description: Indicates whether the member was successfully added.
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
    router.post('/groups/:name/add', async (req, res) => {
        try {
            const { member } = req.body;
            const ok = await getKeymaster().addGroupMember(req.params.name, member);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /groups/{name}/remove:
     *   post:
     *     summary: Remove a member from an existing group.
     *     parameters:
     *       - in: path
     *         name: name
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the group to update.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               member:
     *                 type: string
     *                 description: The DID (or group DID) to remove from the group.
     *             required:
     *               - member
     *     responses:
     *       200:
     *         description: Indicates whether the member was successfully removed.
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
    router.post('/groups/:name/remove', async (req, res) => {
        try {
            const { member } = req.body;
            const ok = await getKeymaster().removeGroupMember(req.params.name, member);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /groups/{name}/test:
     *   post:
     *     summary: Test membership in a group.
     *     parameters:
     *       - in: path
     *         name: name
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the group to test.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               member:
     *                 type: string
     *                 description: The DID or group DID to check for membership.
     *     responses:
     *       200:
     *         description: The result of the membership test.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 test:
     *                   type: boolean
     *                   description: true if the member is found in the group, otherwise `false`.
     *       400:
     *         description: Invalid input or request could not be processed.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/groups/:name/test', async (req, res) => {
        try {
            const { member } = req.body;
            const test = await getKeymaster().testGroup(req.params.name, member);
            res.json({ test });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /schemas:
     *   get:
     *     summary: List all schema DIDs owned by (or associated with) a specific ID.
     *     parameters:
     *       - in: query
     *         name: owner
     *         required: false
     *         schema:
     *           type: string
     *         description: The name or DID of the owner whose schemas should be listed.
     *     responses:
     *       200:
     *         description: A list of schema DIDs.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 schemas:
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
    router.get('/schemas', async (req, res) => {
        try {
            const param = typeof req.query.owner === 'string' ? req.query.owner : undefined;
            const schemas = await getKeymaster().listSchemas(param);
            res.json({ schemas });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /schemas:
     *   post:
     *     summary: Create a new schema.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               schema:
     *                 type: object
     *                 description: A valid JSON Schema to be stored.
     *               options:
     *                 type: object
     *                 description: Additional creation parameters.
     *                 properties:
     *                   registry:
     *                     type: string
     *                     description: The registry in which to create the schema DID (e.g., "local", "hyperswarm").
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: Optional expiration date/time for ephemeral schemas.
     *     responses:
     *       200:
     *         description: The DID representing the newly created schema.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
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
    router.post('/schemas', async (req, res) => {
        try {
            const { schema, options } = req.body;
            const did = await getKeymaster().createSchema(schema, options);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /schemas/{id}:
     *   get:
     *     summary: Retrieve a stored schema.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the schema to retrieve.
     *     responses:
     *       200:
     *         description: The JSON Schema object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 schema:
     *                   type: object
     *                   description: The retrieved JSON Schema.
     *       404:
     *         description: Schema not found.
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
    router.get('/schemas/:id', async (req, res) => {
        try {
            const schema = await getKeymaster().getSchema(req.params.id);
            res.json({ schema });
        } catch (error: any) {
            res.status(404).send({ error: 'Schema not found' });
        }
    });

    /**
     * @swagger
     * /schemas/{id}:
     *   put:
     *     summary: Update an existing schema.
     *     description: >
     *       Replaces the schema (if valid) associated with the given DID or name.
     *       This operation will preserve the same DID while storing an updated schema in the underlying asset data.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the schema to update.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               schema:
     *                 type: object
     *                 description: The new JSON Schema to store.
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
    router.put('/schemas/:id', async (req, res) => {
        try {
            const { schema } = req.body;
            const ok = await getKeymaster().setSchema(req.params.id, schema);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /schemas/{id}/test:
     *   post:
     *     summary: Test if a DID or name refers to a valid schema.
     *     description: >
     *       Checks whether the given DID or name refers to an asset containing a valid JSON Schema.
     *       Returns true if it's a recognized valid schema, otherwise `false`.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the schema to test.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             description: No required body parameters (reserved for future use).
     *     responses:
     *       200:
     *         description: Whether the asset is recognized as a valid schema.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 test:
     *                   type: boolean
     *                   description: true if the asset is a valid schema, otherwise `false`.
     *       400:
     *         description: Invalid DID/name or request processing error.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/schemas/:id/test', async (req, res) => {
        try {
            const test = await getKeymaster().testSchema(req.params.id);
            res.json({ test });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /agents/{id}/test:
     *   post:
     *     summary: Check whether the given ID (or DID) is an agent.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The ID name or DID to test.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             description: No body required for this endpoint.
     *     responses:
     *       200:
     *         description: Whether the specified DID is recognized as an agent.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 test:
     *                   type: boolean
     *                   description: true if the DID is an agent; otherwise `false`.
     *       400:
     *         description: Invalid request or DID.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/agents/:id/test', async (req, res) => {
        try {
            const test = await getKeymaster().testAgent(req.params.id);
            res.json({ test });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

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

    /**
     * @swagger
     * /keys/rotate:
     *   post:
     *     summary: Rotate the current ID's keys.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             description: No options required. Key rotation applies to the current ID.
     *     responses:
     *       200:
     *         description: Indicates whether key rotation was successful.
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
    router.post('/keys/rotate', async (req, res) => {
        try {
            const ok = await getKeymaster().rotateKeys();
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /keys/encrypt/message:
     *   post:
     *     summary: Encrypt a plaintext message into a DID asset.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               msg:
     *                 type: string
     *                 description: The plaintext message to encrypt.
     *               receiver:
     *                 type: string
     *                 description: The DID (or name) of the intended recipient.
     *               options:
     *                 type: object
     *                 description: Additional encryption/creation parameters.
     *                 properties:
     *                   registry:
     *                     type: string
     *                     description: Where to create the asset DID (e.g., "local", "hyperswarm").
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: When this asset should expire. If omitted, it is permanent unless manually revoked.
     *                   retries:
     *                     type: integer
     *                     default: 0
     *                     description: Number of times to retry the operation if not immediately successful.
     *                   delay:
     *                     type: integer
     *                     default: 1000
     *                     description: Milliseconds to wait between retries.
     *                   encryptForSender:
     *                     type: boolean
     *                     default: true
     *                     description: Whether to include an encrypted copy for the sender.
     *                   includeHash:
     *                     type: boolean
     *                     default: false
     *                     description: Whether to embed a hash of the plaintext in the asset.
     *                   controller:
     *                     type: string
     *                     description: Which ID or DID should control this newly created asset. Defaults to the current ID.
     *     responses:
     *       200:
     *         description: The DID of the newly created encrypted asset.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *       500:
     *         description: Internal server error (encryption or wallet issue).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/keys/encrypt/message', async (req, res) => {
        try {
            const { msg, receiver, options } = req.body;
            const did = await getKeymaster().encryptMessage(msg, receiver, options);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /keys/decrypt/message:
     *   post:
     *     summary: Decrypt an encrypted message asset by DID.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               did:
     *                 type: string
     *                 description: The DID representing the encrypted asset.
     *             required:
     *               - did
     *     responses:
     *       200:
     *         description: The decrypted plaintext message.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 message:
     *                   type: string
     *                   description: The original message that was encrypted.
     *       500:
     *         description: Internal server error (e.g., no matching key found to decrypt).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/keys/decrypt/message', async (req, res) => {
        try {
            const message = await getKeymaster().decryptMessage(req.body.did);
            res.json({ message });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /keys/encrypt/json:
     *   post:
     *     summary: Encrypt a JSON object into a DID asset.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               json:
     *                 type: object
     *                 description: The JSON object to be encrypted.
     *               receiver:
     *                 type: string
     *                 description: The DID (or name) of the intended recipient.
     *               options:
     *                 type: object
     *                 description: Additional encryption/creation parameters (same fields as `/keys/encrypt/message`).
     *                 properties:
     *                   registry:
     *                     type: string
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                   retries:
     *                     type: integer
     *                     default: 0
     *                   delay:
     *                     type: integer
     *                     default: 1000
     *                   encryptForSender:
     *                     type: boolean
     *                     default: true
     *                   includeHash:
     *                     type: boolean
     *                     default: false
     *                   controller:
     *                     type: string
     *     responses:
     *       200:
     *         description: The DID of the encrypted JSON asset.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *       500:
     *         description: Internal server error (e.g., encryption or wallet issue).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/keys/encrypt/json', async (req, res) => {
        try {
            const { json, receiver, options } = req.body;
            const did = await getKeymaster().encryptJSON(json, receiver, options);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /keys/decrypt/json:
     *   post:
     *     summary: Decrypt a JSON asset by DID.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               did:
     *                 type: string
     *                 description: The DID representing the encrypted JSON asset.
     *             required:
     *               - did
     *     responses:
     *       200:
     *         description: The decrypted JSON object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 json:
     *                   type: object
     *                   description: The original JSON data that was encrypted.
     *       500:
     *         description: Internal server error (no matching key found to decrypt or other error).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/keys/decrypt/json', async (req, res) => {
        try {
            const json = await getKeymaster().decryptJSON(req.body.did);
            res.json({ json });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /keys/sign:
     *   post:
     *     summary: Add a proof to a JSON object using the current ID's keys.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               contents:
     *                 type: string
     *                 description: A JSON string representing the data to be signed.
     *             required:
     *               - contents
     *     responses:
     *       200:
     *         description: The signed object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 signed:
     *                   type: object
     *                   description: The original JSON plus a `proof` block.
     *       500:
     *         description: Internal server error (e.g., signing failure).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/keys/sign', async (req, res) => {
        try {
            const signed = await getKeymaster().addProof(JSON.parse(req.body.contents));
            res.json({ signed });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /keys/verify:
     *   post:
     *     summary: Verify a JSON object's proof.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               json:
     *                 type: object
     *                 description: The JSON object to verify, which must include a `proof` property.
     *             required:
     *               - json
     *     responses:
     *       200:
     *         description: Whether the proof is valid.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *                   description: true if the proof is valid; otherwise `false`.
     *       500:
     *         description: Internal server error (verification failure or unexpected error).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/keys/verify', async (req, res) => {
        try {
            const ok = await getKeymaster().verifyProof(req.body.json);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /schemas/{id}/template:
     *   post:
     *     summary: Generate a JSON template from a schema.
     *     description: >
     *       Creates a JSON template object based on the specified schema. The template will include placeholder values
     *       that conform to the schema's structure and constraints.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the schema from which to generate a template.
     *     responses:
     *       200:
     *         description: The generated JSON template object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 template:
     *                   type: object
     *                   description: A skeleton object containing placeholder values that conform to the schema.
     *       404:
     *         description: Schema not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating the schema was not found.
     *       500:
     *         description: Internal server error (e.g., invalid schema format or processing error).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/schemas/:id/template', async (req, res) => {
        try {
            const template = await getKeymaster().createTemplate(req.params.id);
            res.json({ template });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    return router;
}
