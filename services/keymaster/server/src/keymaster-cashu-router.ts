import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';
import { sendError } from './keymaster-error-status.js';

export function createCashuRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

    // Express 5 leaves the body undefined on a request without one, and every
    // field of most of these routes is optional.
    router.use('/cashu', (req, _res, next) => {
        req.body ??= {};
        next();
    });

    /**
     * @swagger
     * /cashu:
     *   post:
     *     summary: Enable Cashu on the node mint for an identity.
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
     *         description: The mint as added.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu', async (req, res) => {
        try {
            const { id } = req.body;
            const info = await getKeymaster().addCashu(id);
            res.json(info);
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu:
     *   delete:
     *     summary: Remove every Cashu mint from an identity.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               force:
     *                 type: boolean
     *                 description: Discard proofs and open operations.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: Success.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.delete('/cashu', async (req, res) => {
        try {
            const { force, id } = req.body;
            const ok = await getKeymaster().removeCashu(force, id);
            res.json({ ok });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/mints:
     *   post:
     *     summary: Add an outside Cashu mint to an identity.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [url]
     *             properties:
     *               url:
     *                 type: string
     *                 description: The mint URL.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: The mint as added.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/mints', async (req, res) => {
        try {
            const { url, id } = req.body;
            const info = await getKeymaster().addCashuMint(url, id);
            res.json(info);
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/mints:
     *   delete:
     *     summary: Remove one Cashu mint from an identity.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [url]
     *             properties:
     *               url:
     *                 type: string
     *                 description: The mint URL.
     *               force:
     *                 type: boolean
     *                 description: Discard proofs and open operations.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: Success.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.delete('/cashu/mints', async (req, res) => {
        try {
            const { url, force, id } = req.body;
            const ok = await getKeymaster().removeCashuMint(url, force, id);
            res.json({ ok });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/mints/list:
     *   post:
     *     summary: List an identity's Cashu mints with their NUT-06 info.
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
     *         description: The mints.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/mints/list', async (req, res) => {
        try {
            const { id } = req.body;
            const mints = await getKeymaster().listCashuMints(id);
            res.json({ mints });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/publish:
     *   post:
     *     summary: Add the #cashu service listing the identity's mints to its DID document.
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
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/publish', async (req, res) => {
        try {
            const { id } = req.body;
            const ok = await getKeymaster().publishCashu(id);
            res.json({ ok });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/unpublish:
     *   post:
     *     summary: Remove the #cashu service from the DID document.
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
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/unpublish', async (req, res) => {
        try {
            const { id } = req.body;
            const ok = await getKeymaster().unpublishCashu(id);
            res.json({ ok });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/balance:
     *   post:
     *     summary: Spendable, in-flight and outstanding ecash, without contacting a mint.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               mint:
     *                 type: string
     *                 description: Mint URL.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: The balance, with a per-mint breakdown when totalled across several.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/balance', async (req, res) => {
        try {
            const { mint, id } = req.body;
            const balance = await getKeymaster().getCashuBalance(mint, id);
            res.json(balance);
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/quote:
     *   post:
     *     summary: Create a NUT-04 mint quote.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [amount]
     *             properties:
     *               amount:
     *                 type: integer
     *                 description: Amount in sats.
     *               mint:
     *                 type: string
     *                 description: Mint URL.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: The quote and the BOLT11 invoice to pay.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/quote', async (req, res) => {
        try {
            const { amount, mint, id } = req.body;
            const quote = await getKeymaster().createCashuMintQuote(amount, mint, id);
            res.json(quote);
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/claim:
     *   post:
     *     summary: Mint the proofs of a paid quote.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [quote]
     *             properties:
     *               quote:
     *                 type: string
     *                 description: The quote id.
     *               mint:
     *                 type: string
     *                 description: Mint URL.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: The amount minted.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/claim', async (req, res) => {
        try {
            const { quote, mint, id } = req.body;
            const result = await getKeymaster().claimCashuMintQuote(quote, mint, id);
            res.json(result);
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/quotes:
     *   post:
     *     summary: List open mint and melt quotes from the journal.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               mint:
     *                 type: string
     *                 description: Mint URL.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: The open quotes.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/quotes', async (req, res) => {
        try {
            const { mint, id } = req.body;
            const quotes = await getKeymaster().listCashuQuotes(mint, id);
            res.json({ quotes });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/melt:
     *   post:
     *     summary: Pay a BOLT11 invoice from proofs (NUT-05), keeping the change.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [bolt11]
     *             properties:
     *               bolt11:
     *                 type: string
     *                 description: The invoice.
     *               mint:
     *                 type: string
     *                 description: Mint URL.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: The payment result.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/melt', async (req, res) => {
        try {
            const { bolt11, mint, id } = req.body;
            const result = await getKeymaster().meltCashu(bolt11, mint, id);
            res.json(result);
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/send:
     *   post:
     *     summary: Create a token the recipient redeems for at least the amount.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [amount]
     *             properties:
     *               amount:
     *                 type: integer
     *                 description: Amount in sats the recipient should net.
     *               mint:
     *                 type: string
     *                 description: Mint URL.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: The token.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/send', async (req, res) => {
        try {
            const { amount, mint, id } = req.body;
            const result = await getKeymaster().sendCashu(amount, mint, id);
            res.json(result);
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/receive:
     *   post:
     *     summary: Redeem a token at its mint, which the identity must have added.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [token]
     *             properties:
     *               token:
     *                 type: string
     *                 description: A cashuA or cashuB token.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: The amount received.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/receive', async (req, res) => {
        try {
            const { token, id } = req.body;
            const result = await getKeymaster().receiveCashu(token, id);
            res.json(result);
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/check:
     *   post:
     *     summary: Settle an identity's open Cashu operations.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               mint:
     *                 type: string
     *                 description: Mint URL.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: Counts of records settled and still open, and the value of any spent proofs dropped or proofs moved off inactive keysets.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/check', async (req, res) => {
        try {
            const { mint, id } = req.body;
            const result = await getKeymaster().checkCashu(mint, id);
            res.json(result);
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/restore:
     *   post:
     *     summary: Recover proofs from the mnemonic (NUT-09).
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               mint:
     *                 type: string
     *                 description: Mint URL.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: The proofs recovered and their value.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/restore', async (req, res) => {
        try {
            const { mint, id } = req.body;
            const result = await getKeymaster().restoreCashu(mint, id);
            res.json(result);
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/sends:
     *   post:
     *     summary: List sent tokens not yet redeemed.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               mint:
     *                 type: string
     *                 description: Mint URL.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: The outstanding sends.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/sends', async (req, res) => {
        try {
            const { mint, id } = req.body;
            const sends = await getKeymaster().listCashuSends(mint, id);
            res.json({ sends });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/reclaim:
     *   post:
     *     summary: Take back one unredeemed send.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [operationId]
     *             properties:
     *               operationId:
     *                 type: string
     *                 description: The operation id from the list of sends.
     *               id:
     *                 type: string
     *                 description: Optional identity name or DID.
     *     responses:
     *       200:
     *         description: The amount reclaimed, and what the recipient had redeemed if that was only part of the token.
     *       400:
     *         description: Invalid request, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/reclaim', async (req, res) => {
        try {
            const { operationId, id } = req.body;
            const result = await getKeymaster().reclaimCashu(operationId, id);
            res.json(result);
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/send-to:
     *   post:
     *     summary: Send ecash locked to a DID's key, over DIDComm.
     *     description: >
     *       Locks the value to the recipient's key with NUT-11 and delivers the token as a
     *       DIDComm message. A delivery that fails is retried by the identity's next check,
     *       and the result's `delivered` says which happened. The sender can reclaim the
     *       value after the locktime.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [recipient, amount]
     *             properties:
     *               recipient:
     *                 type: string
     *                 description: The recipient's DID or alias.
     *               amount:
     *                 type: integer
     *                 description: The least the recipient nets, in sats.
     *               memo:
     *                 type: string
     *               locktime:
     *                 type: integer
     *                 description: Seconds until the sender can reclaim, at most seven days. Three days by default.
     *               mint:
     *                 type: string
     *                 description: The mint to use. By default, one the recipient publishes and the sender uses.
     *               id:
     *                 type: string
     *                 description: The sending identity. Defaults to the current one.
     *     responses:
     *       200:
     *         description: The token, its operation id, and whether it was delivered.
     *       400:
     *         description: Invalid request, no mint both sides use, no DIDComm route, or the mint refused it.
     *       503:
     *         description: The mint is unavailable.
     */
    router.post('/cashu/send-to', async (req, res) => {
        try {
            const { recipient, amount, memo, locktime, mint, id } = req.body;
            const result = await getKeymaster().sendCashuTo(recipient, amount, { memo, locktime, mint, name: id });
            res.json(result);
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/messages:
     *   post:
     *     summary: List token messages waiting in the DIDComm inbox.
     *     description: Contacts no mint and redeems nothing.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               id:
     *                 type: string
     *                 description: The identity. Defaults to the current one.
     *     responses:
     *       200:
     *         description: The messages, each with whether it can be redeemed and why not.
     *       400:
     *         description: Invalid request.
     */
    router.post('/cashu/messages', async (req, res) => {
        try {
            const messages = await getKeymaster().listCashuMessages(req.body.id);
            res.json({ messages });
        } catch (error: any) {
            sendError(res, error);
        }
    });

    /**
     * @swagger
     * /cashu/accept:
     *   post:
     *     summary: Redeem the token messages in the DIDComm inbox.
     *     description: >
     *       A message that cannot be redeemed stays in the inbox and is reported with the
     *       reason, unless its token is already spent.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               id:
     *                 type: string
     *                 description: The identity. Defaults to the current one.
     *     responses:
     *       200:
     *         description: What was redeemed, and what was not.
     *       400:
     *         description: Invalid request.
     */
    router.post('/cashu/accept', async (req, res) => {
        try {
            const result = await getKeymaster().receiveCashuMessages(req.body.id);
            res.json(result);
        } catch (error: any) {
            sendError(res, error);
        }
    });

    return router;
}
