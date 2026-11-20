import { equal } from './runtime.js';
import { authorityAt, positionOn, readGrant } from './grant.js';
import { validateObject } from './validate.js';
import type { AcceptedEvent, Authority, Grant, Position } from './grant.js';
import type { Kind, Validity } from './validate.js';

// Which versions of an object are attributed to its author, and what the object
// publishes as a result: docs/plans/memeplex-1436.md, "One rule for publication".
//
// The evidence is the object's accepted history and the accepted history of the
// grant it names, both as a Gatekeeper exports them. Nothing here checks a
// signature: an accepted creation was signed by the controller it names, and each
// later operation by the controller before it.

export type Unattributed =
    // The history does not begin with the creation of an asset holding an object.
    | 'not-an-object'
    // The version's `memeplex` is not valid. `validity` says how.
    | 'invalid'
    // The grant history handed over is not the history of the grant the object names.
    | 'grant-mismatch'
    // The grant confers nothing. `grant` says why.
    | 'grant-void'
    // The grant's user is not the object's `author`.
    | 'author'
    // The asset's controller is not the grant's client.
    | 'publisher'
    // The object is not on the grant's registry.
    | 'registry'
    // The object was created with `validUntil`, or gained one.
    | 'expires-by-registration'
    // An update changed `author`, `kind`, `grant` or `target`, the controller or
    // the registry.
    | 'identity'
    // The grant confers no authority at the version's position. `authority` says why.
    | 'authority'
    // An earlier version is not attributed, and attribution is a prefix.
    | 'follows-unattributed';

export type VersionOutcome =
    | { outcome: 'attributed'; position: Position }
    // The version, or one before it, or the grant's creation, is not anchored on
    // the grant's registry yet.
    | { outcome: 'pending' }
    | { outcome: 'unattributed'; reason: Unattributed; validity?: Validity; grant?: string; authority?: Authority }
    // The version, or one before it, states a `v` this verifier does not know. It
    // is neither attributed nor rejected.
    | { outcome: 'unsupported' };

export type Version = VersionOutcome & {
    // The canonical CID of the operation, which is the version's `versionId`.
    opid?: string;
    type: string;
};

export interface Publication {
    // What the last attributed version makes of the object.
    //
    // 'published': it is a creation or an update, and `memeplex` is what to show.
    // 'withdrawn': it is a deletion. A tombstone, no longer counted.
    // 'pending':   nothing is attributed yet and the creation may still be.
    // 'none':      the creation is not attributed and cannot become so.
    // 'unsupported': the creation states a `v` this verifier does not know.
    state: 'published' | 'withdrawn' | 'pending' | 'none' | 'unsupported';
    // The object's DID, as the export states it.
    did?: string;
    // One for each operation of the history, in its order.
    versions: Version[];
    // The index in `versions` of the last attributed version.
    current?: number;
    // The object as published or, when withdrawn, as it last was.
    memeplex?: Record<string, any>;
}

type Check = Extract<VersionOutcome, { outcome: 'unattributed' | 'pending' | 'unsupported' }> | undefined;
const failed = (reason: Unattributed, detail: Partial<Extract<VersionOutcome, { outcome: 'unattributed' }>> = {}): Check =>
    ({ outcome: 'unattributed', reason, ...detail });

function position(event: AcceptedEvent, grant: Extract<Grant, { status: 'valid' }>, kind?: Kind): Check | Position {
    const at = positionOn(event, grant.registry);

    if (!at) {
        return { outcome: 'pending' };
    }

    const authority = authorityAt(grant, at, kind);

    return authority === 'permitted' ? at : failed('authority', { authority });
}

// The parts of an object that every version has to keep.
const identity = ({ author, kind, grant, target }: Record<string, any>) => ({ author, kind, grant, target });

export function attribute(history: AcceptedEvent[], grantHistory: AcceptedEvent[]): Publication {
    const versions: Version[] = history.map(event => ({
        outcome: 'pending', ...(event.opid ? { opid: event.opid } : {}), type: event.operation?.type,
    }));
    // Every version from an index on shares an outcome, since attribution is a prefix.
    const rest = (from: number, outcome: VersionOutcome) => {
        for (let index = from; index < versions.length; index++) {
            const { opid, type } = versions[index];
            versions[index] = { ...outcome, ...(opid ? { opid } : {}), type };
        }
    };
    const ends = (index: number, check: NonNullable<Check>) => {
        rest(index, check);
        if (check.outcome === 'unattributed') {
            rest(index + 1, { outcome: 'unattributed', reason: 'follows-unattributed' });
        }
    };

    const creation = history[0]?.operation;
    let memeplex: Record<string, any> | undefined = creation?.data?.memeplex;
    let current: number | undefined;

    const first = ((): Check | Position => {
        if (!creation || creation.type !== 'create' || creation.registration?.type !== 'asset' || memeplex === undefined) {
            return failed('not-an-object');
        }

        const validity = validateObject(memeplex);

        if (validity === 'unsupported') {
            return { outcome: 'unsupported' };
        }
        if (validity !== 'valid') {
            return failed('invalid', { validity });
        }
        if (grantHistory[0]?.did === undefined || grantHistory[0].did !== memeplex.grant) {
            return failed('grant-mismatch');
        }

        const grant = readGrant(grantHistory);

        if (grant.status === 'unsupported') {
            return { outcome: 'unsupported' };
        }
        if (grant.status === 'void') {
            return failed('grant-void', { grant: grant.reason });
        }
        if (grant.user !== memeplex.author) {
            return failed('author');
        }
        if (creation.controller !== grant.client) {
            return failed('publisher');
        }
        if (creation.registration.registry !== grant.registry) {
            return failed('registry');
        }
        if (creation.registration.validUntil !== undefined) {
            return failed('expires-by-registration');
        }
        if (grant.status === 'pending') {
            return { outcome: 'pending' };
        }

        return position(history[0], grant, memeplex.kind);
    })();

    if (first && 'outcome' in first) {
        ends(0, first);
    }
    else if (first) {
        // The checks above passed, so the grant is valid and the object is its client's.
        const grant = readGrant(grantHistory) as Extract<Grant, { status: 'valid' }>;
        versions[0] = { ...versions[0], outcome: 'attributed', position: first };
        current = 0;

        for (let index = 1; index < history.length; index++) {
            const operation = history[index].operation;
            let next = memeplex;
            let check: Check | Position;

            if (operation.type === 'update') {
                const doc = operation.doc ?? {};

                next = doc.didDocumentData === undefined ? memeplex : doc.didDocumentData?.memeplex;

                const validity = validateObject(next);

                if (validity === 'unsupported') {
                    check = { outcome: 'unsupported' };
                }
                else if (validity !== 'valid') {
                    check = failed('invalid', { validity });
                }
                else if (doc.didDocumentRegistration?.validUntil !== undefined) {
                    check = failed('expires-by-registration');
                }
                else if (!equal(identity(next!), identity(memeplex!))
                    || (doc.didDocument !== undefined && doc.didDocument?.controller !== grant.client)
                    || (doc.didDocumentRegistration !== undefined && doc.didDocumentRegistration?.registry !== grant.registry)) {
                    check = failed('identity');
                }
                else {
                    check = position(history[index], grant);
                }
            }
            else if (operation.type === 'delete') {
                check = position(history[index], grant);
            }
            else {
                check = failed('not-an-object');
            }

            if (check && 'outcome' in check) {
                ends(index, check);
                break;
            }

            versions[index] = { ...versions[index], outcome: 'attributed', position: check as Position };
            current = index;
            memeplex = next;
        }
    }

    const did = history[0]?.did === undefined ? {} : { did: history[0].did };

    if (current === undefined) {
        const outcome = versions[0]?.outcome;
        const state = outcome === 'pending' || outcome === 'unsupported' ? outcome : 'none';

        return { state, ...did, versions };
    }

    return {
        state: versions[current].type === 'delete' ? 'withdrawn' : 'published',
        ...did,
        versions,
        current,
        memeplex,
    };
}
