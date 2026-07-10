import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createSchemaTemplateRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

    /**
     * @swagger
     * /schemas/{id}/template:
     *   post:
     *     summary: Generate a JSON template from a schema.
     *     description: >
     *       Creates a JSON template object based on the specified schema. The template will include placeholder values
     *       that conform to the schema's structure and constraints.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the schema from which to generate a template.
     *     responses:
     *       200:
     *         description: The generated JSON template object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 template:
     *                   type: object
     *                   description: A skeleton object containing placeholder values that conform to the schema.
     *       404:
     *         description: Schema not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating the schema was not found.
     *       500:
     *         description: Internal server error (e.g., invalid schema format or processing error).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/schemas/:id/template', async (req, res) => {
        try {
            const template = await getKeymaster().createTemplate(req.params.id);
            res.json({ template });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });


    return router;
}
