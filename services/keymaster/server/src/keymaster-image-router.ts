import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createImageRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster, config } = options;
    const router = express.Router();

    /**
     * @swagger
     * /images:
     *   post:
     *     summary: Upload an image and create a DID for it.
     *     description: >
     *       Uploads an image as binary data and creates a DID for it. Additional options can be passed via the `X-Options` header.
     *     requestBody:
     *       required: true
     *       content:
     *         application/octet-stream:
     *           schema:
     *             type: string
     *             format: binary
     *       description: The image data to store as a DID asset.
     *     parameters:
     *       - in: header
     *         name: X-Options
     *         required: false
     *         schema:
     *           type: string
     *           description: >
     *             A JSON string containing additional options for the image creation process.
     *             Example: `{"registry":"local","validUntil":"2025-12-31T23:59:59Z"}`
     *     responses:
     *       200:
     *         description: The DID created for the uploaded image.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *                   description: The DID representing the uploaded image.
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
    // eslint-disable-next-line
    router.post('/images', express.raw({ type: 'application/octet-stream', limit: config.uploadLimit }), async (req, res) => {
        try {
            const data = req.body;
            const headers = req.headers;
            const options = typeof headers['x-options'] === 'string' ? JSON.parse(headers['x-options']) : {};
            const did = await getKeymaster().createImage(data, options);

            res.json({ did });
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    /**
     * @swagger
     * /images/{id}:
     *   put:
     *     summary: Update an existing image.
     *     description: >
     *       Updates the binary data of an existing image identified by its DID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the image to update.
     *       - in: header
     *         name: X-Options
     *         required: false
     *         schema:
     *           type: string
     *         description: >
     *           A JSON string containing additional options (e.g., filename).
     *     requestBody:
     *       required: true
     *       content:
     *         application/octet-stream:
     *           schema:
     *             type: string
     *             format: binary
     *       description: The new image data to replace the existing one.
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
    router.put('/images/:id', express.raw({ type: 'application/octet-stream', limit: config.uploadLimit }), async (req, res) => {
        try {
            const data = req.body;
            const headers = req.headers;
            const options = typeof headers['x-options'] === 'string' ? JSON.parse(headers['x-options']) : {};
            const ok = await getKeymaster().updateImage(req.params.id, data, options);

            res.json({ ok });
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    /**
     * @swagger
     * /images/{id}:
     *   get:
     *     summary: Retrieve an image by its DID.
     *     description: >
     *       Fetches the image file data and metadata associated with the specified DID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the image to retrieve.
     *     responses:
     *       200:
     *         description: Successfully retrieved the image data and metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 file:
     *                   type: object
     *                   description: The file data and metadata.
     *                   properties:
     *                     cid:
     *                       type: string
     *                       description: The Content Identifier (CID) of the image.
     *                     filename:
     *                       type: string
     *                       description: The filename of the image.
     *                     type:
     *                       type: string
     *                       description: The MIME type of the image (e.g., "image/png").
     *                     bytes:
     *                       type: integer
     *                       description: The size of the image in bytes.
     *                 image:
     *                   type: object
     *                   description: The image-specific metadata.
     *                   properties:
     *                     width:
     *                       type: integer
     *                       description: The width of the image in pixels.
     *                     height:
     *                       type: integer
     *                       description: The height of the image in pixels.
     *       404:
     *         description: Image not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating the image was not found.
     */
    router.get('/images/:id', async (req, res) => {
        try {
            const imageAsset = await getKeymaster().getImage(req.params.id);

            if (req.get('Accept') === 'application/octet-stream') {
                if (!imageAsset?.file?.data) {
                    res.status(404).send({ error: 'Image not found' });
                    return;
                }
                const { data, ...fileMeta } = imageAsset.file;
                res.set('Content-Type', 'application/octet-stream');
                res.set('X-Metadata', JSON.stringify({ file: fileMeta, image: imageAsset.image }));
                res.send(data);
            } else {
                res.json(imageAsset);
            }
        } catch (error: any) {
            res.status(404).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /images/{id}/test:
     *   post:
     *     summary: Test if the specified image is valid.
     *     description: >
     *       Checks whether the image associated with the given DID is valid or meets specific criteria.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the image to test.
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
     *                   description: true if the image is valid, otherwise `false`.
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
    router.post('/images/:id/test', async (req, res) => {
        try {
            const test = await getKeymaster().testImage(req.params.id);
            res.json({ test });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });


    return router;
}
