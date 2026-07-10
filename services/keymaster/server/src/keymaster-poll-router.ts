import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createPollRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

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


    return router;
}
