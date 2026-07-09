import express from 'express';
import type { CreateV1RouterOptions } from './v1-router-types.js';

export function createIpfsRouter(options: CreateV1RouterOptions): express.Router {
    const { gatekeeper, config } = options;
    const router = express.Router();

    /**
     * @swagger
     * /ipfs/json:
     *   post:
     *     summary: Adds a JSON object to the IPFS
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *       description: The JSON object to store in IPFS
     *
     *     responses:
     *       200:
     *         description: >
     *           A CID (Content Identifier) for the added JSON object in standard CID v1 base32 format
     *         content:
     *           text/plain:
     *             schema:
     *               type: string
     *               example: z3v8AuahvBGDMXvCTWedYbxnH6C9ZrsEtEJAvip2XPzcZb8yo6A
     *
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.post('/ipfs/json', async (req, res) => {
        try {
            const response = await gatekeeper.addJSON(req.body);
            res.send(response);
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /ipfs/json/{cid}:
     *   get:
     *     summary: Retrieve a JSON object from the IPFS
     *     parameters:
     *       - in: path
     *         name: cid
     *         required: true
     *         schema:
     *           type: string
     *         description: The CID (Content Identifier) of the JSON object to retrieve
     *     responses:
     *       200:
     *         description: Successfully retrieved the JSON object
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *       404:
     *         description: JSON object not found
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
    router.get('/ipfs/json/:cid', async (req, res) => {
        try {
            const response = await gatekeeper.getJSON(req.params.cid);
            res.json(response);
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /ipfs/text:
     *   post:
     *     summary: Adds text to the IPFS
     *     requestBody:
     *       required: true
     *       content:
     *         text/plain:
     *           schema:
     *             type: string
     *       description: The text to store in IPFS
     *
     *     responses:
     *       200:
     *         description: >
     *           A CID (Content Identifier) for the added text in standard CID v1 base32 format
     *         content:
     *           text/plain:
     *             schema:
     *               type: string
     *               example: zb2rhoVn27TzH1yQD1Bux7XKxaUBp3Rwzvd8Re9Shp4bEGokf
     *
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.post('/ipfs/text', express.text({ type: 'text/plain', limit: config.uploadLimit }), async (req, res) => {
        try {
            const response = await gatekeeper.addText(req.body);
            res.send(response);
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /ipfs/text/{cid}:
     *   get:
     *     summary: Retrieve text from the IPFS
     *     parameters:
     *       - in: path
     *         name: cid
     *         required: true
     *         schema:
     *           type: string
     *         description: The CID (Content Identifier) of the text to retrieve
     *     responses:
     *       200:
     *         description: Successfully retrieved the text
     *         content:
     *           text/plain:
     *             schema:
     *               type: string
     *       404:
     *         description: Text not found
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
    router.get('/ipfs/text/:cid', async (req, res) => {
        try {
            const response = await gatekeeper.getText(req.params.cid);
            res.send(response);
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /ipfs/data:
     *   post:
     *     summary: Adds an octet-stream to the IPFS
     *     requestBody:
     *       required: true
     *       content:
     *         application/octet-stream:
     *           schema:
     *             type: string
     *             format: binary
     *       description: The data to store in IPFS
     *
     *     responses:
     *       200:
     *         description: >
     *           A CID (Content Identifier) for the added data in standard CID v1 base32 format
     *         content:
     *           text/plain:
     *             schema:
     *               type: string
     *               example: zdj7WnZAJEYaTTvvDRXCfDpN8raDkX63VrrZBTpV5fw4cVciw
     *
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.post('/ipfs/data', express.raw({ type: 'application/octet-stream', limit: config.uploadLimit }), async (req, res) => {
        try {
            const data = req.body;
            const response = await gatekeeper.addData(data);
            res.send(response);
        } catch (error: any) {
            res.status(500).send(error.toString());
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
            const response = await gatekeeper.getData(req.params.cid);
            res.set('Content-Type', 'application/octet-stream');
            res.send(response);
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /ipfs/stream:
     *   post:
     *     summary: Add streamed binary data to IPFS
     *     requestBody:
     *       required: true
     *       content:
     *         application/octet-stream:
     *           schema:
     *             type: string
     *             format: binary
     *       description: A streaming request body to store in IPFS.
     *     responses:
     *       200:
     *         description: A CID for the added streamed data.
     *         content:
     *           text/plain:
     *             schema:
     *               type: string
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.post('/ipfs/stream', async (req, res) => {
        try {
            const cid = await gatekeeper.addDataStream(req);
            res.send(cid);
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });
    
    /**
     * @swagger
     * /ipfs/stream/{cid}:
     *   get:
     *     summary: Retrieve streamed data from IPFS
     *     parameters:
     *       - in: path
     *         name: cid
     *         required: true
     *         schema:
     *           type: string
     *         description: The CID of the streamed data to retrieve.
     *       - in: query
     *         name: type
     *         required: false
     *         schema:
     *           type: string
     *           default: application/octet-stream
     *         description: Optional response content type.
     *       - in: query
     *         name: filename
     *         required: false
     *         schema:
     *           type: string
     *         description: Optional download filename for the Content-Disposition header.
     *     responses:
     *       200:
     *         description: The streamed data.
     *         content:
     *           application/octet-stream:
     *             schema:
     *               type: string
     *               format: binary
     *       500:
     *         description: Internal Server Error.
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     */
    router.get('/ipfs/stream/:cid', async (req, res) => {
        try {
            const contentType = (req.query.type as string) || 'application/octet-stream';
            const filename = req.query.filename as string;
            if (filename) {
                res.attachment(filename);
            }
            res.setHeader('Content-Type', contentType);
            for await (const chunk of gatekeeper.getDataStream(req.params.cid)) {
                res.write(chunk);
            }
            res.end();
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    return router;
}
