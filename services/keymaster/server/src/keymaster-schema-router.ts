import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createSchemaRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

    /**
     * @swagger
     * /schemas:
     *   get:
     *     summary: List all schema DIDs owned by (or associated with) a specific ID.
     *     parameters:
     *       - in: query
     *         name: owner
     *         required: false
     *         schema:
     *           type: string
     *         description: The name or DID of the owner whose schemas should be listed.
     *     responses:
     *       200:
     *         description: A list of schema DIDs.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 schemas:
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
    router.get('/schemas', async (req, res) => {
        try {
            const param = typeof req.query.owner === 'string' ? req.query.owner : undefined;
            const schemas = await getKeymaster().listSchemas(param);
            res.json({ schemas });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /schemas:
     *   post:
     *     summary: Create a new schema.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               schema:
     *                 type: object
     *                 description: A valid JSON Schema to be stored.
     *               options:
     *                 type: object
     *                 description: Additional creation parameters.
     *                 properties:
     *                   registry:
     *                     type: string
     *                     description: The registry in which to create the schema DID (e.g., "local", "hyperswarm").
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: Optional expiration date/time for ephemeral schemas.
     *     responses:
     *       200:
     *         description: The DID representing the newly created schema.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
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
    router.post('/schemas', async (req, res) => {
        try {
            const { schema, options } = req.body;
            const did = await getKeymaster().createSchema(schema, options);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /schemas/{id}:
     *   get:
     *     summary: Retrieve a stored schema.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the schema to retrieve.
     *     responses:
     *       200:
     *         description: The JSON Schema object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 schema:
     *                   type: object
     *                   description: The retrieved JSON Schema.
     *       404:
     *         description: Schema not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
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
    router.get('/schemas/:id', async (req, res) => {
        try {
            const schema = await getKeymaster().getSchema(req.params.id);
            res.json({ schema });
        } catch (error: any) {
            res.status(404).send({ error: 'Schema not found' });
        }
    });

    /**
     * @swagger
     * /schemas/{id}:
     *   put:
     *     summary: Update an existing schema.
     *     description: >
     *       Replaces the schema (if valid) associated with the given DID or name.
     *       This operation will preserve the same DID while storing an updated schema in the underlying asset data.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the schema to update.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               schema:
     *                 type: object
     *                 description: The new JSON Schema to store.
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
    router.put('/schemas/:id', async (req, res) => {
        try {
            const { schema } = req.body;
            const ok = await getKeymaster().setSchema(req.params.id, schema);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /schemas/{id}/test:
     *   post:
     *     summary: Test if a DID or name refers to a valid schema.
     *     description: >
     *       Checks whether the given DID or name refers to an asset containing a valid JSON Schema.
     *       Returns true if it's a recognized valid schema, otherwise `false`.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the schema to test.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             description: No required body parameters (reserved for future use).
     *     responses:
     *       200:
     *         description: Whether the asset is recognized as a valid schema.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 test:
     *                   type: boolean
     *                   description: true if the asset is a valid schema, otherwise `false`.
     *       400:
     *         description: Invalid DID/name or request processing error.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/schemas/:id/test', async (req, res) => {
        try {
            const test = await getKeymaster().testSchema(req.params.id);
            res.json({ test });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });


    return router;
}
