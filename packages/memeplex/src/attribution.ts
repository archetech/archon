import { equal } from './runtime.js';
import { authorityAt, positionOn, readGrant } from './grant.js';
import { validateObject } from './validate.js';
import type { Authority, Grant, Position, ResolvedVersion } from './grant.js';
import type { Kind, Validity } from './validate.js';

// Which versions of an object are attributed to its author, and what the object
// publishes as a result: docs/plans/memeplex-1436.md, "One rule for publication".
//
// The evidence is the versions of the object's DID and the versions of the DID of
// the grant it names, both as a Gatekeeper resolves them.

export type Unattributed =
    // The first version is not an asset holding an object.
    | 'not-an-object'
    // The version's `memeplex` is not valid. `validity` says how.
    | 'invalid'
    // The grant versions handed over are not those of the grant the object names.
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
    // The version's `versionId`.
    opid?: string;
    // What made the version: its creation, an update or its deletion.
    type: 'create' | 'update' | 'delete';
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
    // The object's DID.
    did?: string;
    // One for each version of the object, in order.
    versions: Version[];
    // The index in `versions` of the last attributed version.
    current?: number;
    // The object as published or, when withdrawn, as it last was.
    memeplex?: Record<string, any>;
}

type Check = Extract<VersionOutcome, { outcome: 'unattributed' | 'pending' | 'unsupported' }> | undefined;
const failed = (reason: Unattributed, detail: Partial<Extract<VersionOutcome, { outcome: 'unattributed' }>> = {}): Check =>
    ({ outcome: 'unattributed', reason, ...detail });

function position(version: ResolvedVersion, grant: Extract<Grant, { status: 'valid' }>, kind?: Kind): Check | Position {
    const at = positionOn(version, grant.registry);

    if (!at) {
        return { outcome: 'pending' };
    }

    const authority = authorityAt(grant, at, kind);

    return authority === 'permitted' ? at : failed('authority', { authority });
}

// The parts of an object that every version has to keep.
const identity = ({ author, kind, grant, target }: Record<string, any>) => ({ author, kind, grant, target });

const memeplexOf = (version: ResolvedVersion | undefined): Record<string, any> | undefined => {
    const data = version?.didDocumentData;

    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, any>).memeplex : undefined;
};

export function attribute(object: ResolvedVersion[], grantVersions: ResolvedVersion[]): Publication {
    const versions: Version[] = object.map((version, index) => ({
        outcome: 'pending',
        ...(version.didDocumentMetadata?.versionId ? { opid: version.didDocumentMetadata.versionId } : {}),
        type: index === 0 ? 'create' : version.didDocumentMetadata?.deactivated ? 'delete' : 'update',
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

    const creation = object[0];
    const grant = readGrant(grantVersions);
    let memeplex = memeplexOf(creation);
    let current: number | undefined;

    const first = ((): Check | Position => {
        if (!creation || creation.didDocumentRegistration?.type !== 'asset' || memeplex === undefined) {
            return failed('not-an-object');
        }

        const validity = validateObject(memeplex);

        if (validity === 'unsupported') {
            return { outcome: 'unsupported' };
        }
        if (validity !== 'valid') {
            return failed('invalid', { validity });
        }

        const grantDid = grantVersions[0]?.didDocument?.id;

        if (grantDid === undefined || grantDid !== memeplex.grant) {
            return failed('grant-mismatch');
        }
        if (grant.status === 'unsupported') {
            return { outcome: 'unsupported' };
        }
        if (grant.status === 'void') {
            return failed('grant-void', { grant: grant.reason });
        }
        if (grant.user !== memeplex.author) {
            return failed('author');
        }
        if (creation.didDocument?.controller !== grant.client) {
            return failed('publisher');
        }
        if (creation.didDocumentRegistration.registry !== grant.registry) {
            return failed('registry');
        }
        if (creation.didDocumentRegistration.validUntil !== undefined) {
            return failed('expires-by-registration');
        }
        if (grant.status === 'pending') {
            return { outcome: 'pending' };
        }

        return position(creation, grant, memeplex.kind);
    })();

    if (first && 'outcome' in first) {
        ends(0, first);
    }
    else if (first && grant.status === 'valid') {
        versions[0] = { ...versions[0], outcome: 'attributed', position: first };
        current = 0;

        for (let index = 1; index < object.length; index++) {
            const version = object[index];
            let next = memeplex;
            let check: Check | Position;

            // A deletion takes its identity from the version before it and has no
            // data of its own to check.
            if (version.didDocumentMetadata?.deactivated) {
                check = position(version, grant);
            }
            else {
                next = memeplexOf(version);

                const validity = validateObject(next);

                if (validity === 'unsupported') {
                    check = { outcome: 'unsupported' };
                }
                else if (validity !== 'valid') {
                    check = failed('invalid', { validity });
                }
                else if (version.didDocumentRegistration?.validUntil !== undefined) {
                    check = failed('expires-by-registration');
                }
                else if (!equal(identity(next!), identity(memeplex!))
                    || version.didDocument?.controller !== grant.client
                    || version.didDocumentRegistration?.registry !== grant.registry) {
                    check = failed('identity');
                }
                else {
                    check = position(version, grant);
                }
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

    const did = creation?.didDocument?.id === undefined ? {} : { did: creation.didDocument.id };

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
