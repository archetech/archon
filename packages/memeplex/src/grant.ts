import { equal } from './runtime.js';
import { validateGrant } from './validate.js';
import type { Kind } from './validate.js';

// A grant and the interval of chain positions over which it confers authority,
// read from the versions of the grant's DID as a Gatekeeper resolves them. The
// rules are those of docs/plans/memeplex-1436.md, "One grant, one client, one
// chain" and "Authority is an interval".
//
// What each version of a DID is, and where it was anchored, is the Gatekeeper's
// to say.

// The chains a grant may be created on. Adding one is a protocol revision.
export const PERMITTED_REGISTRIES = ['BTC:mainnet', 'ZEC:mainnet', 'ETH:mainnet', 'SOL:mainnet-beta'] as const;

// One version of a DID, as `POST /api/v1/dids/versions` returns it: the document,
// data and registration as of that version, and its metadata.
export interface ResolvedVersion {
    didDocument?: { id?: string; controller?: string };
    didDocumentData?: unknown;
    didDocumentRegistration?: { type?: string; registry?: string; validUntil?: string };
    didDocumentMetadata?: {
        // The canonical CID of the operation that made the version.
        versionId?: string;
        // Set on the version that deletes the DID.
        deactivated?: boolean;
        // The blocks that bound the version on `chain`. `upperBound` is the block
        // that anchored it.
        timestamp?: { chain?: string; upperBound?: { height?: number; timeISO?: string } };
    };
}

// Where a version sits on the grant's registry: the block that anchors it, and
// that block's time. Two positions in one block are unordered.
export interface Position {
    block: number;
    time: string;
}

// The scope in force from a position: the grant's creation, then each scope update.
export interface GrantVersion {
    position: Position;
    // Absent means every core kind.
    actions?: string[];
    expiresAt?: string;
}

export type GrantVoidReason =
    // There are no versions, or the first is not an asset holding a grant.
    | 'not-a-grant'
    // The creation's data is not a valid grant.
    | 'invalid'
    // The grant is on a registry that is not one of the permitted chains.
    | 'registry'
    // The grant was created with `validUntil`, which lets nodes delete its history.
    | 'expires-by-registration'
    // The client it names is the user who created it.
    | 'client-is-user';

export type Grant =
    | { status: 'void'; reason: GrantVoidReason }
    // The creation states a `v` this verifier does not know.
    | { status: 'unsupported' }
    // The creation is not yet anchored on the grant's registry.
    | { status: 'pending'; user: string; client: string; registry: string }
    | {
        status: 'valid';
        user: string;
        client: string;
        registry: string;
        // The creation, then the anchored scope updates, in history order.
        versions: GrantVersion[];
        // The lowest position of an anchored version after the active history,
        // which is the creation and the scope updates that follow it directly.
        // The grant confers nothing from this position on.
        ended?: Position;
        // Later versions not anchored on the grant's registry yet. They have no
        // effect until they are.
        pending: number;
    };

// The position of a version on a registry, if it is anchored there.
export function positionOn(version: ResolvedVersion, registry: string): Position | undefined {
    const timestamp = version.didDocumentMetadata?.timestamp;
    const { height, timeISO } = timestamp?.upperBound ?? {};

    return timestamp?.chain === registry && Number.isSafeInteger(height) && typeof timeISO === 'string'
        ? { block: height as number, time: timeISO }
        : undefined;
}

const dataOf = (version: ResolvedVersion): Record<string, any> | undefined => {
    const data = version.didDocumentData;

    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, any> : undefined;
};

// Whether a version leaves a grant as the version before it but for its scope:
// `actions` and `expiresAt`, and nothing else in the document, the registration
// or the data.
function isScopeUpdate(before: ResolvedVersion, version: ResolvedVersion): boolean {
    const [was, is] = [dataOf(before), dataOf(version)];

    if (version.didDocumentMetadata?.deactivated || !was || !is || validateGrant(is.memeplexGrant) !== 'valid') {
        return false;
    }

    const scopeless = ({ actions, expiresAt, ...rest }: Record<string, any>) => { void actions; void expiresAt; return rest; };
    const others = ({ memeplexGrant, ...rest }: Record<string, any>) => { void memeplexGrant; return rest; };

    return equal(version.didDocument, before.didDocument)
        && equal(version.didDocumentRegistration, before.didDocumentRegistration)
        && equal(others(is), others(was))
        && equal(scopeless(is.memeplexGrant), scopeless(was.memeplexGrant));
}

// Reads a grant from the versions of its DID, oldest first.
export function readGrant(versions: ResolvedVersion[]): Grant {
    const creation = versions[0];
    const data = creation && dataOf(creation);
    const registration = creation?.didDocumentRegistration;
    const user = creation?.didDocument?.controller;

    if (!creation || !data || registration?.type !== 'asset' || typeof user !== 'string') {
        return { status: 'void', reason: 'not-a-grant' };
    }

    const validity = validateGrant(data.memeplexGrant);

    if (validity === 'unsupported') {
        return { status: 'unsupported' };
    }
    if (validity !== 'valid') {
        return { status: 'void', reason: data.memeplexGrant === undefined ? 'not-a-grant' : 'invalid' };
    }

    const client: string = data.memeplexGrant.client;
    const registry = registration.registry as string;

    if (!PERMITTED_REGISTRIES.some(permitted => permitted === registry)) {
        return { status: 'void', reason: 'registry' };
    }
    if (registration.validUntil !== undefined) {
        return { status: 'void', reason: 'expires-by-registration' };
    }
    if (client === user) {
        return { status: 'void', reason: 'client-is-user' };
    }

    const created = positionOn(creation, registry);

    if (!created) {
        return { status: 'pending', user, client, registry };
    }

    const scope = ({ actions, expiresAt }: Record<string, any>) => ({
        ...(actions === undefined ? {} : { actions }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    const scopes: GrantVersion[] = [{ position: created, ...scope(data.memeplexGrant) }];
    let active = true;
    let ended: Position | undefined;
    let pending = 0;

    for (let index = 1; index < versions.length; index++) {
        const version = versions[index];
        const position = positionOn(version, registry);

        active = active && isScopeUpdate(versions[index - 1], version);

        if (active) {
            if (position) {
                scopes.push({ position, ...scope(dataOf(version)!.memeplexGrant) });
            }
        }
        else if (position && !(ended && ended.block <= position.block)) {
            ended = position;
        }

        if (!position) {
            pending++;
        }
    }

    return { status: 'valid', user, client, registry, versions: scopes, ...(ended ? { ended } : {}), pending };
}

const ACTIONS: Record<Kind, string> = {
    post: 'memeplex:post',
    paper: 'memeplex:post',
    reply: 'memeplex:reply',
    rating: 'memeplex:rate',
    tag: 'memeplex:tag',
};

// The action a grant's scope has to list for a client to create an object of a
// kind, or nothing for a kind these rules do not know.
export function actionFor(kind: string): string | undefined {
    return Object.hasOwn(ACTIONS, kind) ? ACTIONS[kind as Kind] : undefined;
}

export type Authority =
    | 'permitted'
    // The position is not after the grant's creation, or shares its block.
    | 'before-grant'
    // The position is not before the version that ended the grant.
    | 'after-end'
    // The position shares a block with a scope update, so which scope applies is
    // not established.
    | 'unordered'
    // The block's time is at or after the expiry of the scope in force.
    | 'expired'
    // The scope in force does not permit this kind.
    | 'scope';

// Whether a valid grant confers authority at a position on its registry. With a
// kind, also whether its scope permits creating that kind there; an edit or a
// deletion of an object needs the interval alone, since the creation's permission
// covers it.
export function authorityAt(grant: Extract<Grant, { status: 'valid' }>, position: Position, kind?: Kind): Authority {
    const [creation, ...updates] = grant.versions;

    if (position.block <= creation.position.block) {
        return 'before-grant';
    }
    if (grant.ended && position.block >= grant.ended.block) {
        return 'after-end';
    }
    if (updates.some(update => update.position.block === position.block)) {
        return 'unordered';
    }

    // The latest before the position; of two in one block, the later in the history.
    const inForce = grant.versions
        .filter(version => version.position.block < position.block)
        .reduce((latest, version) => version.position.block >= latest.position.block ? version : latest);

    if (inForce.expiresAt !== undefined) {
        const time = Date.parse(position.time);

        // A time that cannot be read is not shown to be before the expiry.
        if (Number.isNaN(time) || time >= Date.parse(inForce.expiresAt)) {
            return 'expired';
        }
    }
    if (kind && inForce.actions && !inForce.actions.includes(ACTIONS[kind])) {
        return 'scope';
    }

    return 'permitted';
}
