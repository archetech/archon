import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createKeyRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

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


    return router;
}
