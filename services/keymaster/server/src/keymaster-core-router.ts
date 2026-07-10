import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createCoreRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

    /**
     * @swagger
     * /registries:
     *   get:
     *     summary: List the available registries.
     *     responses:
     *       200:
     *         description: A list of available registry names.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 registries:
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
    router.get('/registries', async (req, res) => {
        try {
            const registries = await getKeymaster().listRegistries();
            res.json({ registries });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /wallet:
     *   get:
     *     summary: Retrieve the current wallet.
     *     responses:
     *       200:
     *         description: The wallet object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 wallet:
     *                   type: object
     *                   properties:
     *                     seed:
     *                       type: object
     *                       properties:
     *                         mnemonic:
     *                           type: string
     *                         hdkey:
     *                           type: object
     *                           properties:
     *                             xpriv:
     *                               type: string
     *                             xpub:
     *                               type: string
     *                     counter:
     *                       type: integer
     *                     ids:
     *                       type: object
     *                       additionalProperties:
     *                         type: object
     *                         properties:
     *                           did:
     *                             type: string
     *                           account:
     *                             type: integer
     *                           index:
     *                             type: integer
     *                           owned:
     *                             type: array
     *                             items:
     *                               type: string
     *                     current:
     *                       type: string
     *                     names:
     *                       type: object
     *                       additionalProperties:
     *                         type: string
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
    router.get('/wallet', async (req, res) => {
        try {
            const wallet = await getKeymaster().loadWallet();
            res.json({ wallet });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /wallet:
     *   put:
     *     summary: Save the wallet.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               wallet:
     *                 type: object
     *                 properties:
     *                   seed:
     *                     type: object
     *                     properties:
     *                       mnemonic:
     *                         type: string
     *                       hdkey:
     *                         type: object
     *                         properties:
     *                           xpriv:
     *                             type: string
     *                           xpub:
     *                             type: string
     *                   counter:
     *                     type: integer
     *                   ids:
     *                     type: object
     *                     additionalProperties:
     *                       type: object
     *                       properties:
     *                         did:
     *                           type: string
     *                         account:
     *                           type: integer
     *                         index:
     *                           type: integer
     *                         owned:
     *                           type: array
     *                           items:
     *                             type: string
     *                   current:
     *                     type: string
     *                   names:
     *                     type: object
     *                     additionalProperties:
     *                       type: string
     *             required:
     *               - wallet
     *     responses:
     *       200:
     *         description: Indicates whether the wallet was saved successfully.
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
    router.put('/wallet', async (req, res) => {
        try {
            const { wallet } = req.body;
            const ok = await getKeymaster().saveWallet(wallet);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /wallet/new:
     *   post:
     *     summary: Create a new wallet.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               mnemonic:
     *                 type: string
     *                 description: "12 words separated by a space (optional)."
     *               overwrite:
     *                 type: boolean
     *                 description: "Whether to overwrite the existing wallet."
     *                 default: false
     *     responses:
     *       200:
     *         description: The newly created wallet object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 wallet:
     *                   type: object
     *                   properties:
     *                     seed:
     *                       type: object
     *                       properties:
     *                         mnemonic:
     *                           type: string
     *                         hdkey:
     *                           type: object
     *                           properties:
     *                             xpriv:
     *                               type: string
     *                             xpub:
     *                               type: string
     *                     counter:
     *                       type: integer
     *                     ids:
     *                       type: object
     *                       additionalProperties:
     *                         type: object
     *                         properties:
     *                           did:
     *                             type: string
     *                           account:
     *                             type: integer
     *                           index:
     *                             type: integer
     *                           owned:
     *                             type: array
     *                             items:
     *                               type: string
     *                     current:
     *                       type: string
     *                     names:
     *                       type: object
     *                       additionalProperties:
     *                         type: string
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
    router.post('/wallet/new', async (req, res) => {
        try {
            const { mnemonic, overwrite } = req.body;
            const wallet = await getKeymaster().newWallet(mnemonic, overwrite);
            res.json({ wallet });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /wallet/backup:
     *   post:
     *     summary: Create a backup of the current wallet.
     *     responses:
     *       200:
     *         description: The DID of the wallet backup.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: string
     *                   description: The DID associated with the wallet backup.
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
    router.post('/wallet/backup', async (req, res) => {
        try {
            const ok = await getKeymaster().backupWallet();
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /wallet/recover:
     *   post:
     *     summary: Recover the wallet from an existing backup.
     *     responses:
     *       200:
     *         description: The recovered wallet object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 wallet:
     *                   type: object
     *                   properties:
     *                     seed:
     *                       type: object
     *                       properties:
     *                         mnemonic:
     *                           type: string
     *                         hdkey:
     *                           type: object
     *                           properties:
     *                             xpriv:
     *                               type: string
     *                             xpub:
     *                               type: string
     *                     counter:
     *                       type: integer
     *                     ids:
     *                       type: object
     *                       additionalProperties:
     *                         type: object
     *                         properties:
     *                           did:
     *                             type: string
     *                           account:
     *                             type: integer
     *                           index:
     *                             type: integer
     *                           owned:
     *                             type: array
     *                             items:
     *                               type: string
     *                     current:
     *                       type: string
     *                     names:
     *                       type: object
     *                       additionalProperties:
     *                         type: string
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
    router.post('/wallet/recover', async (req, res) => {
        try {
            const wallet = await getKeymaster().recoverWallet();
            res.json({ wallet });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /wallet/check:
     *   post:
     *     summary: Check the integrity of the wallet.
     *     responses:
     *       200:
     *         description: The check result object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 check:
     *                   type: object
     *                   properties:
     *                     checked:
     *                       type: integer
     *                       description: Number of IDs checked.
     *                     invalid:
     *                       type: integer
     *                       description: Number of IDs found invalid.
     *                     deleted:
     *                       type: integer
     *                       description: Number of IDs found deleted or deactivated.
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
    router.post('/wallet/check', async (req, res) => {
        try {
            const check = await getKeymaster().checkWallet();
            res.json({ check });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /wallet/fix:
     *   post:
     *     summary: Fix the wallet by removing invalid or deactivated entries.
     *     responses:
     *       200:
     *         description: The fix result object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 fix:
     *                   type: object
     *                   properties:
     *                     idsRemoved:
     *                       type: integer
     *                     ownedRemoved:
     *                       type: integer
     *                     heldRemoved:
     *                       type: integer
     *                     aliasesRemoved:
     *                       type: integer
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
    router.post('/wallet/fix', async (req, res) => {
        try {
            const fix = await getKeymaster().fixWallet();
            res.json({ fix });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });


    /**
     * @swagger
     * /wallet/mnemonic:
     *   get:
     *     summary: Decrypt and retrieve the wallet's mnemonic phrase.
     *     responses:
     *       200:
     *         description: The mnemonic phrase.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 mnemonic:
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
    router.get('/wallet/mnemonic', async (req, res) => {
        try {
            const mnemonic = await getKeymaster().decryptMnemonic();
            res.json({ mnemonic });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /wallet/passphrase:
     *   post:
     *     summary: Change the wallet passphrase.
     *     description: >
     *       Re-encrypts the wallet mnemonic with a new passphrase.
     *       All DIDs and derived identities are preserved.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               passphrase:
     *                 type: string
     *                 description: The new passphrase.
     *             required:
     *               - passphrase
     *     responses:
     *       200:
     *         description: Passphrase changed successfully.
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
    router.post('/wallet/passphrase', async (req, res) => {
        try {
            const { passphrase } = req.body;
            const ok = await getKeymaster().changePassphrase(passphrase);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /export/wallet/encrypted:
     *   get:
     *     summary: Export the wallet in encrypted form.
     *     description: >
     *       Returns the wallet in its encrypted format, which includes the encrypted mnemonic
     *       and encrypted wallet data. This format is secure for storage or backup purposes.
     *     responses:
     *       200:
     *         description: The encrypted wallet object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 wallet:
     *                   type: object
     *                   properties:
     *                     version:
     *                       type: integer
     *                       description: The wallet format version.
     *                     seed:
     *                       type: object
     *                       properties:
     *                         mnemonicEnc:
     *                           type: object
     *                           properties:
     *                             salt:
     *                               type: string
     *                               description: Base64-encoded salt used for key derivation.
     *                             iv:
     *                               type: string
     *                               description: Base64-encoded initialization vector for AES-GCM encryption.
     *                             data:
     *                               type: string
     *                               description: Base64-encoded encrypted mnemonic.
     *                     enc:
     *                       type: string
     *                       description: Encrypted wallet data (IDs, names, etc.).
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
    router.get('/export/wallet/encrypted', async (req, res) => {
        try {
            const wallet = await getKeymaster().exportEncryptedWallet();
            res.json({ wallet });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    return router;
}
