import { attribute } from './attribution.js';
import type { Publication } from './attribution.js';
import { readGrant } from './grant.js';
import type { Grant, ResolvedVersion } from './grant.js';
import { encodeGrantLink } from './grant-link.js';
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
    createAsset(data: unknown, options?: { registry?: string; controller?: string }): Promise<string>;
    mergeData(did: string, data: Record<string, unknown>): Promise<boolean>;
    revokeDID(did: string): Promise<boolean>;
}

export interface ClientGatekeeper {
    queryDocs(where: Record<string, unknown>): Promise<string[]>;
    resolveVersions(dids: string[]): Promise<ResolvedVersion[][]>;
}

export interface GrantRequest {
    v: 1;
    client: string;
    name: string;
    actions?: string[];
    nonce: string;
    expiresAt?: string;
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

// At least 128 random bits, base64url without padding.
function nonce(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let binary = '';

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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

    // A request for a grant, and the link that presents it to a wallet. The
    // client keeps the request: its nonce is how it recognizes the grant.
    async requestGrant(asked: { name: string; actions?: string[]; expiresAt?: string }): Promise<{ request: GrantRequest; link: string }> {
        const request: GrantRequest = {
            v: 1,
            client: await this.did(),
            name: asked.name,
            ...(asked.actions ? { actions: asked.actions } : {}),
            nonce: nonce(),
            ...(asked.expiresAt ? { expiresAt: asked.expiresAt } : {}),
        };

        return { request, link: encodeGrantLink(request as unknown as Record<string, unknown>) };
    }

    // The grants that answer a request: those naming this client and carrying
    // the request's nonce, each as the verifier reads it. Anyone who saw the
    // request can create one, so there may be several, from different users;
    // the client shows whose each is and lets its user choose.
    async findGrants(request: Pick<GrantRequest, 'client' | 'nonce'>): Promise<FoundGrant[]> {
        return this.grantsNaming(request.client, created => created.memeplexGrant?.nonce === request.nonce);
    }

    // The grants a user has made to this client, whatever request they answer.
    // A client that knows who its user is, because the user signed in to it,
    // needs no nonce to tell that user's grants from another's.
    async grantsFrom(user: string): Promise<FoundGrant[]> {
        return this.grantsNaming(await this.did(), created => created.controller === user);
    }

    private async grantsNaming(
        client: string,
        wanted: (created: { controller?: string; memeplexGrant?: { nonce?: unknown } }) => boolean,
    ): Promise<FoundGrant[]> {
        const dids = await this.gatekeeper.queryDocs({ 'memeplexGrant.client': { $in: [client] } });
        const found: FoundGrant[] = [];

        for (let start = 0; start < dids.length; start += BATCH) {
            const batch = dids.slice(start, start + BATCH);
            const histories = await this.gatekeeper.resolveVersions(batch);

            histories.forEach((history, index) => {
                const data = history[0]?.didDocumentData as { memeplexGrant?: { client?: unknown; nonce?: unknown } } | undefined;

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
        return this.keymaster.createAsset(
            { memeplex: this.stated(grant, object) },
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

    // Withdraws an object the grant's user published.
    async withdraw(did: string, grant: UsableGrant): Promise<void> {
        if ((await this.created(did)).author !== grant.user) {
            throw new MemeplexClientError('invalid', `${did} is not an object of this user's`);
        }
        if (!await this.keymaster.revokeDID(did)) {
            throw new MemeplexClientError('refused', 'the node did not accept the withdrawal');
        }
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

// The grant among those found that a client may publish under, if there is
// exactly one that is valid, has not ended and has not expired. Expiry is
// judged against `now`; what counts for a publication is the time of the block
// that anchors it, which is later.
export function usable(found: FoundGrant[], now: Date = new Date()): UsableGrant | undefined {
    const live = found.filter(({ grant }) => {
        if (grant.status !== 'valid' || grant.ended) {
            return false;
        }

        const { expiresAt } = grant.versions[grant.versions.length - 1];

        return expiresAt === undefined || now.getTime() < Date.parse(expiresAt);
    });

    if (live.length !== 1) {
        return undefined;
    }

    const [{ did, grant }] = live;

    return grant.status === 'valid' ? { did, user: grant.user, registry: grant.registry } : undefined;
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
