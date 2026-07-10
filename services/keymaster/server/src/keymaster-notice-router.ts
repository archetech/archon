import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createNoticeRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

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
