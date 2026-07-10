import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createGroupRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster } = options;
    const router = express.Router();

    /**
     * @swagger
     * /groups:
     *   get:
     *     summary: List all group DIDs owned by (or associated with) a specific ID.
     *     parameters:
     *       - in: query
     *         name: owner
     *         required: false
     *         schema:
     *           type: string
     *         description: The name or DID of the owner ID for which to list groups.
     *     responses:
     *       200:
     *         description: An array of group DIDs.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 groups:
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
    router.get('/groups', async (req, res) => {
        try {
            const param = typeof req.query.owner === 'string' ? req.query.owner : undefined;
            const groups = await getKeymaster().listGroups(param);
            res.json({ groups });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /groups:
     *   post:
     *     summary: Create a new group asset (DID).
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               name:
     *                 type: string
     *                 description: The human-readable name of the group.
     *               options:
     *                 type: object
     *                 description: Additional parameters for creating the group.
     *                 properties:
     *                   members:
     *                     type: array
     *                     items:
     *                       type: string
     *                     description: An array of member DIDs or sub-group DIDs to include initially.
     *                   registry:
     *                     type: string
     *                     description: The registry in which to create the group DID (e.g., "local", "hyperswarm").
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: Timestamp indicating when this group asset should expire (optional).
     *                   retries:
     *                     type: integer
     *                     default: 0
     *                     description: How many times to retry DID creation if immediate creation fails.
     *                   delay:
     *                     type: integer
     *                     default: 1000
     *                     description: Delay in milliseconds between retries.
     *                   encryptForSender:
     *                     type: boolean
     *                     description: Whether to include an encrypted copy for the current ID. Defaults to true if encryption is used.
     *                   includeHash:
     *                     type: boolean
     *                     description: Whether to embed a hash of the group's data in the created asset. Defaults to false.
     *                   controller:
     *                     type: string
     *                     description: An ID or DID that should be set as the controller of this new group asset. Defaults to the current ID if omitted.
     *     responses:
     *       200:
     *         description: The DID representing the newly created group.
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
    router.post('/groups', async (req, res) => {
        try {
            const { name, options } = req.body;
            const did = await getKeymaster().createGroup(name, options);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /groups/{name}:
     *   get:
     *     summary: Retrieve an existing group.
     *     description: Returns the stored group object (including its name and members) for the given group DID or name.
     *     parameters:
     *       - in: path
     *         name: name
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the group to retrieve.
     *     responses:
     *       200:
     *         description: The group object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 group:
     *                   type: object
     *                   properties:
     *                     name:
     *                       type: string
     *                     members:
     *                       type: array
     *                       items:
     *                         type: string
     *       404:
     *         description: The requested group was not found.
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
    router.get('/groups/:name', async (req, res) => {
        try {
            const group = await getKeymaster().getGroup(req.params.name);
            res.json({ group });
        } catch (error: any) {
            res.status(404).send({ error: 'Group not found' });
        }
    });

    /**
     * @swagger
     * /groups/{name}/add:
     *   post:
     *     summary: Add a member to an existing group.
     *     description: Adds a DID (or group) as a member of the specified group.
     *     parameters:
     *       - in: path
     *         name: name
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the group to update.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               member:
     *                 type: string
     *                 description: The DID (or group DID) to add as a member.
     *             required:
     *               - member
     *     responses:
     *       200:
     *         description: Indicates whether the member was successfully added.
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
    router.post('/groups/:name/add', async (req, res) => {
        try {
            const { member } = req.body;
            const ok = await getKeymaster().addGroupMember(req.params.name, member);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /groups/{name}/remove:
     *   post:
     *     summary: Remove a member from an existing group.
     *     parameters:
     *       - in: path
     *         name: name
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the group to update.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               member:
     *                 type: string
     *                 description: The DID (or group DID) to remove from the group.
     *             required:
     *               - member
     *     responses:
     *       200:
     *         description: Indicates whether the member was successfully removed.
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
    router.post('/groups/:name/remove', async (req, res) => {
        try {
            const { member } = req.body;
            const ok = await getKeymaster().removeGroupMember(req.params.name, member);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send({ error: error.toString() });
        }
    });

    /**
     * @swagger
     * /groups/{name}/test:
     *   post:
     *     summary: Test membership in a group.
     *     parameters:
     *       - in: path
     *         name: name
     *         required: true
     *         schema:
     *           type: string
     *         description: The name or DID of the group to test.
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               member:
     *                 type: string
     *                 description: The DID or group DID to check for membership.
     *     responses:
     *       200:
     *         description: The result of the membership test.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 test:
     *                   type: boolean
     *                   description: true if the member is found in the group, otherwise `false`.
     *       400:
     *         description: Invalid input or request could not be processed.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     */
    router.post('/groups/:name/test', async (req, res) => {
        try {
            const { member } = req.body;
            const test = await getKeymaster().testGroup(req.params.name, member);
            res.json({ test });
        } catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });


    return router;
}
