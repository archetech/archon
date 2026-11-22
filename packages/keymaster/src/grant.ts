// Memeplex grants as a Keymaster makes them: the grant link a client presents,
// and the validity of a grant and a grant request under `v: 1`.
// docs/plans/memeplex-reference-1436.md, "Grant request flow" and "Wallet";
// docs/plans/memeplex-1436.md, "One grant, one client, one chain".
//
// These are the rules of `@didcid/memeplex` (grant-link.ts, validate.ts) and of
// share/schema/memeplex/v1/grant.json and grant-request.json, written out by
// hand: that package is not published and Keymaster is, so Keymaster cannot
// depend on it. python/keymaster/src/keymaster/grant.py is the same code for
// the Python port. tests/keymaster/grant.test.ts holds this module to the
// verifier's answers, and both ports run tests/fixtures/memeplex-v1-vectors.json
// and tests/fixtures/memeplex-grant-link-vectors.json.

// The chains a grant may be created on. A grant on any other registry is void.
export const PERMITTED_GRANT_REGISTRIES = ['BTC:mainnet', 'ZEC:mainnet', 'ETH:mainnet', 'SOL:mainnet-beta'];

// The actions that permit the core kinds. A grant that lists no actions permits
// them all.
export const CORE_GRANT_ACTIONS = ['memeplex:post', 'memeplex:reply', 'memeplex:rate', 'memeplex:tag'];

export const GRANT_LINK_PREFIX = 'archon://grant?request=';

// The longest a link may be, in UTF-16 code units.
export const MAX_GRANT_LINK_LENGTH = 2048;

// 'valid', or the first thing that makes the value invalid. 'unsupported' is a
// value that states an integer `v` other than 1.
export type GrantValidity = 'valid' | 'unsupported' | 'version' | 'schema' | 'expiry-instant';

export type GrantLinkError = 'not-a-grant-link' | 'too-long' | 'undecodable' | 'invalid-request';

export type DecodedGrantLink =
    | { request: Record<string, any> }
    | { error: GrantLinkError; validity?: GrantValidity };

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const PINNED_DID_URL = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+\?versionId=b[a-z2-7]{20,}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const INSTANT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?Z$/;

// Whether a string that has the shape of an instant names a real one. Counted
// here, not by Date, which reads a year below 100 as one in the 1900s.
export function isInstant(value: string): boolean {
    const parts = INSTANT.exec(value);

    if (!parts) {
        return false;
    }

    const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);

    if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
        return false;
    }

    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

    return day >= 1 && day <= days;
}

// Whether an action is one a grant may list: a core action, or the pinned DID
// URL of an extension kind's schema.
export function isGrantAction(action: unknown): boolean {
    return typeof action === 'string' && (CORE_GRANT_ACTIONS.includes(action) || PINNED_DID_URL.test(action));
}

// The registries a grant request lists, which are those its client can publish
// on: at least one of the permitted registries, each once.
function isRegistryList(registries: unknown): boolean {
    return Array.isArray(registries) && registries.length >= 1
        && registries.every(registry => PERMITTED_GRANT_REGISTRIES.includes(registry))
        && new Set(registries).size === registries.length;
}

// The grant schema, and the grant request schema, which also requires `name`,
// `nonce` and `registries`. A field neither schema names is allowed, so
// `registries` in a grant is one of those.
function matchesSchema(value: Record<string, unknown>, request: boolean): boolean {
    const { client, name, actions, nonce, expiresAt, registries } = value;

    if (typeof client !== 'string' || !DID.test(client)) {
        return false;
    }

    if (request) {
        // A name's length is counted in code points.
        if (typeof name !== 'string' || name.length < 1 || [...name].length > 100) {
            return false;
        }
        if (nonce === undefined || !isRegistryList(registries)) {
            return false;
        }
    }

    if (actions !== undefined && (!Array.isArray(actions) || actions.length < 1 || !actions.every(isGrantAction)
        || new Set(actions).size !== actions.length)) {
        return false;
    }

    if (nonce !== undefined && (typeof nonce !== 'string' || nonce.length < 22 || !BASE64URL.test(nonce))) {
        return false;
    }

    return expiresAt === undefined || (typeof expiresAt === 'string' && INSTANT.test(expiresAt));
}

function validate(value: unknown, request: boolean): GrantValidity {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return 'schema';
    }

    const scope = value as Record<string, unknown>;

    if (!Number.isInteger(scope.v)) {
        return 'version';
    }
    if (scope.v !== 1) {
        return 'unsupported';
    }
    if (!matchesSchema(scope, request)) {
        return 'schema';
    }
    if (scope.expiresAt !== undefined && !isInstant(scope.expiresAt as string)) {
        return 'expiry-instant';
    }

    return 'valid';
}

// The validity of the `memeplexGrant` member of an asset's data.
export function validateGrant(memeplexGrant: unknown): GrantValidity {
    return validate(memeplexGrant, false);
}

// The validity of the `memeplexGrantRequest` a grant link carries.
export function validateGrantRequest(memeplexGrantRequest: unknown): GrantValidity {
    return validate(memeplexGrantRequest, true);
}

// The text an unpadded base64url string holds, or undefined when it is not one
// or does not hold UTF-8.
function fromBase64url(encoded: string): string | undefined {
    if (!BASE64URL.test(encoded) || encoded.length % 4 === 1) {
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

// The request a grant link carries, or why the link is refused.
export function decodeGrantLink(link: string): DecodedGrantLink {
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
