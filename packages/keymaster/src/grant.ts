// Grants: what an identity lets a client application do in its name, and the
// request by which a client asks for one.
//
// A grant belongs to an app, which names it. A client of the app `example`
// asks by creating an asset whose data is `{ "exampleGrantRequest": { … } }`,
// and the grant is an asset of the granting identity whose data is
// `{ "exampleGrant": { … } }`. Keymaster does with a grant only what is the
// same for every app: it reads the request, checks the shape every request
// has, and creates, lists, changes and revokes the grant. What an app's actions
// mean, which registries it accepts and whether a grant is valid under its
// rules are for that app's verifier.
//
// python/keymaster/src/keymaster/grant.py is the same code for the Python port.
// Both run tests/fixtures/grant-request-vectors.json.

// What a link to a grant request begins with. The request's DID follows.
export const GRANT_LINK_PREFIX = 'archon://grant?request=';

const GRANT_REQUEST_SUFFIX = 'GrantRequest';
const GRANT_SUFFIX = 'Grant';

// The member of a request that does not have the shape every request has, or
// `request` when the request is not an object.
export type GrantRequestFault = 'request' | 'registries' | 'actions' | 'expiresAt' | 'name' | 'v';

const APP = /^[a-z][A-Za-z0-9]*$/;
const DATE_TIME = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?(Z|[+-]([0-9]{2}):([0-9]{2}))$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Whether a string is an RFC 3339 date-time on a day that exists, with `T`
// between the date and the time and `Z` or a numeric offset after it. Counted
// here, not by Date, which reads a year below 100 as one in the 1900s.
export function isDateTime(value: unknown): value is string {
    const parts = typeof value === 'string' ? DATE_TIME.exec(value) : null;

    if (!parts) {
        return false;
    }

    const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
    const [offsetHour, offsetMinute] = [Number(parts[9] ?? 0), Number(parts[10] ?? 0)];

    if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
        return false;
    }

    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

    return day >= 1 && day <= days;
}

// Whether a value is a list of at least one string, none empty and none twice.
export function isNameList(value: unknown): value is string[] {
    return Array.isArray(value) && value.length >= 1
        && value.every(name => typeof name === 'string' && name.length > 0)
        && new Set(value).size === value.length;
}

// A DID and nothing after it. A DID URL is not one: a query such as
// `?versionSequence=1` asks a node for an earlier version, which would be read
// as the request though the request has since changed or been deleted.
const BARE_DID = /^did:[a-z0-9]+:[A-Za-z0-9_.:-]+$/;

// What names a grant request: its DID or an alias for it, or a link to it with
// the white space around it removed. Empty for what begins as a DID and is not
// one alone.
export function grantRequestId(named: string): string {
    const text = named.trim();
    const id = text.startsWith(GRANT_LINK_PREFIX) ? text.slice(GRANT_LINK_PREFIX.length) : text;

    return id.startsWith('did:') && !BARE_DID.test(id) ? '' : id;
}

// The app a member of an asset's data names, given what follows the app's name
// in it, or undefined when the member names none.
function appOf(member: string, suffix: string): string | undefined {
    const app = member.endsWith(suffix) ? member.slice(0, -suffix.length) : '';

    return APP.test(app) ? app : undefined;
}

// The members of an asset's data that name an app, with what each holds.
function membersOf(data: unknown, suffix: string): { app: string; member: string; value: unknown }[] {
    if (!isObject(data)) {
        return [];
    }

    return Object.keys(data).flatMap(member => {
        const app = appOf(member, suffix);

        return app === undefined ? [] : [{ app, member, value: data[member] }];
    });
}

// The first member of a request that does not have the shape every request
// has, or undefined. A member not named here is allowed, and is the app's.
export function grantRequestFault(request: unknown): GrantRequestFault | undefined {
    if (!isObject(request)) {
        return 'request';
    }

    const { registries, actions, expiresAt, name, v } = request;

    if (!isNameList(registries)) {
        return 'registries';
    }
    if (actions !== undefined && !isNameList(actions)) {
        return 'actions';
    }
    if (expiresAt !== undefined && !isDateTime(expiresAt)) {
        return 'expiresAt';
    }
    if (name !== undefined && typeof name !== 'string') {
        return 'name';
    }
    if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v))) {
        return 'v';
    }

    return undefined;
}

// The grant request an asset's data holds, with the app it names: the one
// member named `<app>GrantRequest`. Undefined when the data holds none, or
// more than one. Whether what it holds has the shape of a request is
// grantRequestFault's to say.
export function grantRequestIn(data: unknown): { app: string; request: unknown } | undefined {
    const found = membersOf(data, GRANT_REQUEST_SUFFIX);

    return found.length === 1 ? { app: found[0].app, request: found[0].value } : undefined;
}

// The grant an asset's data holds, with the app it names: the one member named
// `<app>Grant` whose value is an object with a string `client`. Undefined when
// the data holds none, or more than one.
export function grantIn(data: unknown): { app: string; member: string; grant: Record<string, any> } | undefined {
    const found = membersOf(data, GRANT_SUFFIX)
        .filter(({ value }) => isObject(value) && typeof value.client === 'string');

    return found.length === 1
        ? { app: found[0].app, member: found[0].member, grant: found[0].value as Record<string, any> }
        : undefined;
}

// The name of the member of an asset's data that holds an app's grant.
export function grantMember(app: string): string {
    return app + GRANT_SUFFIX;
}

// A document as a node resolves it, as far as a grant or a request is read
// from it.
export interface GrantDocument {
    didDocument?: { id?: string; controller?: string };
    didDocumentData?: unknown;
    didDocumentRegistration?: { type?: string; registry?: string };
    didDocumentMetadata?: {
        deactivated?: boolean;
        versionSequence?: string | number;
        timestamp?: { chain?: string; upperBound?: { height?: unknown; timeISO?: unknown } };
    };
}

// Why a resolved document cannot be read as a grant request.
export type GrantRequestRefusal =
    // The request was deleted.
    | 'deleted'
    // The DID is not an asset.
    | 'not-an-asset'
    // The request has had a version after its first, so who asks is not
    // established.
    | 'changed'
    // The data holds no one `<app>GrantRequest`.
    | 'not-a-request'
    // What it holds does not have the shape every request has. `fault` names
    // the member.
    | 'invalid';

export type ReadGrantRequest =
    | { did: string; app: string; client: string; request: Record<string, any> }
    | { refused: GrantRequestRefusal; fault?: GrantRequestFault };

// The app, the client and the request of a grant request, from the request as a
// node resolves it.
//
// Who asks is the request's controller, and only while the request is as it was
// created. An asset's owner can transfer it to any identity, which signs
// nothing, and can replace its contents first. The creation is signed by its
// controller and holds the contents that controller gave it, so a request that
// has had any version after its first does not say who asks for what it holds.
// Nothing in the data is read for who asks.
export function grantRequestOf(doc: GrantDocument): ReadGrantRequest {
    const did = doc.didDocument?.id;
    const client = doc.didDocument?.controller;

    if (doc.didDocumentMetadata?.deactivated) {
        return { refused: 'deleted' };
    }
    if (doc.didDocumentRegistration?.type !== 'asset' || !did || !client) {
        return { refused: 'not-an-asset' };
    }
    if (Number(doc.didDocumentMetadata?.versionSequence) !== 1) {
        return { refused: 'changed' };
    }

    const held = grantRequestIn(doc.didDocumentData);

    if (!held) {
        return { refused: 'not-a-request' };
    }

    const fault = grantRequestFault(held.request);

    return fault
        ? { refused: 'invalid', fault }
        : { did, app: held.app, client, request: held.request as Record<string, any> };
}

// Whether a resolved version is anchored on a registry: it names that registry
// as its chain and has the height and time of a block. `confirmed` is not that,
// since a creation is confirmed from the start.
export function anchoredOn(doc: GrantDocument, registry: string): boolean {
    const timestamp = doc.didDocumentMetadata?.timestamp;
    const { height, timeISO } = timestamp?.upperBound ?? {};

    return timestamp?.chain === registry && Number.isSafeInteger(height) && typeof timeISO === 'string';
}
