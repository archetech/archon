import { validateGrantRequest } from './validate.js';
import type { Validity } from './validate.js';
import type { ResolvedVersion } from './grant.js';

// A request for a grant, and the link that presents it to a wallet:
// docs/plans/memeplex-reference-1436.md, "Grant request flow".
//
// A client asks by creating an asset whose data is
// `{ "memeplexGrantRequest": { … } }`, as a challenge is an asset, and shows a
// wallet its DID in an auth link, as a challenge's is shown:
//
//   archon://auth?grant=<DID of the request>
//
// The client is whoever created the request, which a wallet reads from the
// request as its node resolves it. Nothing in the request names the client.

export const GRANT_LINK_PREFIX = 'archon://auth?grant=';

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

// The link for a request.
export function grantLink(request: string): string {
    if (!DID.test(request)) {
        throw new Error('a grant link names the DID of a grant request');
    }

    return GRANT_LINK_PREFIX + request;
}

// The DID of the request a grant link names. A wallet also takes the DID alone.
// `undefined` for anything else.
export function parseGrantLink(link: unknown): string | undefined {
    if (typeof link !== 'string') {
        return undefined;
    }

    const text = link.trim();
    // A link built with a URL library has the DID's colons percent-encoded.
    const did = text.startsWith(GRANT_LINK_PREFIX)
        ? text.slice(GRANT_LINK_PREFIX.length).replace(/%3A/gi, ':')
        : text;

    return DID.test(did) ? did : undefined;
}

export type GrantRequestError =
    // The node resolves nothing for the DID.
    | 'not-found'
    // The request was deleted.
    | 'deactivated'
    // The DID is not an asset.
    | 'not-an-asset'
    // The request is not as its creator made it, so nothing says who is asking.
    | 'changed'
    // The data is not a valid grant request. `validity` says how.
    | 'invalid-request';

export type ReadGrantRequest =
    | { did: string; client: string; request: Record<string, any> }
    | { error: GrantRequestError; validity?: Validity };

// What a request asks for, and who asks, from the request as a node resolves it.
//
// The client is the request's controller, and only while the request is at its
// first version: that version is the one the controller signed with these
// contents. An asset's owner can replace its contents and transfer it to an
// identity that signed nothing, so a later version's controller is not
// evidence of who asked.
export function readGrantRequest(resolved: (ResolvedVersion & { didDocumentMetadata?: { versionSequence?: string | number } }) | undefined): ReadGrantRequest {
    const did = resolved?.didDocument?.id;

    if (!resolved || !did) {
        return { error: 'not-found' };
    }
    if (resolved.didDocumentMetadata?.deactivated) {
        return { error: 'deactivated' };
    }

    const client = resolved.didDocument?.controller;

    if (resolved.didDocumentRegistration?.type !== 'asset' || typeof client !== 'string' || !client) {
        return { error: 'not-an-asset' };
    }
    if (String(resolved.didDocumentMetadata?.versionSequence) !== '1') {
        return { error: 'changed' };
    }

    const data = resolved.didDocumentData;
    const request = data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>).memeplexGrantRequest
        : undefined;
    const validity = validateGrantRequest(request);

    if (validity !== 'valid') {
        return { error: 'invalid-request', validity };
    }

    return { did, client, request: request as Record<string, any> };
}
