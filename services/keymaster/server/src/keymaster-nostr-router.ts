import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createNostrRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

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


    return router;
}
