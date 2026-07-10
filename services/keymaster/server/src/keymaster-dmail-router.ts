import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createDmailRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster, config } = options;
    const router = express.Router();

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


    return router;
}
