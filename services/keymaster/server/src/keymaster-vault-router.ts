import express from 'express';
import type { CreateKeymasterRouterOptions } from './keymaster-router-types.js';

export function createVaultRouter(options: CreateKeymasterRouterOptions): express.Router {
    const { getKeymaster, config } = options;
    const router = express.Router();

    /**
     * @swagger
     * /vaults:
     *   post:
     *     summary: Create a new vault.
     *     description: Creates a new vault asset and returns its DID.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               options:
     *                 type: object
     *                 description: Additional options for vault creation.
     *                 properties:
     *                   registry:
     *                     type: string
     *                     description: The registry in which to create the vault DID (e.g., "local", "hyperswarm").
     *                   validUntil:
     *                     type: string
     *                     format: date-time
     *                     description: Optional expiration date/time for the vault.
     *     responses:
     *       200:
     *         description: The DID of the newly created vault.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 did:
     *                   type: string
     *                   description: The DID representing the vault.
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
    router.post('/vaults', async (req, res) => {
        try {
            const { options } = req.body;
            const did = await getKeymaster().createVault(options);
            res.json({ did });
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}:
     *   get:
     *     summary: Retrieve a vault by DID.
     *     description: Returns the vault object for the specified DID.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault to retrieve.
     *     responses:
     *       200:
     *         description: The vault object.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 vault:
     *                   type: object
     *                   properties:
     *                     publicJwk:
     *                       type: object
     *                       description: The public JWK for the vault.
     *                     salt:
     *                       type: string
     *                       description: The salt used for key derivation.
     *                     keys:
     *                       type: object
     *                       additionalProperties:
     *                         type: string
     *                       description: Encrypted keys for each member.
     *                     items:
     *                       type: string
     *                       description: Encrypted items index.
     *       404:
     *         description: Vault not found.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the vault could not be retrieved.
     */
    router.get('/vaults/:id', async (req, res) => {
        try {
            const vault = await getKeymaster().getVault(req.params.id);
            res.json({ vault });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}/test:
     *   post:
     *     summary: Test if a DID refers to a valid vault.
     *     description: Checks whether the specified DID or name refers to a valid vault asset.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID or name of the vault to test.
     *     responses:
     *       200:
     *         description: Indicates whether the asset is recognized as a valid vault.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 test:
     *                   type: boolean
     *                   description: true if valid vault, otherwise false.
     *       404:
     *         description: Vault not found or invalid.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the vault could not be tested.
     */
    router.post('/vaults/:id/test', async (req, res) => {
        try {
            const test = await getKeymaster().testVault(req.params.id);
            res.json({ test });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}/members:
     *   post:
     *     summary: Add a member to a vault.
     *     description: Adds a new member to the specified vault if the caller has permission.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               memberId:
     *                 type: string
     *                 description: The DID of the member to add to the vault.
     *             required:
     *               - memberId
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
     *                   description: true if the member was added, otherwise false.
     *       404:
     *         description: Vault not found, member not found, or caller is not authorized.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the member could not be added.
     */
    router.post('/vaults/:id/members', async (req, res) => {
        try {
            const vaultId = req.params.id;
            const { memberId } = req.body;
            const ok = await getKeymaster().addVaultMember(vaultId, memberId);
            res.json({ ok });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}/members/{member}:
     *   delete:
     *     summary: Remove a member from a vault.
     *     description: Removes the specified member from the vault if the caller has permission.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault.
     *       - in: path
     *         name: member
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the member to remove from the vault.
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
     *                   description: true if the member was removed, otherwise false.
     *       404:
     *         description: Member not found, vault not found, or caller is not authorized.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the member could not be removed.
     */
    router.delete('/vaults/:id/members/:member', async (req, res) => {
        try {
            const vaultId = req.params.id;
            const memberId = req.params.member;
            const ok = await getKeymaster().removeVaultMember(vaultId, memberId);
            res.json({ ok });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}/members:
     *   get:
     *     summary: List all members of a vault. (available only to vault owner)
     *     description: Returns an object containing all member DIDs of the specified vault.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault.
     *     responses:
     *       200:
     *         description: An object containing all member DIDs and their metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 members:
     *                   type: object
     *                   additionalProperties:
     *                     type: object
     *                     description: Metadata for each member (e.g., join date).
     *       404:
     *         description: Vault not found or caller is not authorized.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the members could not be listed.
     */
    router.get('/vaults/:id/members', async (req, res) => {
        try {
            const vaultId = req.params.id;
            const members = await getKeymaster().listVaultMembers(vaultId);
            res.json({ members });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}/items:
     *   post:
     *     summary: Add an item to a vault.
     *     description: Adds a new item (binary data) to the specified vault. The item name must be provided in the X-Options header as JSON.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault.
     *       - in: header
     *         name: X-Options
     *         required: true
     *         schema:
     *           type: string
     *         description: >
     *           A JSON string containing additional options, including the item name.
     *           Example: {"name":"myfile.txt"}
     *     requestBody:
     *       required: true
     *       content:
     *         application/octet-stream:
     *           schema:
     *             type: string
     *             format: binary
     *           description: The binary data to store as an item in the vault.
     *     responses:
     *       200:
     *         description: Indicates whether the item was successfully added.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *                   description: true if the item was added, otherwise false.
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
    router.post('/vaults/:id/items', express.raw({ type: 'application/octet-stream', limit: config.uploadLimit }), async (req, res) => {
        try {
            const vaultId = req.params.id;
            const data = req.body;
            const headers = req.headers;
            const options = typeof headers['x-options'] === 'string' ? JSON.parse(headers['x-options']) : {};
            const { name } = options;
            const ok = await getKeymaster().addVaultItem(vaultId, name, data);
            res.json({ ok });
        } catch (error: any) {
            res.status(500).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}/items/{name}:
     *   delete:
     *     summary: Remove an item from a vault.
     *     description: Deletes the specified item from the vault if the caller has permission.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault.
     *       - in: path
     *         name: name
     *         required: true
     *         schema:
     *           type: string
     *         description: The name of the item to remove from the vault.
     *     responses:
     *       200:
     *         description: Indicates whether the item was successfully removed.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ok:
     *                   type: boolean
     *                   description: true if the item was removed, otherwise false.
     *       404:
     *         description: Item not found, vault not found, or caller is not a member.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the item could not be removed.
     */
    // eslint-disable-next-line
    router.delete('/vaults/:id/items/:name', async (req, res) => {
        try {
            const vaultId = req.params.id;
            const name = req.params.name;
            const ok = await getKeymaster().removeVaultItem(vaultId, name);
            res.json({ ok });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });


    /**
     * @swagger
     * /vaults/{id}/items:
     *   get:
     *     summary: List all items in a vault.
     *     description: Returns an index of all items stored in the specified vault.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault.
     *     responses:
     *       200:
     *         description: An object mapping item names to their metadata.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 items:
     *                   type: object
     *                   additionalProperties:
     *                     type: object
     *                     description: Metadata for each item (such as CID and byte size).
     *       404:
     *         description: Vault not found or caller is not a member.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the items could not be listed.
     */
    router.get('/vaults/:id/items', async (req, res) => {
        try {
            const vaultId = req.params.id;
            const items = await getKeymaster().listVaultItems(vaultId);
            res.json({ items });
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });

    /**
     * @swagger
     * /vaults/{id}/items/{name}:
     *   get:
     *     summary: Retrieve an item from a vault.
     *     description: Returns the binary data for a specific item stored in the vault.
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID of the vault.
     *       - in: path
     *         name: name
     *         required: true
     *         schema:
     *           type: string
     *         description: The name of the item to retrieve from the vault.
     *     responses:
     *       200:
     *         description: The binary data of the requested item.
     *         content:
     *           application/octet-stream:
     *             schema:
     *               type: string
     *               format: binary
     *       404:
     *         description: Item not found or caller is not a member of the vault.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *                   description: Error message indicating why the item could not be retrieved.
     */
    router.get('/vaults/:id/items/:name', async (req, res) => {
        try {
            const vaultId = req.params.id;
            const name = req.params.name;
            const response = await getKeymaster().getVaultItem(vaultId, name);
            res.set('Content-Type', 'application/octet-stream');
            res.send(response);
        } catch (error: any) {
            res.status(404).send(error.toString());
        }
    });


    return router;
}
