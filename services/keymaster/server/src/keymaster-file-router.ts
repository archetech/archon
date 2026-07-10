import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createFileRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster, getGatekeeper } = options;
    const router = express.Router();

    /**
     * @swagger
     * /files:
     *   post:
     *     summary: Upload a binary file and create a DID for it.
     *     description: >
     *       Accepts binary data as the request body and creates a DID for the uploaded file. Additional options can be passed via the `X-Options` header.
     *     requestBody:
     *       required: true
     *       content:
     *         application/octet-stream:
     *           schema:
     *             type: string
     *             format: binary
     *       description: The binary file data to store as a DID asset.
     *     parameters:
     *       - in: header
     *         name: X-Options
     *         required: false
     *         schema:
     *           type: string
     *         description: >
     *           A JSON string containing additional options for the file creation process.
     *           Example: `{"registry":"local","validUntil":"2025-12-31T23:59:59Z"}`
     *     responses:
     *       200:
     *         description: The DID created for the uploaded file.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *                   description: The DID representing the uploaded file.
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
    router.post('/files', async (req, res) => {
        try {
            const options = typeof req.headers['x-options'] === 'string' ? JSON.parse(req.headers['x-options']) : {};
            if (!options.bytes && typeof req.headers['content-length'] === 'string') {
                const parsedBytes = Number.parseInt(req.headers['content-length'], 10);
                if (Number.isFinite(parsedBytes) && parsedBytes >= 0) {
                    options.bytes = parsedBytes;
                }
            }
            const did = await getKeymaster().createFileStream(req, options);

            res.json({ did });
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    /**
     * @swagger
     * /files/{id}:
     *   put:
     *     summary: Update an existing binary file.
     *     description: >
     *       Updates the binary data of an existing file identified by its DID. Additional options can be passed via the `X-Options` header.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the file to update.
     *       - in: header
     *         name: X-Options
     *         required: false
     *         schema:
     *           type: string
     *         description: >
     *           A JSON string containing additional options for the file update process.
     *           Example: `{"registry":"local","validUntil":"2025-12-31T23:59:59Z"}`
     *     requestBody:
     *       required: true
     *       content:
     *         application/octet-stream:
     *           schema:
     *             type: string
     *             format: binary
     *       description: The new binary file data to replace the existing one.
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
     *                   description: true if the update was successful, otherwise `false`.
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
    router.put('/files/:id', async (req, res) => {
        try {
            const options = typeof req.headers['x-options'] === 'string' ? JSON.parse(req.headers['x-options']) : {};
            if (!options.bytes && typeof req.headers['content-length'] === 'string') {
                const parsedBytes = Number.parseInt(req.headers['content-length'], 10);
                if (Number.isFinite(parsedBytes) && parsedBytes >= 0) {
                    options.bytes = parsedBytes;
                }
            }
            const ok = await getKeymaster().updateFileStream(req.params.id, req, options);

            res.json({ ok });
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    /**
     * @swagger
     * /files/{id}:
     *   get:
     *     summary: Retrieve a binary file by its DID.
     *     description: >
     *       Fetches the binary file data and metadata associated with the specified DID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the file to retrieve.
     *     responses:
     *       200:
     *         description: Successfully retrieved the file data and metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 file:
     *                   type: object
     *                   description: The file data and metadata.
     *                   properties:
     *                     type:
     *                       type: string
     *                       description: The MIME type of the file (e.g., "application/pdf").
     *                     bytes:
     *                       type: integer
     *                       description: The size of the file in bytes.
     *                     cid:
     *                       type: string
     *                       description: The Content Identifier (CID) of the file.
     *       404:
     *         description: File not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating the file was not found.
     */
    router.get('/files/:id', async (req, res) => {
        try {
            const file = await getKeymaster().getFile(req.params.id);

            if (req.get('Accept') === 'application/octet-stream') {
                if (!file?.data) {
                    res.status(404).send({ error: 'File not found' });
                    return;
                }
                const { data, ...fileMeta } = file;
                res.set('Content-Type', 'application/octet-stream');
                res.set('X-Metadata', JSON.stringify(fileMeta));
                res.send(data);
            } else {
                res.json({ file });
            }
        } catch (error: any) {
            res.status(404).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /files/{id}/test:
     *   post:
     *     summary: Test if the specified file is valid.
     *     description: >
     *       Checks whether the file associated with the given DID is valid or meets specific criteria.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the file to test.
     *     responses:
     *       200:
     *         description: The result of the test.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 test:
     *                   type: boolean
     *                   description: true if the file is valid, otherwise `false`.
     *       400:
     *         description: Invalid request or test criteria not met.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the test failed.
     */
    router.post('/files/:id/test', async (req, res) => {
        try {
            const test = await getKeymaster().testFile(req.params.id);
            res.json({ test });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /ipfs/data/{cid}:
     *   get:
     *     summary: Retrieve data from the IPFS
     *     parameters:
     *       - in: path
     *         name: cid
     *         required: true
     *         schema:
     *           type: string
     *         description: The CID (Content Identifier) of the data to retrieve
     *     responses:
     *       200:
     *         description: Successfully retrieved the data
     *         content:
     *           application/octet-stream:
     *             schema:
     *               type: string
     *               format: binary
     *       404:
     *         description: Data not found
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     *               example: "Not Found"
     *       500:
     *         description: Internal Server Error
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.get('/ipfs/data/:cid', async (req, res) => {
        try {
            const response = await getGatekeeper().getData(req.params.cid);
            // eslint-disable-next-line
            res.set('Content-Type', 'application/octet-stream');
            res.send(response);
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });


    return router;
}
