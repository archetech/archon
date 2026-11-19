import { equal } from './runtime.js';
import { validateGrant } from './validate.js';
import type { Kind } from './validate.js';

// A grant and the interval of chain positions over which it confers authority,
// read from the grant's accepted history as a Gatekeeper exports it. The rules are
// those of docs/plans/memeplex-1436.md, "One grant, one client, one chain" and
// "Authority is an interval".
//
// Nothing here checks a signature. The history is one a Gatekeeper accepted, so
// its creation was signed by the controller it names and each later operation by
// the controller before it.

// The chains a grant may be created on. Adding one is a protocol revision.
export const PERMITTED_REGISTRIES = ['BTC:mainnet', 'ZEC:mainnet', 'ETH:mainnet', 'SOL:mainnet-beta'] as const;

// An accepted event, in the shape `POST /api/v1/dids/export` returns it.
export interface AcceptedEvent {
    registry: string;
    time: string;
    operation: Record<string, any>;
    registration?: { height?: number };
}

// Where an operation sits on the grant's registry: the block that anchors it, and
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
    // There is no history, or it does not begin with the creation of an asset.
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
        // The lowest position of an anchored operation after the active history,
        // which is the creation and the scope updates that follow it directly.
        // The grant confers nothing from this position on.
        ended?: Position;
        // Later operations not anchored on the grant's registry yet. They have no
        // effect until they are.
        pending: number;
    };

// The position of an event on a registry, if it is anchored there.
export function positionOn(event: AcceptedEvent, registry: string): Position | undefined {
    const height = event.registration?.height;

    return event.registry === registry && Number.isSafeInteger(height) && typeof event.time === 'string'
        ? { block: height as number, time: event.time }
        : undefined;
}

// The parts of an asset's state that a grant's history can change.
interface State {
    controller: string;
    data: unknown;
    registration: unknown;
    document: unknown;
}

// Whether an update leaves a grant as it was but for its scope: `actions` and
// `expiresAt`, and nothing else. A component the update does not supply is kept;
// one it supplies replaces the whole component, so it has to equal what it replaces.
function scopeUpdate(state: State, operation: Record<string, any>): Record<string, any> | undefined {
    const doc = operation.doc;

    if (operation.type !== 'update' || !doc || typeof doc !== 'object') {
        return undefined;
    }

    if (doc.didDocumentRegistration !== undefined && !equal(doc.didDocumentRegistration, state.registration)) {
        return undefined;
    }

    if (doc.didDocument !== undefined && !equal(doc.didDocument, state.document)) {
        return undefined;
    }

    const data = doc.didDocumentData === undefined ? state.data : doc.didDocumentData;
    const before = state.data as Record<string, any>;

    if (!data || typeof data !== 'object' || Array.isArray(data) || validateGrant(data.memeplexGrant) !== 'valid') {
        return undefined;
    }

    const scopeless = ({ actions, expiresAt, ...rest }: Record<string, any>) => { void actions; void expiresAt; return rest; };
    const others = ({ memeplexGrant, ...rest }: Record<string, any>) => { void memeplexGrant; return rest; };

    return equal(others(data), others(before)) && equal(scopeless(data.memeplexGrant), scopeless(before.memeplexGrant))
        ? data
        : undefined;
}

// Reads a grant from its accepted history, in predecessor order.
export function readGrant(history: AcceptedEvent[]): Grant {
    const creation = history[0]?.operation;

    if (!creation || creation.type !== 'create' || creation.registration?.type !== 'asset'
        || typeof creation.controller !== 'string' || !creation.data || typeof creation.data !== 'object') {
        return { status: 'void', reason: 'not-a-grant' };
    }

    const validity = validateGrant(creation.data.memeplexGrant);

    if (validity === 'unsupported') {
        return { status: 'unsupported' };
    }
    if (validity !== 'valid') {
        return { status: 'void', reason: creation.data.memeplexGrant === undefined ? 'not-a-grant' : 'invalid' };
    }

    const user: string = creation.controller;
    const client: string = creation.data.memeplexGrant.client;
    const registry: string = creation.registration.registry;

    if (!PERMITTED_REGISTRIES.some(permitted => permitted === registry)) {
        return { status: 'void', reason: 'registry' };
    }
    if (creation.registration.validUntil !== undefined) {
        return { status: 'void', reason: 'expires-by-registration' };
    }
    if (client === user) {
        return { status: 'void', reason: 'client-is-user' };
    }

    const created = positionOn(history[0], registry);

    if (!created) {
        return { status: 'pending', user, client, registry };
    }

    const scope = ({ actions, expiresAt }: Record<string, any>) => ({
        ...(actions === undefined ? {} : { actions }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    const versions: GrantVersion[] = [{ position: created, ...scope(creation.data.memeplexGrant) }];
    // An asset's first document is the one a Gatekeeper gives it: its DID and its
    // controller. Every later operation names the DID.
    const state: State = {
        controller: user,
        data: creation.data,
        registration: creation.registration,
        document: { '@context': ['https://www.w3.org/ns/did/v1'], id: history[1]?.operation.did, controller: user },
    };
    let active = true;
    let ended: Position | undefined;
    let pending = 0;

    for (const event of history.slice(1)) {
        const position = positionOn(event, registry);
        const data = active ? scopeUpdate(state, event.operation) : undefined;

        if (data) {
            state.data = data;
            if (position) {
                versions.push({ position, ...scope(data.memeplexGrant) });
            }
        }
        else {
            active = false;
            if (position && !(ended && ended.block <= position.block)) {
                ended = position;
            }
        }

        if (!position) {
            pending++;
        }
    }

    return { status: 'valid', user, client, registry, versions, ...(ended ? { ended } : {}), pending };
}

// Whether one date-time is before another. An expiry may state any fraction of a
// second and Date keeps three digits, so the fractions are compared as written.
function isBefore(earlier: string, later: string): boolean {
    const read = (text: string) => {
        const parts = /^([^.]*)(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(text);
        const seconds = parts ? Date.parse(parts[1] + parts[3]) : NaN;

        return Number.isNaN(seconds) ? undefined : { seconds, fraction: (parts![2] ?? '').replace(/0+$/, '') };
    };
    const a = read(earlier);
    const b = read(later);

    if (!a || !b) {
        return false;
    }

    // Fractions with their trailing zeros removed order as text does.
    return a.seconds < b.seconds || (a.seconds === b.seconds && a.fraction < b.fraction);
}

const ACTIONS: Record<Kind, string> = {
    post: 'memeplex:post',
    paper: 'memeplex:post',
    reply: 'memeplex:reply',
    rating: 'memeplex:rate',
    tag: 'memeplex:tag',
};

export type Authority =
    | 'permitted'
    // The position is not after the grant's creation, or shares its block.
    | 'before-grant'
    // The position is not before the operation that ended the grant.
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

    // A time that cannot be read is not shown to be before the expiry.
    if (inForce.expiresAt !== undefined && !isBefore(position.time, inForce.expiresAt)) {
        return 'expired';
    }
    if (kind && inForce.actions && !inForce.actions.includes(ACTIONS[kind])) {
        return 'scope';
    }

    return 'permitted';
}
