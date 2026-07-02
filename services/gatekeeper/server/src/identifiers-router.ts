import express from 'express';
import type { Logger } from 'pino';
import type Gatekeeper from '@didcid/gatekeeper';
import { ResolveDIDOptions, DidCidDocument } from '@didcid/gatekeeper/types';
import { InvalidOperationError } from '@didcid/common/errors';

// Classify an error thrown during conformant resolution/dereferencing. A validation failure
// in the DID's own operation chain (e.g. a bad proof surfaced by verify) is a property of the
// DID, not a server fault, so it resolves to a 4xx "notFound"; anything else is an internal
// error. resolveConformant() already handles the expected invalidDid/notFound cases, so this
// only ever sees thrown exceptions.
function classifyResolveError(error: unknown): { status: number; resolutionError: string } {
    if (error instanceof InvalidOperationError) {
        return { status: 404, resolutionError: 'notFound' };
    }
    return { status: 500, resolutionError: 'internalError' };
}

/**
 * Build the standards-conformant DID resolution / dereferencing router, mounted at
 * `/1.0/identifiers` following the Universal Resolver driver convention. Extracted into a
 * factory (taking the Gatekeeper instance + a logger) so the surface can be exercised over
 * HTTP with an in-memory Gatekeeper, without booting the full service.
 */
export function createIdentifiersRouter(
    gatekeeper: Gatekeeper,
    logger: Pick<Logger, 'error'>
): express.Router {
    const identifiersRouter = express.Router();

    // Shared resolution for the conformant /1.0/identifiers surface.
    //
    // confirm/verify are not DID Core parameters, so they are not exposed here; the surface
    // always returns confirmed, cryptographically verified state (callers needing raw or
    // unconfirmed state use the internal /api/v1/did/:did endpoint). Only the standard version
    // selectors are honored. Returns the resolved document, or an HTTP status + resolution
    // metadata carrying the error.
    async function resolveConformant(
        req: express.Request
    ): Promise<{ ok: true; doc: DidCidDocument } | { ok: false; status: number; didResolutionMetadata: any }> {
        const options: ResolveDIDOptions = { confirm: true, verify: true };
        const { versionTime, versionSequence } = req.query;

        if (typeof versionTime === 'string') {
            options.versionTime = versionTime;
        }

        if (typeof versionSequence === 'string') {
            const parsed = parseInt(versionSequence, 10);
            if (!isNaN(parsed)) {
                options.versionSequence = parsed;
            }
        }

        const doc = await gatekeeper.resolveDID(req.params.did, options);

        if (doc.didResolutionMetadata?.error) {
            const status = doc.didResolutionMetadata.error === 'invalidDid' ? 400 : 404;
            return { ok: false, status, didResolutionMetadata: doc.didResolutionMetadata };
        }

        return { ok: true, doc };
    }

    /**
     * @swagger
     * /1.0/identifiers/{did}:
     *   get:
     *     summary: Resolve a DID (standards-conformant)
     *     description: >
     *       Resolves a DID following the DID Resolution data model, returning only the standard
     *       result triple (`didDocument`, `didResolutionMetadata`, `didDocumentMetadata`). Follows
     *       the Universal Resolver driver convention. The method-specific `didDocumentData` and
     *       `didDocumentRegistration` objects are NOT part of this result — they are exposed as
     *       dereferenceable resources at `/1.0/identifiers/{did}/data` and
     *       `/1.0/identifiers/{did}/registration`. Always returns confirmed, cryptographically
     *       verified state; the internal `/api/v1/did/{did}` endpoint remains available for raw or
     *       unconfirmed state.
     *     parameters:
     *       - in: path
     *         name: did
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID to resolve.
     *       - in: query
     *         name: versionTime
     *         required: false
     *         schema:
     *           type: string
     *           format: date-time
     *         description: Resolve the state of the DID as of this specific time.
     *       - in: query
     *         name: versionSequence
     *         required: false
     *         schema:
     *           type: integer
     *         description: Resolve a specific version of the DID Document.
     *     responses:
     *       200:
     *         description: The DID Resolution result (standard triple).
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 didDocument:
     *                   type: object
     *                 didResolutionMetadata:
     *                   type: object
     *                 didDocumentMetadata:
     *                   type: object
     *       400:
     *         description: The DID is syntactically invalid (error in didResolutionMetadata).
     *       404:
     *         description: The DID does not exist or cannot be resolved (error in didResolutionMetadata).
     *       500:
     *         description: Internal Server Error.
     */
    identifiersRouter.get('/:did', async (req, res) => {
        try {
            const result = await resolveConformant(req);

            if (!result.ok) {
                // DID Resolution: errors are reported in didResolutionMetadata.
                res.status(result.status).json({
                    didDocument: null,
                    didResolutionMetadata: result.didResolutionMetadata,
                    didDocumentMetadata: {},
                });
                return;
            }

            // Conformant result: only the standard triple. The method-specific data and
            // registration objects are dereferenced via their own resource paths.
            const { didDocument, didResolutionMetadata, didDocumentMetadata } = result.doc;
            res.json({ didDocument, didResolutionMetadata, didDocumentMetadata });
        } catch (error: any) {
            const { status, resolutionError } = classifyResolveError(error);
            if (status >= 500) {
                logger.error({ did: req.params.did, error }, 'DID resolution failed');
            }
            // Errors are reported in didResolutionMetadata, keeping the result triple-shaped.
            res.status(status).json({
                didDocument: null,
                didResolutionMetadata: { error: resolutionError },
                didDocumentMetadata: {},
            });
        }
    });

    /**
     * @swagger
     * /1.0/identifiers/{did}/data:
     *   get:
     *     summary: Dereference the data resource of a DID
     *     description: >
     *       Dereferences the data resource associated with a DID, per the did:cid method-specific
     *       DID URL dereferencing rules (the DID URL `did:cid:<cid>/data`). Because the DID is
     *       content-addressed, the resource is retrieved by content rather than by an external
     *       location. This is distinct from DID resolution (`/1.0/identifiers/{did}`): it returns
     *       the associated data resource itself, not the DID Document + metadata triple. Agent DIDs
     *       return an empty object; asset DIDs return their attached data.
     *     parameters:
     *       - in: path
     *         name: did
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID whose data resource is dereferenced.
     *       - in: query
     *         name: versionTime
     *         required: false
     *         schema:
     *           type: string
     *           format: date-time
     *         description: Dereference the data as of this specific time.
     *       - in: query
     *         name: versionSequence
     *         required: false
     *         schema:
     *           type: integer
     *         description: Dereference the data at a specific version of the DID Document.
     *     responses:
     *       200:
     *         description: The dereferenced data resource.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               description: Arbitrary data attached to the DID (empty object for agent DIDs).
     *       400:
     *         description: The DID is syntactically invalid.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *       404:
     *         description: The DID does not exist or cannot be resolved.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *       500:
     *         description: Internal Server Error.
     */
    identifiersRouter.get('/:did/data', async (req, res) => {
        try {
            const result = await resolveConformant(req);

            if (!result.ok) {
                res.status(result.status).json({ error: result.didResolutionMetadata.error });
                return;
            }

            // Dereference the method-specific data resource (did:cid:<cid>/data).
            // Not part of the DID resolution result — returned as the resource itself.
            res.json(result.doc.didDocumentData ?? {});
        } catch (error: any) {
            const { status, resolutionError } = classifyResolveError(error);
            if (status >= 500) {
                logger.error({ did: req.params.did, error }, 'DID dereferencing failed');
            }
            res.status(status).json({ error: resolutionError });
        }
    });

    /**
     * @swagger
     * /1.0/identifiers/{did}/registration:
     *   get:
     *     summary: Dereference the registration resource of a DID
     *     description: >
     *       Dereferences the method-specific registration/anchoring resource associated with a DID
     *       (the DID URL `did:cid:<cid>/registration`). This is provenance about how and where the
     *       DID was registered and anchored — it is NOT DID Core metadata and NOT part of the DID
     *       resolution result. Standard document metadata (created, versionId, deactivated, etc.)
     *       remains in `didDocumentMetadata` on the resolution result.
     *     parameters:
     *       - in: path
     *         name: did
     *         required: true
     *         schema:
     *           type: string
     *         description: The DID whose registration resource is dereferenced.
     *       - in: query
     *         name: versionTime
     *         required: false
     *         schema:
     *           type: string
     *           format: date-time
     *         description: Dereference the registration as of this specific time.
     *       - in: query
     *         name: versionSequence
     *         required: false
     *         schema:
     *           type: integer
     *         description: Dereference the registration at a specific version of the DID Document.
     *     responses:
     *       200:
     *         description: The dereferenced registration resource.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               description: Method-specific anchoring/provenance data.
     *       400:
     *         description: The DID is syntactically invalid.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *       404:
     *         description: The DID does not exist or cannot be resolved.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error:
     *                   type: string
     *       500:
     *         description: Internal Server Error.
     */
    identifiersRouter.get('/:did/registration', async (req, res) => {
        try {
            const result = await resolveConformant(req);

            if (!result.ok) {
                res.status(result.status).json({ error: result.didResolutionMetadata.error });
                return;
            }

            // Dereference the method-specific registration resource (did:cid:<cid>/registration).
            // Not part of the DID resolution result — returned as the resource itself.
            res.json(result.doc.didDocumentRegistration ?? {});
        } catch (error: any) {
            const { status, resolutionError } = classifyResolveError(error);
            if (status >= 500) {
                logger.error({ did: req.params.did, error }, 'DID dereferencing failed');
            }
            res.status(status).json({ error: resolutionError });
        }
    });

    // Any other path under /1.0/identifiers is not a supported DID URL resource for this method.
    // Return a structured JSON 404 (not Express's default HTML) so the conformant surface stays
    // consistent and matches the Rust implementation.
    identifiersRouter.use((req, res) => {
        res.status(404).json({ error: 'notFound' });
    });

    return identifiersRouter;
}
