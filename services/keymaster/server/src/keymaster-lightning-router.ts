import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createLightningRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

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
