import { validateGrantRequest } from './validate.js';
import type { Validity } from './validate.js';

// The link a client presents to ask a user for a grant:
// docs/plans/memeplex-reference-1436.md, "Grant request flow".
//
//   archon://grant?request=<base64url({ "memeplexGrantRequest": { … } })>
//
// The request travels in the link, so presenting it takes no network call and
// creates no DID. A wallet shows what it asks for and, if the user agrees,
// creates the grant.

export const GRANT_LINK_PREFIX = 'archon://grant?request=';

// The longest a link may be, which keeps it scannable as a QR code.
export const MAX_GRANT_LINK_LENGTH = 2048;

export type GrantLinkError =
    // Not an `archon://grant` link with a `request`.
    | 'not-a-grant-link'
    // Longer than the limit.
    | 'too-long'
    // The `request` is not unpadded base64url holding UTF-8 JSON.
    | 'undecodable'
    // The request is not a valid grant request. `validity` says how.
    | 'invalid-request';

export type GrantLink =
    | { request: Record<string, any> }
    | { error: GrantLinkError; validity?: Validity };

function toBase64url(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The text an unpadded base64url string holds, or undefined when it is not one
// or does not hold UTF-8.
function fromBase64url(encoded: string): string | undefined {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
        return undefined;
    }

    try {
        const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));

        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        return undefined;
    }
}

// The link for a grant request. Throws when the request is not a valid one or
// its link would be too long, since a client would otherwise present a link no
// wallet accepts.
export function encodeGrantLink(request: Record<string, unknown>): string {
    const validity = validateGrantRequest(request);

    if (validity !== 'valid') {
        throw new Error(`not a valid grant request: ${validity}`);
    }

    const link = GRANT_LINK_PREFIX + toBase64url(JSON.stringify({ memeplexGrantRequest: request }));

    if (link.length > MAX_GRANT_LINK_LENGTH) {
        throw new Error(`grant link is ${link.length} characters, over the limit of ${MAX_GRANT_LINK_LENGTH}`);
    }

    return link;
}

// The request a link carries, or why a wallet refuses the link.
export function decodeGrantLink(link: string): GrantLink {
    if (typeof link !== 'string' || !link.startsWith(GRANT_LINK_PREFIX)) {
        return { error: 'not-a-grant-link' };
    }
    if (link.length > MAX_GRANT_LINK_LENGTH) {
        return { error: 'too-long' };
    }

    const text = fromBase64url(link.slice(GRANT_LINK_PREFIX.length));
    let carried: unknown;

    try {
        carried = text === undefined ? undefined : JSON.parse(text);
    }
    catch {
        carried = undefined;
    }

    if (carried === undefined) {
        return { error: 'undecodable' };
    }

    const request = carried && typeof carried === 'object' && !Array.isArray(carried)
        ? (carried as Record<string, unknown>).memeplexGrantRequest
        : undefined;
    const validity = validateGrantRequest(request);

    return validity === 'valid'
        ? { request: request as Record<string, any> }
        : { error: 'invalid-request', validity };
}
