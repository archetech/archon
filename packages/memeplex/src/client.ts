import { attribute } from './attribution.js';
import type { Publication } from './attribution.js';
import { actionFor, readGrant } from './grant.js';
import type { Grant, ResolvedVersion } from './grant.js';
import { grantLink } from './grant-link.js';
import { validateGrantRequest } from './validate.js';
import { validateObject } from './validate.js';

// What a Memeplex client does with a Keymaster that holds its identity and a
// Gatekeeper it reads from: ask a user for a grant, find the grant, and publish
// under it. docs/plans/memeplex-reference-1436.md, "Grant request flow".
//
// Nothing here reaches a network itself. The Keymaster and Gatekeeper are handed
// in, so the same code serves a client that holds them in-process and one that
// reaches them over HTTP.

export interface ClientKeymaster {
    resolveDID(id: string): Promise<{ didDocument?: { id?: string } }>;
    createAsset(data: unknown, options?: { registry?: string; controller?: string; validUntil?: string }): Promise<string>;
    mergeData(did: string, data: Record<string, unknown>): Promise<boolean>;
    revokeDID(did: string): Promise<boolean>;
}

export interface ClientGatekeeper {
    queryDocs(where: Record<string, unknown>): Promise<string[]>;
    resolveVersions(dids: string[]): Promise<ResolvedVersion[][]>;
}

export interface GrantRequest {
    v: 1;
    name: string;
    actions?: string[];
    expiresAt?: string;
    // The permitted registries the client can publish on.
    registries: string[];
}

// A grant that answers a request: its DID and what the verifier reads from its
// history. `pending` is one the chain has not anchored yet; a client waits for
// `valid` before it publishes.
export interface FoundGrant {
    did: string;
    grant: Grant;
}

// A grant a client may publish under.
export interface UsableGrant {
    did: string;
    user: string;
    registry: string;
    // The actions the grant's scope lists. Absent means every core kind.
    actions?: string[];
}

// Whether a grant's scope lets a client create an object of a kind. An object
// outside it would be created and never attributed. A scope that lists no
// actions is every core kind, and no other.
export function allows(grant: Pick<UsableGrant, 'actions'>, kind: string): boolean {
    const action = actionFor(kind);

    return action !== undefined && (!grant.actions || grant.actions.includes(action));
}

// The fields of an object a client supplies. `v`, `author` and `grant` are the
// grant's to state.
export type ObjectFields = { kind: string } & Record<string, unknown>;

// Why a client would not do what it was asked: the object is not one the rules
// allow (`invalid`), or the node would not take the operation (`refused`).
export class MemeplexClientError extends Error {
    readonly reason: 'invalid' | 'refused';

    constructor(reason: 'invalid' | 'refused', message: string) {
        super(message);
        this.name = 'MemeplexClientError';
        this.reason = reason;
    }
}

// How many histories are asked of a Gatekeeper at once.
const BATCH = 100;

// Where a grant request is made, and how long it stays valid. A request is not
// a publication: it need not be on a chain, and a wallet reads it once.
const REQUEST_REGISTRY = 'hyperswarm';
const REQUEST_LIFETIME = 60 * 60_000;

export class MemeplexClient {
    private readonly keymaster: ClientKeymaster;
    private readonly gatekeeper: ClientGatekeeper;
    private readonly identity: string;

    // `identity` is the name, in the Keymaster's wallet, of the agent DID the
    // client acts as.
    constructor(options: { keymaster: ClientKeymaster; gatekeeper: ClientGatekeeper; identity: string }) {
        this.keymaster = options.keymaster;
        this.gatekeeper = options.gatekeeper;
        this.identity = options.identity;
    }

    // The client's DID.
    async did(): Promise<string> {
        const did = (await this.keymaster.resolveDID(this.identity)).didDocument?.id;

        if (!did) {
            throw new Error(`no DID for the identity ${this.identity}`);
        }

        return did;
    }

    // Asks for a grant: creates the request, an asset of the client's that a
    // wallet resolves, and gives its DID and the link that presents it. A grant
    // that answers it names that DID.
    //
    // `registries` are those this client's node supports. A grant made on
    // another could not be published under.
    //
    // The request is made as a challenge is: on hyperswarm and valid for an
    // hour, unless `options` say otherwise.
    async requestGrant(
        asked: { name: string; registries: string[]; actions?: string[]; expiresAt?: string },
        options: { registry?: string; validUntil?: string } = {},
    ): Promise<{ did: string; request: GrantRequest; link: string }> {
        const request: GrantRequest = {
            v: 1,
            name: asked.name,
            ...(asked.actions ? { actions: asked.actions } : {}),
            ...(asked.expiresAt ? { expiresAt: asked.expiresAt } : {}),
            registries: asked.registries,
        };
        const validity = validateGrantRequest(request);

        if (validity !== 'valid') {
            throw new MemeplexClientError('invalid', `not a valid grant request: ${validity}`);
        }

        const did = await this.keymaster.createAsset({ memeplexGrantRequest: request }, {
            registry: options.registry ?? REQUEST_REGISTRY,
            validUntil: options.validUntil ?? new Date(Date.now() + REQUEST_LIFETIME).toISOString(),
            controller: this.identity,
        });

        return { did, request, link: grantLink(did) };
    }

    // The grants that answer a request: those naming this client and the
    // request's DID, each as the verifier reads it. Anyone who saw the request
    // can create one, so there may be several, from different users; the
    // client shows whose each is and lets its user choose.
    async findGrants(request: string): Promise<FoundGrant[]> {
        return this.grantsNaming(await this.did(), created => created.memeplexGrant?.request === request);
    }

    // The grants a user has made to this client, whatever request they answer.
    // A client that knows who its user is, because the user signed in to it,
    // needs no request to tell that user's grants from another's.
    async grantsFrom(user: string): Promise<FoundGrant[]> {
        return this.grantsNaming(await this.did(), created => created.controller === user);
    }

    private async grantsNaming(
        client: string,
        wanted: (created: { controller?: string; memeplexGrant?: { request?: unknown } }) => boolean,
    ): Promise<FoundGrant[]> {
        const dids = await this.gatekeeper.queryDocs({ 'memeplexGrant.client': { $in: [client] } });
        const found: FoundGrant[] = [];

        for (let start = 0; start < dids.length; start += BATCH) {
            const batch = dids.slice(start, start + BATCH);
            const histories = await this.gatekeeper.resolveVersions(batch);

            histories.forEach((history, index) => {
                const data = history[0]?.didDocumentData as { memeplexGrant?: { client?: unknown; request?: unknown } } | undefined;

                if (data?.memeplexGrant?.client === client
                    && wanted({ controller: history[0].didDocument?.controller, memeplexGrant: data.memeplexGrant })) {
                    found.push({ did: batch[index], grant: readGrant(history) });
                }
            });
        }

        return found;
    }

    // Publishes an object for the grant's user, on the grant's registry. Returns
    // the object's DID. The object is a publication once the chain anchors it.
    async publish(grant: UsableGrant, object: ObjectFields): Promise<string> {
        const memeplex = this.stated(grant, object);

        if (!allows(grant, object.kind)) {
            throw new MemeplexClientError('invalid', `the grant does not allow a ${object.kind}`);
        }

        return this.keymaster.createAsset(
            { memeplex },
            { registry: grant.registry, controller: this.identity },
        );
    }

    // Replaces a published object with another version of it. An object's
    // author, kind, grant and target are fixed at its creation: a version that
    // changes one is not attributed, and neither is anything after it, so such
    // an edit is refused.
    async edit(did: string, grant: UsableGrant, object: ObjectFields): Promise<void> {
        const memeplex = this.stated(grant, object);
        const created = await this.created(did);

        for (const field of ['author', 'kind', 'grant', 'target']) {
            if (created[field] !== memeplex[field]) {
                throw new MemeplexClientError('invalid', `an edit cannot change an object's ${field}`);
            }
        }

        if (!await this.keymaster.mergeData(did, { memeplex })) {
            throw new MemeplexClientError('refused', 'the node did not accept the edit');
        }
    }

    // Withdraws an object published under the grant. A deletion under another
    // grant is not attributed, and would leave the publication standing.
    async withdraw(did: string, grant: UsableGrant): Promise<void> {
        const created = await this.created(did);

        if (created.author !== grant.user || created.grant !== grant.did) {
            throw new MemeplexClientError('invalid', `${did} was not published under this grant`);
        }
        if (!await this.keymaster.revokeDID(did)) {
            throw new MemeplexClientError('refused', 'the node did not accept the withdrawal');
        }
    }

    // The grant an object was published under.
    async grantOf(did: string): Promise<string | undefined> {
        const { grant } = await this.created(did);

        return typeof grant === 'string' ? grant : undefined;
    }

    // An object as it was created.
    private async created(did: string): Promise<Record<string, unknown>> {
        const [versions] = await this.gatekeeper.resolveVersions([did]);
        const created = (versions?.[0]?.didDocumentData as { memeplex?: Record<string, unknown> } | undefined)?.memeplex;

        if (!created || typeof created !== 'object') {
            throw new MemeplexClientError('invalid', `${did} is not a published object`);
        }

        return created;
    }

    // What an object is, as the verifier reads it from the Gatekeeper's evidence.
    async publication(object: string, grant: string): Promise<Publication> {
        const [objectVersions, grantVersions] = await this.gatekeeper.resolveVersions([object, grant]);

        return attribute(objectVersions, grantVersions);
    }

    private stated(grant: UsableGrant, object: ObjectFields): Record<string, unknown> {
        const memeplex = { ...object, v: 1, author: grant.user, grant: grant.did };
        const validity = validateObject(memeplex);

        if (validity !== 'valid') {
            throw new MemeplexClientError('invalid', `not a valid ${object.kind}: ${validity}`);
        }

        return memeplex;
    }
}

// The grants among those found that a client may publish under: valid, not ended
// and not expired, the earliest created first by the time of the block that
// anchored it, since heights on different chains do not compare. Expiry is judged against `now`;
// what counts for a publication is the time of the block that anchors it, which
// is later.
export function liveGrants(found: FoundGrant[], now: Date = new Date()): UsableGrant[] {
    const live: { usable: UsableGrant; created: number }[] = [];

    for (const { did, grant } of found) {
        if (grant.status !== 'valid' || grant.ended) {
            continue;
        }

        const { expiresAt, actions } = grant.versions[grant.versions.length - 1];

        if (expiresAt === undefined || now.getTime() < Date.parse(expiresAt)) {
            live.push({
                usable: { did, user: grant.user, registry: grant.registry, ...(actions ? { actions } : {}) },
                created: Date.parse(grant.versions[0].position.time),
            });
        }
    }

    return live
        .sort((a, b) => a.created - b.created || (a.usable.did < b.usable.did ? -1 : 1))
        .map(each => each.usable);
}

// The grant to publish under, when exactly one of those found is live. Grants
// found by a request can be from different users, and a client does not
// choose between users.
export function usable(found: FoundGrant[], now: Date = new Date()): UsableGrant | undefined {
    const live = liveGrants(found, now);

    return live.length === 1 ? live[0] : undefined;
}

// A reader of a Memeplex indexer's views (`docs/services/memeplex-indexer`).
// `url` is the indexer's own address or the node's `/memeplex`.
export class IndexerClient {
    private readonly base: string;
    private readonly fetch: typeof fetch;

    constructor(url: string, fetcher: typeof fetch = (...args) => fetch(...args)) {
        this.base = `${url.replace(/\/+$/, '')}/api/v1`;
        this.fetch = fetcher;
    }

    private async get(path: string, absent = false): Promise<unknown> {
        const response = await this.fetch(`${this.base}${path}`);

        if (absent && response.status === 404) {
            return undefined;
        }
        if (!response.ok) {
            throw new Error(`the indexer answered ${response.status} to ${path}`);
        }

        return response.json();
    }

    // Whether the indexer has read everything its node has. Its other views
    // answer only once it has.
    async ready(): Promise<boolean> {
        return await this.get('/ready') === true;
    }

    // An object's publication, or undefined when it has no attributed version.
    async publication(did: string): Promise<Publication | undefined> {
        return await this.get(`/publications/${encodeURIComponent(did)}`, true) as Publication | undefined;
    }

    // The posts, papers and replies of some authors, newest first.
    async timeline(authors: string[], page: { limit?: number; offset?: number } = {}): Promise<{ total: number; publications: Publication[] }> {
        const query = new URLSearchParams(authors.map(author => ['author', author]));

        if (page.limit !== undefined) query.set('limit', String(page.limit));
        if (page.offset !== undefined) query.set('offset', String(page.offset));

        return await this.get(`/timeline?${query}`) as { total: number; publications: Publication[] };
    }

    // The replies under an object, each with its depth.
    async thread(did: string): Promise<{ publication: Publication; depth: number }[]> {
        return await this.get(`/threads/${encodeURIComponent(did)}`) as { publication: Publication; depth: number }[];
    }
}
