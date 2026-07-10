import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createAddressRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

    /**
     * @swagger
     * /addresses:
     *   get:
     *     summary: List addresses stored for the current wallet.
     *     responses:
     *       200:
     *         description: A map of flattened `name@domain` addresses to metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 addresses:
     *                   type: object
     *                   additionalProperties:
     *                     type: object
     *                     properties:
     *                       added:
     *                         type: string
     *                         format: date-time
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
    router.get('/addresses', async (_req, res) => {
        try {
            const addresses = await getKeymaster().listAddresses();
            res.json({ addresses });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /addresses/{domain}:
     *   get:
     *     summary: Get the current stored address for a specific domain.
     *     parameters:
     *       - in: path
     *         name: domain
     *         required: true
     *         schema:
     *           type: string
     *         description: URL-encoded domain to look up.
     *     responses:
     *       200:
     *         description: Address record for the requested domain or null if none is stored.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 address:
     *                   nullable: true
     *                   type: object
     *                   properties:
     *                     domain:
     *                       type: string
     *                     name:
     *                       type: string
     *                     address:
     *                       type: string
     *                     added:
     *                       type: string
     *                       format: date-time
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
    router.get('/addresses/:domain', async (req, res) => {
        try {
            const domain = decodeURIComponent(req.params.domain);
            const addresses = await getKeymaster().listAddresses();
            const entry = Object.entries(addresses).find(([address]) => address.endsWith(`@${domain}`));
            const address = entry
                ? {
                    domain,
                    name: entry[0].slice(0, -(domain.length + 1)),
                    address: entry[0],
                    ...entry[1],
                }
                : null;
            res.json({ address });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /addresses/import:
     *   post:
     *     summary: Import existing addresses for the current identity from a domain registry.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               domain:
     *                 type: string
     *             required:
     *               - domain
     *     responses:
     *       200:
     *         description: Imported flattened `name@domain` addresses and metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 addresses:
     *                   type: object
     *                   additionalProperties:
     *                     type: object
     *                     properties:
     *                       added:
     *                         type: string
     *                         format: date-time
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
    router.post('/addresses/import', async (req, res) => {
        try {
            const { domain } = req.body;
            const addresses = await getKeymaster().importAddress(domain);
            res.json({ addresses });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /addresses/check/{address}:
     *   get:
     *     summary: Check whether an address is claimed, available, unsupported, or unreachable.
     *     parameters:
     *       - in: path
     *         name: address
     *         required: true
     *         schema:
     *           type: string
     *         description: URL-encoded `name@domain` address to check.
     *     responses:
     *       200:
     *         description: Address availability result.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 address:
     *                   type: string
     *                 status:
     *                   type: string
     *                   enum: [claimed, available, unsupported, unreachable]
     *                 available:
     *                   type: boolean
     *                 did:
     *                   type: string
     *                   nullable: true
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
    router.get('/addresses/check/:address', async (req, res) => {
        try {
            const address = decodeURIComponent(req.params.address);
            const result = await getKeymaster().checkAddress(address);
            res.json(result);
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /addresses:
     *   post:
     *     summary: Claim an address for the current identity.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               address:
     *                 type: string
     *             required:
     *               - address
     *     responses:
     *       200:
     *         description: Indicates whether the address was successfully claimed.
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
    router.post('/addresses', async (req, res) => {
        try {
            const { address } = req.body;
            const ok = await getKeymaster().addAddress(address);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /addresses/publish:
     *   post:
     *     summary: Publish a stored address to the current identity DID document.
     *     description: Sets `didDocumentData.address` to the selected stored address. If the stored address has a Herald relay, also publishes an `Email` DID service endpoint using `mailto:<address>`.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               address:
     *                 type: string
     *                 description: Optional `name@domain` address to publish. Required when the identity has more than one stored address.
     *               name:
     *                 type: string
     *                 description: Optional identity name. Defaults to the current identity.
     *     responses:
     *       200:
     *         description: Indicates whether the address was successfully published.
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
    router.post('/addresses/publish', async (req, res) => {
        try {
            const { address, name } = req.body || {};
            const ok = await getKeymaster().publishAddress(address, name);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /addresses/publish:
     *   delete:
     *     summary: Remove the published address from the current identity DID document.
     *     description: Removes `didDocumentData.address` and the `#email` DID service endpoint from the selected identity.
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
     *         description: Indicates whether the address was successfully unpublished.
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
    router.delete('/addresses/publish', async (req, res) => {
        try {
            const { name } = req.body || {};
            const ok = await getKeymaster().unpublishAddress(name);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    return router;
}

