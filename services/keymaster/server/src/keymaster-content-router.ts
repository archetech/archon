import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createContentRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster, getGatekeeper, config } = options;
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

    /**
     * @swagger
     * /templates/poll:
     *   get:
     *     summary: Retrieve a boilerplate poll template.
     *     responses:
     *       200:
     *         description: The default poll template object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 template:
     *                   type: object
     *                   properties:
     *                     version:
     *                       type: integer
     *                     name:
     *                       type: string
     *                     description:
     *                       type: string
     *                     options:
     *                       type: array
     *                       items:
     *                         type: string
     *                     deadline:
     *                       type: string
     *                       format: date-time
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
    router.get('/templates/poll', async (req, res) => {
        try {
            const template = await getKeymaster().pollTemplate();
            res.json({ template });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls:
     *   get:
     *     summary: List polls owned by (or associated with) a given ID.
     *     parameters:
     *       - in: query
     *         name: owner
     *         required: false
     *         schema:
     *           type: string
     *         description: The name or DID of the owner ID to list polls for.
     *     responses:
     *       200:
     *         description: A list of poll DIDs.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 polls:
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
    router.get('/polls', async (req, res) => {
        try {
            const param = typeof req.query.owner === 'string' ? req.query.owner : undefined;
            const polls = await getKeymaster().listPolls(param);
            res.json({ polls });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls:
     *   post:
     *     summary: Create a new poll (backed by a vault).
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               poll:
     *                 type: object
     *                 description: The poll configuration.
     *                 properties:
     *                   version:
     *                     type: integer
     *                     default: 2
     *                     description: Must be 2.
     *                   name:
     *                     type: string
     *                     description: A short name for the poll (used as alias when imported).
     *                   description:
     *                     type: string
     *                     description: A short description or question for the poll.
     *                   options:
     *                     type: array
     *                     description: A list of possible choices for the poll (at least 2, up to 10).
     *                     minItems: 2
     *                     maxItems: 10
     *                     items:
     *                       type: string
     *                   deadline:
     *                     type: string
     *                     format: date-time
     *                     description: The date-time by which the poll closes (must be in the future).
     *                 required:
     *                   - version
     *                   - name
     *                   - description
     *                   - options
     *                   - deadline
     *               options:
     *                 type: object
     *                 description: Vault creation options.
     *                 properties:
     *                   registry:
     *                     type: string
     *                     description: Where to create the poll DID (e.g., "local", "hyperswarm").
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: Expiration timestamp for the poll DID.
     *                   controller:
     *                     type: string
     *                     description: The ID/DID that should own/control this poll. Defaults to the current ID if omitted.
     *     responses:
     *       200:
     *         description: The DID representing the newly created poll.
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
    router.post('/polls', async (req, res) => {
        try {
            const { poll, options } = req.body;
            const did = await getKeymaster().createPoll(poll, options);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls/ballot/send:
     *   post:
     *     summary: Send a ballot to the poll owner via notice.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               ballot:
     *                 type: string
     *                 description: The DID of the ballot to send.
     *               poll:
     *                 type: string
     *                 description: The DID of the poll.
     *             required:
     *               - ballot
     *               - poll
     *     responses:
     *       200:
     *         description: The DID of the notice sent to the poll owner.
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
    router.post('/polls/ballot/send', async (req, res) => {
        try {
            const { ballot, poll } = req.body;
            const did = await getKeymaster().sendBallot(ballot, poll);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls/ballot/{did}:
     *   get:
     *     summary: View ballot details.
     *     description: Returns ballot details. The poll owner can see the vote; others see only metadata.
     *     parameters:
     *       - in: path
     *         name: did
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the ballot.
     *     responses:
     *       200:
     *         description: Ballot details.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ballot:
     *                   type: object
     *                   properties:
     *                     poll:
     *                       type: string
     *                     voter:
     *                       type: string
     *                     vote:
     *                       type: integer
     *                     option:
     *                       type: string
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
    router.get('/polls/ballot/:did', async (req, res) => {
        try {
            const ballot = await getKeymaster().viewBallot(req.params.did);
            res.json({ ballot });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls/{poll}:
     *   get:
     *     summary: Retrieve the raw poll data by DID or name.
     *     parameters:
     *       - in: path
     *         name: poll
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or name of the poll to retrieve.
     *     responses:
     *       200:
     *         description: The poll object (if found).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 poll:
     *                   type: object
     *                   description: The poll config (type, version, description, options, deadline).
     *       500:
     *         description: Internal server error or poll not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.get('/polls/:poll', async (req, res) => {
        try {
            const poll = await getKeymaster().getPoll(req.params.poll);
            res.json({ poll });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls/{poll}/test:
     *   get:
     *     summary: Check if a DID or name refers to a valid poll.
     *     parameters:
     *       - in: path
     *         name: poll
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or name of the poll to test.
     *     responses:
     *       200:
     *         description: Indicates whether the asset is recognized as a valid poll.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 test:
     *                   type: boolean
     *                   description: true if valid poll, otherwise `false`.
     *       500:
     *         description: Internal server error (e.g., resolution error).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.get('/polls/:poll/test', async (req, res) => {
        try {
            const test = await getKeymaster().testPoll(req.params.poll);
            res.json({ test });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls/{poll}/view:
     *   get:
     *     summary: View detailed poll information, including results if the caller is the poll owner.
     *     parameters:
     *       - in: path
     *         name: poll
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or name of the poll to view.
     *     responses:
     *       200:
     *         description: The poll view object, including voting status and (if owner) results.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 poll:
     *                   type: object
     *                   description: Contains information about eligibility, results, etc.
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
    router.get('/polls/:poll/view', async (req, res) => {
        try {
            const poll = await getKeymaster().viewPoll(req.params.poll);
            res.json({ poll });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls/{poll}/send:
     *   post:
     *     summary: Send a poll notice to all voters.
     *     parameters:
     *       - in: path
     *         name: poll
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *       500:
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/polls/:poll/send', async (req, res) => {
        try {
            const did = await getKeymaster().sendPoll(req.params.poll);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls/{poll}/vote:
     *   post:
     *     summary: Cast a vote in a poll.
     *     description: >
     *       Casts a vote in the specified poll. The ballot is encrypted for the poll owner only.
     *     parameters:
     *       - in: path
     *         name: poll
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or name of the poll to vote in.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               vote:
     *                 type: integer
     *                 description: The numerical option index (1-based). Use 0 to cast a spoiled ballot.
     *               options:
     *                 type: object
     *                 description: Additional vote parameters.
     *                 properties:
     *                   registry:
     *                     type: string
     *                     description: Where to create the ballot DID (e.g., "local", "hyperswarm").
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: Expiration for the ballot DID.
     *             required:
     *               - vote
     *     responses:
     *       200:
     *         description: The DID representing the newly created ballot (to be sent to the poll owner).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *       500:
     *         description: Internal server error (e.g., poll not valid, or wallet issue).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/polls/:poll/vote', async (req, res) => {
        try {
            const { vote, options } = req.body;
            const did = await getKeymaster().votePoll(req.params.poll, vote, options);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls/update:
     *   put:
     *     summary: Record a received ballot in the poll.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               ballot:
     *                 type: string
     *                 description: The DID of the ballot to record in the poll.
     *             required:
     *               - ballot
     *     responses:
     *       200:
     *         description: Indicates whether the ballot was successfully recorded.
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
    router.put('/polls/update', async (req, res) => {
        try {
            const { ballot } = req.body;
            const ok = await getKeymaster().updatePoll(ballot);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls/{poll}/publish:
     *   post:
     *     summary: Publish final poll results to the poll vault.
     *     parameters:
     *       - in: path
     *         name: poll
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or name of the poll to publish.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               options:
     *                 type: object
     *                 description: Publication parameters.
     *                 properties:
     *                   reveal:
     *                     type: boolean
     *                     default: false
     *                     description: If true, includes all ballots. If false, only the summary is published.
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
     *                   description: Typically the updated poll object or success indication.
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
    router.post('/polls/:poll/publish', async (req, res) => {
        try {
            const { options } = req.body;
            const ok = await getKeymaster().publishPoll(req.params.poll, options);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls/{poll}/unpublish:
     *   post:
     *     summary: Remove previously published poll results from the poll vault.
     *     parameters:
     *       - in: path
     *         name: poll
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or name of the poll to unpublish.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             description: No additional parameters, unless needed for future expansions.
     *     responses:
     *       200:
     *         description: Indicates whether the unpublish operation was successful.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *       500:
     *         description: Internal server error or invalid poll ownership.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/polls/:poll/unpublish', async (req, res) => {
        try {
            const ok = await getKeymaster().unpublishPoll(req.params.poll);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls/{poll}/voters:
     *   post:
     *     summary: Add a voter to a poll.
     *     parameters:
     *       - in: path
     *         name: poll
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or name of the poll.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               memberId:
     *                 type: string
     *                 description: The DID of the voter to add.
     *             required:
     *               - memberId
     *     responses:
     *       200:
     *         description: Indicates whether the voter was successfully added.
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
    router.post('/polls/:poll/voters', async (req, res) => {
        try {
            const { memberId } = req.body;
            const ok = await getKeymaster().addPollVoter(req.params.poll, memberId);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls/{poll}/voters/{voter}:
     *   delete:
     *     summary: Remove a voter from a poll.
     *     parameters:
     *       - in: path
     *         name: poll
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or name of the poll.
     *       - in: path
     *         name: voter
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the voter to remove.
     *     responses:
     *       200:
     *         description: Indicates whether the voter was successfully removed.
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
    router.delete('/polls/:poll/voters/:voter', async (req, res) => {
        try {
            const ok = await getKeymaster().removePollVoter(req.params.poll, req.params.voter);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /polls/{poll}/voters:
     *   get:
     *     summary: List all voters of a poll.
     *     parameters:
     *       - in: path
     *         name: poll
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or name of the poll.
     *     responses:
     *       200:
     *         description: An object containing all voter DIDs.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 voters:
     *                   type: object
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
    router.get('/polls/:poll/voters', async (req, res) => {
        try {
            const voters = await getKeymaster().listPollVoters(req.params.poll);
            res.json({ voters });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /images:
     *   post:
     *     summary: Upload an image and create a DID for it.
     *     description: >
     *       Uploads an image as binary data and creates a DID for it. Additional options can be passed via the `X-Options` header.
     *     requestBody:
     *       required: true
     *       content:
     *         application/octet-stream:
     *           schema:
     *             type: string
     *             format: binary
     *       description: The image data to store as a DID asset.
     *     parameters:
     *       - in: header
     *         name: X-Options
     *         required: false
     *         schema:
     *           type: string
     *           description: >
     *             A JSON string containing additional options for the image creation process.
     *             Example: `{"registry":"local","validUntil":"2025-12-31T23:59:59Z"}`
     *     responses:
     *       200:
     *         description: The DID created for the uploaded image.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *                   description: The DID representing the uploaded image.
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
    router.post('/images', express.raw({ type: 'application/octet-stream', limit: config.uploadLimit }), async (req, res) => {
        try {
            const data = req.body;
            const headers = req.headers;
            const options = typeof headers['x-options'] === 'string' ? JSON.parse(headers['x-options']) : {};
            const did = await getKeymaster().createImage(data, options);

            res.json({ did });
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    /**
     * @swagger
     * /images/{id}:
     *   put:
     *     summary: Update an existing image.
     *     description: >
     *       Updates the binary data of an existing image identified by its DID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the image to update.
     *       - in: header
     *         name: X-Options
     *         required: false
     *         schema:
     *           type: string
     *         description: >
     *           A JSON string containing additional options (e.g., filename).
     *     requestBody:
     *       required: true
     *       content:
     *         application/octet-stream:
     *           schema:
     *             type: string
     *             format: binary
     *       description: The new image data to replace the existing one.
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
     *                   description: true if the update was successful, otherwise `false`.
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
    router.put('/images/:id', express.raw({ type: 'application/octet-stream', limit: config.uploadLimit }), async (req, res) => {
        try {
            const data = req.body;
            const headers = req.headers;
            const options = typeof headers['x-options'] === 'string' ? JSON.parse(headers['x-options']) : {};
            const ok = await getKeymaster().updateImage(req.params.id, data, options);

            res.json({ ok });
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    /**
     * @swagger
     * /images/{id}:
     *   get:
     *     summary: Retrieve an image by its DID.
     *     description: >
     *       Fetches the image file data and metadata associated with the specified DID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the image to retrieve.
     *     responses:
     *       200:
     *         description: Successfully retrieved the image data and metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 file:
     *                   type: object
     *                   description: The file data and metadata.
     *                   properties:
     *                     cid:
     *                       type: string
     *                       description: The Content Identifier (CID) of the image.
     *                     filename:
     *                       type: string
     *                       description: The filename of the image.
     *                     type:
     *                       type: string
     *                       description: The MIME type of the image (e.g., "image/png").
     *                     bytes:
     *                       type: integer
     *                       description: The size of the image in bytes.
     *                 image:
     *                   type: object
     *                   description: The image-specific metadata.
     *                   properties:
     *                     width:
     *                       type: integer
     *                       description: The width of the image in pixels.
     *                     height:
     *                       type: integer
     *                       description: The height of the image in pixels.
     *       404:
     *         description: Image not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating the image was not found.
     */
    router.get('/images/:id', async (req, res) => {
        try {
            const imageAsset = await getKeymaster().getImage(req.params.id);

            if (req.get('Accept') === 'application/octet-stream') {
                if (!imageAsset?.file?.data) {
                    res.status(404).send({ error: 'Image not found' });
                    return;
                }
                const { data, ...fileMeta } = imageAsset.file;
                res.set('Content-Type', 'application/octet-stream');
                res.set('X-Metadata', JSON.stringify({ file: fileMeta, image: imageAsset.image }));
                res.send(data);
            } else {
                res.json(imageAsset);
            }
        } catch (error: any) {
            res.status(404).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /images/{id}/test:
     *   post:
     *     summary: Test if the specified image is valid.
     *     description: >
     *       Checks whether the image associated with the given DID is valid or meets specific criteria.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the image to test.
     *     responses:
     *       200:
     *         description: The result of the test.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 test:
     *                   type: boolean
     *                   description: true if the image is valid, otherwise `false`.
     *       400:
     *         description: Invalid request or test criteria not met.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the test failed.
     */
    router.post('/images/:id/test', async (req, res) => {
        try {
            const test = await getKeymaster().testImage(req.params.id);
            res.json({ test });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /files:
     *   post:
     *     summary: Upload a binary file and create a DID for it.
     *     description: >
     *       Accepts binary data as the request body and creates a DID for the uploaded file. Additional options can be passed via the `X-Options` header.
     *     requestBody:
     *       required: true
     *       content:
     *         application/octet-stream:
     *           schema:
     *             type: string
     *             format: binary
     *       description: The binary file data to store as a DID asset.
     *     parameters:
     *       - in: header
     *         name: X-Options
     *         required: false
     *         schema:
     *           type: string
     *         description: >
     *           A JSON string containing additional options for the file creation process.
     *           Example: `{"registry":"local","validUntil":"2025-12-31T23:59:59Z"}`
     *     responses:
     *       200:
     *         description: The DID created for the uploaded file.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *                   description: The DID representing the uploaded file.
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
    router.post('/files', async (req, res) => {
        try {
            const options = typeof req.headers['x-options'] === 'string' ? JSON.parse(req.headers['x-options']) : {};
            if (!options.bytes && typeof req.headers['content-length'] === 'string') {
                const parsedBytes = Number.parseInt(req.headers['content-length'], 10);
                if (Number.isFinite(parsedBytes) && parsedBytes >= 0) {
                    options.bytes = parsedBytes;
                }
            }
            const did = await getKeymaster().createFileStream(req, options);

            res.json({ did });
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    /**
     * @swagger
     * /files/{id}:
     *   put:
     *     summary: Update an existing binary file.
     *     description: >
     *       Updates the binary data of an existing file identified by its DID. Additional options can be passed via the `X-Options` header.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the file to update.
     *       - in: header
     *         name: X-Options
     *         required: false
     *         schema:
     *           type: string
     *         description: >
     *           A JSON string containing additional options for the file update process.
     *           Example: `{"registry":"local","validUntil":"2025-12-31T23:59:59Z"}`
     *     requestBody:
     *       required: true
     *       content:
     *         application/octet-stream:
     *           schema:
     *             type: string
     *             format: binary
     *       description: The new binary file data to replace the existing one.
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
     *                   description: true if the update was successful, otherwise `false`.
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
    router.put('/files/:id', async (req, res) => {
        try {
            const options = typeof req.headers['x-options'] === 'string' ? JSON.parse(req.headers['x-options']) : {};
            if (!options.bytes && typeof req.headers['content-length'] === 'string') {
                const parsedBytes = Number.parseInt(req.headers['content-length'], 10);
                if (Number.isFinite(parsedBytes) && parsedBytes >= 0) {
                    options.bytes = parsedBytes;
                }
            }
            const ok = await getKeymaster().updateFileStream(req.params.id, req, options);

            res.json({ ok });
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    /**
     * @swagger
     * /files/{id}:
     *   get:
     *     summary: Retrieve a binary file by its DID.
     *     description: >
     *       Fetches the binary file data and metadata associated with the specified DID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the file to retrieve.
     *     responses:
     *       200:
     *         description: Successfully retrieved the file data and metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 file:
     *                   type: object
     *                   description: The file data and metadata.
     *                   properties:
     *                     type:
     *                       type: string
     *                       description: The MIME type of the file (e.g., "application/pdf").
     *                     bytes:
     *                       type: integer
     *                       description: The size of the file in bytes.
     *                     cid:
     *                       type: string
     *                       description: The Content Identifier (CID) of the file.
     *       404:
     *         description: File not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating the file was not found.
     */
    router.get('/files/:id', async (req, res) => {
        try {
            const file = await getKeymaster().getFile(req.params.id);

            if (req.get('Accept') === 'application/octet-stream') {
                if (!file?.data) {
                    res.status(404).send({ error: 'File not found' });
                    return;
                }
                const { data, ...fileMeta } = file;
                res.set('Content-Type', 'application/octet-stream');
                res.set('X-Metadata', JSON.stringify(fileMeta));
                res.send(data);
            } else {
                res.json({ file });
            }
        } catch (error: any) {
            res.status(404).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /files/{id}/test:
     *   post:
     *     summary: Test if the specified file is valid.
     *     description: >
     *       Checks whether the file associated with the given DID is valid or meets specific criteria.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the file to test.
     *     responses:
     *       200:
     *         description: The result of the test.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 test:
     *                   type: boolean
     *                   description: true if the file is valid, otherwise `false`.
     *       400:
     *         description: Invalid request or test criteria not met.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the test failed.
     */
    router.post('/files/:id/test', async (req, res) => {
        try {
            const test = await getKeymaster().testFile(req.params.id);
            res.json({ test });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /ipfs/data/{cid}:
     *   get:
     *     summary: Retrieve data from the IPFS
     *     parameters:
     *       - in: path
     *         name: cid
     *         required: true
     *         schema:
     *           type: string
     *         description: The CID (Content Identifier) of the data to retrieve
     *     responses:
     *       200:
     *         description: Successfully retrieved the data
     *         content:
     *           application/octet-stream:
     *             schema:
     *               type: string
     *               format: binary
     *       404:
     *         description: Data not found
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     *               example: "Not Found"
     *       500:
     *         description: Internal Server Error
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.get('/ipfs/data/:cid', async (req, res) => {
        try {
            const response = await getGatekeeper().getData(req.params.cid);
            // eslint-disable-next-line
            res.set('Content-Type', 'application/octet-stream');
            res.send(response);
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults:
     *   post:
     *     summary: Create a new vault.
     *     description: Creates a new vault asset and returns its DID.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               options:
     *                 type: object
     *                 description: Additional options for vault creation.
     *                 properties:
     *                   registry:
     *                     type: string
     *                     description: The registry in which to create the vault DID (e.g., "local", "hyperswarm").
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: Optional expiration date/time for the vault.
     *     responses:
     *       200:
     *         description: The DID of the newly created vault.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *                   description: The DID representing the vault.
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
    router.post('/vaults', async (req, res) => {
        try {
            const { options } = req.body;
            const did = await getKeymaster().createVault(options);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}:
     *   get:
     *     summary: Retrieve a vault by DID.
     *     description: Returns the vault object for the specified DID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault to retrieve.
     *     responses:
     *       200:
     *         description: The vault object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 vault:
     *                   type: object
     *                   properties:
     *                     publicJwk:
     *                       type: object
     *                       description: The public JWK for the vault.
     *                     salt:
     *                       type: string
     *                       description: The salt used for key derivation.
     *                     keys:
     *                       type: object
     *                       additionalProperties:
     *                         type: string
     *                       description: Encrypted keys for each member.
     *                     items:
     *                       type: string
     *                       description: Encrypted items index.
     *       404:
     *         description: Vault not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the vault could not be retrieved.
     */
    router.get('/vaults/:id', async (req, res) => {
        try {
            const vault = await getKeymaster().getVault(req.params.id);
            res.json({ vault });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}/test:
     *   post:
     *     summary: Test if a DID refers to a valid vault.
     *     description: Checks whether the specified DID or name refers to a valid vault asset.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or name of the vault to test.
     *     responses:
     *       200:
     *         description: Indicates whether the asset is recognized as a valid vault.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 test:
     *                   type: boolean
     *                   description: true if valid vault, otherwise false.
     *       404:
     *         description: Vault not found or invalid.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the vault could not be tested.
     */
    router.post('/vaults/:id/test', async (req, res) => {
        try {
            const test = await getKeymaster().testVault(req.params.id);
            res.json({ test });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}/members:
     *   post:
     *     summary: Add a member to a vault.
     *     description: Adds a new member to the specified vault if the caller has permission.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               memberId:
     *                 type: string
     *                 description: The DID of the member to add to the vault.
     *             required:
     *               - memberId
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
     *                   description: true if the member was added, otherwise false.
     *       404:
     *         description: Vault not found, member not found, or caller is not authorized.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the member could not be added.
     */
    router.post('/vaults/:id/members', async (req, res) => {
        try {
            const vaultId = req.params.id;
            const { memberId } = req.body;
            const ok = await getKeymaster().addVaultMember(vaultId, memberId);
            res.json({ ok });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}/members/{member}:
     *   delete:
     *     summary: Remove a member from a vault.
     *     description: Removes the specified member from the vault if the caller has permission.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault.
     *       - in: path
     *         name: member
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the member to remove from the vault.
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
     *                   description: true if the member was removed, otherwise false.
     *       404:
     *         description: Member not found, vault not found, or caller is not authorized.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the member could not be removed.
     */
    router.delete('/vaults/:id/members/:member', async (req, res) => {
        try {
            const vaultId = req.params.id;
            const memberId = req.params.member;
            const ok = await getKeymaster().removeVaultMember(vaultId, memberId);
            res.json({ ok });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}/members:
     *   get:
     *     summary: List all members of a vault. (available only to vault owner)
     *     description: Returns an object containing all member DIDs of the specified vault.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault.
     *     responses:
     *       200:
     *         description: An object containing all member DIDs and their metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 members:
     *                   type: object
     *                   additionalProperties:
     *                     type: object
     *                     description: Metadata for each member (e.g., join date).
     *       404:
     *         description: Vault not found or caller is not authorized.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the members could not be listed.
     */
    router.get('/vaults/:id/members', async (req, res) => {
        try {
            const vaultId = req.params.id;
            const members = await getKeymaster().listVaultMembers(vaultId);
            res.json({ members });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}/items:
     *   post:
     *     summary: Add an item to a vault.
     *     description: Adds a new item (binary data) to the specified vault. The item name must be provided in the X-Options header as JSON.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault.
     *       - in: header
     *         name: X-Options
     *         required: true
     *         schema:
     *           type: string
     *         description: >
     *           A JSON string containing additional options, including the item name.
     *           Example: {"name":"myfile.txt"}
     *     requestBody:
     *       required: true
     *       content:
     *         application/octet-stream:
     *           schema:
     *             type: string
     *             format: binary
     *           description: The binary data to store as an item in the vault.
     *     responses:
     *       200:
     *         description: Indicates whether the item was successfully added.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *                   description: true if the item was added, otherwise false.
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
    router.post('/vaults/:id/items', express.raw({ type: 'application/octet-stream', limit: config.uploadLimit }), async (req, res) => {
        try {
            const vaultId = req.params.id;
            const data = req.body;
            const headers = req.headers;
            const options = typeof headers['x-options'] === 'string' ? JSON.parse(headers['x-options']) : {};
            const { name } = options;
            const ok = await getKeymaster().addVaultItem(vaultId, name, data);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}/items/{name}:
     *   delete:
     *     summary: Remove an item from a vault.
     *     description: Deletes the specified item from the vault if the caller has permission.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault.
     *       - in: path
     *         name: name
     *         required: true
     *         schema:
     *           type: string
     *         description: The name of the item to remove from the vault.
     *     responses:
     *       200:
     *         description: Indicates whether the item was successfully removed.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *                   description: true if the item was removed, otherwise false.
     *       404:
     *         description: Item not found, vault not found, or caller is not a member.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the item could not be removed.
     */
    // eslint-disable-next-line
    router.delete('/vaults/:id/items/:name', async (req, res) => {
        try {
            const vaultId = req.params.id;
            const name = req.params.name;
            const ok = await getKeymaster().removeVaultItem(vaultId, name);
            res.json({ ok });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });


    /**
     * @swagger
     * /vaults/{id}/items:
     *   get:
     *     summary: List all items in a vault.
     *     description: Returns an index of all items stored in the specified vault.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault.
     *     responses:
     *       200:
     *         description: An object mapping item names to their metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 items:
     *                   type: object
     *                   additionalProperties:
     *                     type: object
     *                     description: Metadata for each item (such as CID and byte size).
     *       404:
     *         description: Vault not found or caller is not a member.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the items could not be listed.
     */
    router.get('/vaults/:id/items', async (req, res) => {
        try {
            const vaultId = req.params.id;
            const items = await getKeymaster().listVaultItems(vaultId);
            res.json({ items });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}/items/{name}:
     *   get:
     *     summary: Retrieve an item from a vault.
     *     description: Returns the binary data for a specific item stored in the vault.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault.
     *       - in: path
     *         name: name
     *         required: true
     *         schema:
     *           type: string
     *         description: The name of the item to retrieve from the vault.
     *     responses:
     *       200:
     *         description: The binary data of the requested item.
     *         content:
     *           application/octet-stream:
     *             schema:
     *               type: string
     *               format: binary
     *       404:
     *         description: Item not found or caller is not a member of the vault.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the item could not be retrieved.
     */
    router.get('/vaults/:id/items/:name', async (req, res) => {
        try {
            const vaultId = req.params.id;
            const name = req.params.name;
            const response = await getKeymaster().getVaultItem(vaultId, name);
            res.set('Content-Type', 'application/octet-stream');
            res.send(response);
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /dmail:
     *   get:
     *     summary: List all Dmail messages for the current or specified owner.
     *     description: Returns a mapping of Dmail DIDs to Dmail item objects for the current wallet or for the specified owner.
     *     parameters:
     *       - in: query
     *         name: owner
     *         required: false
     *         schema:
     *           type: string
     *         description: The name or DID of the owner whose Dmail messages should be listed.
     *     responses:
     *       200:
     *         description: A mapping of Dmail DIDs to Dmail item objects.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 dmail:
     *                   type: object
     *                   additionalProperties:
     *                     type: object
     *                   description: An object where each key is a Dmail DID, and each value is the associated Dmail item.
     *       500:
     *         description: Internal server error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.get('/dmail', async (req, res) => {
        try {
            const dmail = await getKeymaster().listDmail();
            res.json({ dmail });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /dmail:
     *   post:
     *     summary: Create a new Dmail message.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               message:
     *                 type: object
     *                 description: The Dmail message object to create.
     *                 example:
     *                   to: ["did:cid:abc123", "did:cid:def456"]
     *                   cc: ["did:cid:ghi789"]
     *                   subject: "Hello World"
     *                   body: "This is a test Dmail message."
     *               options:
     *                 type: object
     *                 description: Additional creation options (e.g., registry, validUntil).
     *     responses:
     *       200:
     *         description: The DID of the newly created Dmail message.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *                   description: The DID representing the new Dmail message.
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
    router.post('/dmail', async (req, res) => {
        try {
            const { message, options } = req.body;
            const did = await getKeymaster().createDmail(message, options);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /dmail/import:
     *   post:
     *     summary: Import a Dmail message into the inbox.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               did:
     *                 type: string
     *                 description: The DID of the Dmail message to import.
     *     responses:
     *       200:
     *         description: Indicates whether the import was successful.
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
    router.post('/dmail/import', async (req, res) => {
        try {
            const { did } = req.body;
            const ok = await getKeymaster().importDmail(did);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /dmail/{id}:
     *   get:
     *     summary: Retrieve a Dmail message by DID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the Dmail message to retrieve.
     *     responses:
     *       200:
     *         description: The Dmail message object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 message:
     *                   type: object
     *                   description: The Dmail message.
     *       404:
     *         description: Dmail not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    // eslint-disable-next-line
    router.get('/dmail/:id', async (req, res) => {
        try {
            const message = await getKeymaster().getDmailMessage(req.params.id);
            res.json({ message });
        } catch (error: any) {
            res.status(404).send({ error: 'Dmail not found' });
        }
    });

    /**
     * @swagger
     * /dmail/{id}:
     *   put:
     *     summary: Update an existing Dmail message.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the Dmail message to update.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               message:
     *                 type: object
     *                 description: The updated Dmail message object.
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
    router.put('/dmail/:id', async (req, res) => {
        try {
            const { message } = req.body;
            const ok = await getKeymaster().updateDmail(req.params.id, message);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /dmail/{id}:
     *   delete:
     *     summary: Remove a Dmail message from the mailbox.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the Dmail message to remove.
     *     responses:
     *       200:
     *         description: Indicates whether the removal was successful.
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
    router.delete('/dmail/:id', async (req, res) => {
        try {
            const ok = await getKeymaster().removeDmail(req.params.id);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /dmail/{id}/send:
     *   post:
     *     summary: Create a Notice and mark a Dmail message as sent.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the Dmail message to send.
     *     responses:
     *       200:
     *         description: The DID of the notice created for the sent Dmail message.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *                   description: The DID of the notice created for this sent Dmail.
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
    router.post('/dmail/:id/send', async (req, res) => {
        try {
            const did = await getKeymaster().sendDmail(req.params.id);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /dmail/{id}/file:
     *   post:
     *     summary: File (move) a Dmail message to a different folder by updating its tags.
     *     description: >
     *       Updates the tags of a Dmail message, allowing it to be moved between folders such as inbox, archive, or trash.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the Dmail message to file.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               tags:
     *                 type: array
     *                 items:
     *                   type: string
     *                 description: The new tags to assign to the Dmail message (e.g., ["inbox"], ["archived"], ["deleted"]).
     *             required:
     *               - tags
     *     responses:
     *       200:
     *         description: Indicates whether the filing operation was successful.
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
    router.post('/dmail/:id/file', async (req, res) => {
        try {
            const { tags } = req.body;
            const ok = await getKeymaster().fileDmail(req.params.id, tags);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /dmail/{id}/attachments:
     *   get:
     *     summary: List all attachments for a specific Dmail message.
     *     description: Returns a mapping of attachment names to their metadata for the specified Dmail DID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the Dmail message whose attachments should be listed.
     *     responses:
     *       200:
     *         description: A mapping of attachment names to their metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 attachments:
     *                   type: object
     *                   additionalProperties:
     *                     type: object
     *                   description: An object where each key is an attachment name, and each value is the associated metadata.
     *       404:
     *         description: Dmail message or attachments not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.get('/dmail/:id/attachments', async (req, res) => {
        try {
            const dmailId = req.params.id;
            const attachments = await getKeymaster().listDmailAttachments(dmailId);
            res.json({ attachments });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /dmail/{id}/attachments:
     *   post:
     *     summary: Add an attachment to a specific Dmail message.
     *     description: >
     *       Uploads a binary attachment and associates it with the specified Dmail message. The attachment name must be provided in the X-Options header as JSON.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the Dmail message to attach the file to.
     *       - in: header
     *         name: X-Options
     *         required: true
     *         schema:
     *           type: string
     *         description: >
     *           A JSON string containing additional options, including the attachment name.
     *           Example: {"name":"myfile.txt"}
     *     requestBody:
     *       required: true
     *       content:
     *         application/octet-stream:
     *           schema:
     *             type: string
     *             format: binary
     *           description: The binary data of the attachment to upload.
     *     responses:
     *       200:
     *         description: Indicates whether the attachment was successfully added.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *                   description: true if the attachment was added, otherwise false.
     *       500:
     *         description: Internal server error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.post('/dmail/:id/attachments', express.raw({ type: 'application/octet-stream', limit: config.uploadLimit }), async (req, res) => {
        try {
            const dmailId = req.params.id;
            const data = req.body;
            const headers = req.headers;
            const options = typeof headers['x-options'] === 'string' ? JSON.parse(headers['x-options']) : {};
            const { name } = options;
            const ok = await getKeymaster().addDmailAttachment(dmailId, name, data);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    /**
     * @swagger
     * /dmail/{id}/attachments/{name}:
     *   delete:
     *     summary: Remove an attachment from a specific Dmail message.
     *     description: Deletes the specified attachment from the Dmail message identified by its DID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the Dmail message.
     *       - in: path
     *         name: name
     *         required: true
     *         schema:
     *           type: string
     *         description: The name of the attachment to remove.
     *     responses:
     *       200:
     *         description: Indicates whether the attachment was successfully removed.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *                   description: true if the attachment was removed, otherwise false.
     *       404:
     *         description: Dmail message or attachment not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.delete('/dmail/:id/attachments/:name', async (req, res) => {
        try {
            const dmailId = req.params.id;
            const name = req.params.name;
            const ok = await getKeymaster().removeDmailAttachment(dmailId, name);
            res.json({ ok });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /dmail/{id}/attachments/{name}:
     *   get:
     *     summary: Download a specific attachment from a Dmail message.
     *     description: Returns the binary data for the specified attachment associated with the given Dmail DID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the Dmail message.
     *       - in: path
     *         name: name
     *         required: true
     *         schema:
     *           type: string
     *         description: The name of the attachment to download.
     *     responses:
     *       200:
     *         description: The binary data of the requested attachment.
     *         content:
     *           application/octet-stream:
     *             schema:
     *               type: string
     *               format: binary
     *       404:
     *         description: Attachment or Dmail message not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.get('/dmail/:id/attachments/:name', async (req, res) => {
        try {
            const dmailId = req.params.id;
            const name = req.params.name;
            const response = await getKeymaster().getDmailAttachment(dmailId, name);
            res.set('Content-Type', 'application/octet-stream');
            res.send(response);
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /notices:
     *   post:
     *     summary: Create a new notice asset.
     *     description: Creates a new notice asset (e.g., for Dmail delivery) and returns its DID.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               message:
     *                 type: object
     *                 description: The NoticeMessage object to create.
     *                 example:
     *                   to: ["did:cid:abc123", "did:cid:def456"]
     *                   dids: ["did:cid:dmail1", "did:cid:dmail2"]
     *               options:
     *                 type: object
     *                 description: Additional creation options (e.g., registry, validUntil).
     *     responses:
     *       200:
     *         description: The DID of the newly created notice.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *                   description: The DID representing the new notice.
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
    router.post('/notices', async (req, res) => {
        try {
            const { message, options } = req.body;
            const did = await getKeymaster().createNotice(message, options);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /notices/{id}:
     *   put:
     *     summary: Update an existing notice asset.
     *     description: Updates the NoticeMessage data for the specified notice DID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the notice to update.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               message:
     *                 type: object
     *                 description: The updated NoticeMessage object.
     *                 example:
     *                   to: ["did:cid:abc123", "did:cid:def456"]
     *                   dids: ["did:cid:dmail1", "did:cid:dmail2"]
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
    router.put('/notices/:id', async (req, res) => {
        try {
            const { message } = req.body;
            const ok = await getKeymaster().updateNotice(req.params.id, message);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /notices/refresh:
     *   post:
     *     summary: Refresh all notices.
     *     description: Refreshes the state of all notice assets, updating any that have changed.
     *     responses:
     *       200:
     *         description: Indicates whether the refresh operation was successful.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *                   description: true if the refresh was successful, otherwise false.
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
    router.post('/notices/refresh', async (req, res) => {
        try {
            const ok = await getKeymaster().refreshNotices();
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    return router;
}
