import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createAddressTailRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

    /**
     * @swagger
     * /addresses/{address}:
     *   delete:
     *     summary: Remove the stored address for the current identity and revoke it remotely.
     *     parameters:
     *       - in: path
     *         name: address
     *         required: true
     *         schema:
     *           type: string
     *         description: URL-encoded `name@domain` address to remove.
     *     responses:
     *       200:
     *         description: Indicates whether the address was successfully removed.
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
    router.delete('/addresses/:address', async (req, res) => {
        try {
            const address = decodeURIComponent(req.params.address);
            const ok = await getKeymaster().removeAddress(address);
            res.json({ ok });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });


    return router;
}
