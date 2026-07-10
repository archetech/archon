import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createDidCommRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

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


    return router;
}
