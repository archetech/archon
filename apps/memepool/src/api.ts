// The two services the pages talk to, both on the node's own host: Memepool,
// which signs the user in and publishes for them, and the Memeplex indexer,
// which is where everything read comes from.

export interface Publication {
    state: 'published' | 'withdrawn' | 'pending' | 'none' | 'unsupported';
    did?: string;
    versions: { opid?: string; type: string; outcome: string; position?: { block: number; time: string } }[];
    current?: number;
    memeplex?: { kind: string; author: string; text?: string; title?: string; target?: string; [field: string]: unknown };
}

export interface Reply {
    publication: Publication;
    depth: number;
}

// What others have made of an object: who boosted it, the ratings that count
// (one for each author) with their mean from 0 to 1, and the tags and reactions
// put on it with who put each.
export interface Responses {
    boosts: Publication[];
    ratings: { ratings: Publication[]; mean?: number };
    tags: { tag: string; authors: string[] }[];
}

// Who is signed in: with a grant to publish under, or with the link that asks
// for one and any grants made and not yet anchored.
export interface Me {
    did: string;
    grant?: string;
    // Other grants of theirs that are in force.
    others?: string[];
    // What their grants let the service publish. Absent means every core kind.
    actions?: string[];
    registry?: string;
    link?: string;
    pending?: string[];
    // Why the service can ask for no grant, when it cannot.
    unavailable?: string;
}

export class ApiError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

export interface Api {
    me(): Promise<Me | undefined>;
    challenge(): Promise<{ challenge: string; link: string }>;
    // What the service says of the challenge this browser asked for: still
    // waiting for a wallet, answered by an identity the user has yet to
    // confirm, or signed in.
    login(body?: { response?: string; confirm?: string }): Promise<{ waiting?: true; answered?: string; did?: string }>;
    logout(): Promise<void>;
    publish(object: Record<string, unknown>): Promise<string>;
    // Replaces one of the reader's objects with another version of it.
    edit(did: string, object: Record<string, unknown>): Promise<void>;
    withdraw(did: string): Promise<void>;
    // Where an object the reader published through the service stands, and the
    // chain it is on: 'pending' while it waits to be anchored, 'none' when it
    // never will be. Nothing when the service cannot say.
    state(did: string): Promise<{ state: Publication['state']; registry?: string } | undefined>;
    // One page of a timeline, newest first, and how many publications it has in all.
    // `kinds` names the kinds wanted among posts, papers and replies: a
    // reader's timeline is posts and papers, and replies are an author's to list.
    //
    // `read` is how many publications the indexer gave, where that is more
    // than are returned: the next page starts after them.
    timeline(authors: string[], offset?: number, kinds?: string[]): Promise<{ total: number; publications: Publication[]; read?: number }>;
    thread(did: string): Promise<Reply[]>;
    responses(did: string): Promise<Responses>;
    publication(did: string): Promise<Publication | undefined>;
    // A publication as it was at one of its versions, which is what a response
    // to it cites. 'no-revision' when that version is not in its history: no
    // other version stands in for it.
    revision(did: string, versionId: string): Promise<Publication | 'no-revision' | undefined>;
    // The body of an article, read from the node by the CID its entry gives,
    // or nothing when the node has none.
    content(cid: string): Promise<string | undefined>;
    // The address of an identity's avatar, which answers 404 when it has none.
    avatar(did: string): string;
    // The address of an image asset at a version, which answers 404 for what
    // is not an image the service serves.
    image(did: string, versionId: string): string;
    // Has the service store an image and make an asset of it, and gives the
    // asset's DID and the version to embed it at.
    upload(image: Blob): Promise<{ did: string; versionId: string }>;
    // What an identity says of itself: the name it gives itself, which is a
    // claim, and the address its domain confirms is its own.
    identity(did: string): Promise<Person>;
}

export interface Person {
    name?: string;
    address?: string;
}

export function createApi(bases: { memepool: string; memeplex: string; node?: string }, fetcher: typeof fetch = (...args) => fetch(...args)): Api {
    const call = (base: string, path: string, init?: RequestInit): Promise<Response> =>
        fetcher(`${base}/api/v1${path}`, {
            credentials: 'same-origin',
            ...init,
            headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
        });
    const failure = async (response: Response): Promise<ApiError> => {
        let message = `the service answered ${response.status}`;

        try {
            message = (await response.json()).error ?? message;
        }
        catch {
            // The answer had no JSON to say more.
        }

        return new ApiError(response.status, message);
    };
    const json = async (response: Response) => {
        if (!response.ok) {
            throw await failure(response);
        }

        return response.json();
    };
    const post = (path: string, body?: unknown, method = 'POST') =>
        call(bases.memepool, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

    return {
        async me() {
            const response = await call(bases.memepool, '/me');

            return response.status === 401 ? undefined : json(response);
        },
        challenge: async () => json(await call(bases.memepool, '/challenge')),
        login: async body => json(await post('/login', body)),
        async logout() {
            await json(await post('/logout'));
        },
        publish: async object => (await json(await post('/objects', object))).did,
        async edit(did, object) {
            await json(await post(`/objects/${encodeURIComponent(did)}`, object, 'PUT'));
        },
        async withdraw(did) {
            await json(await post(`/objects/${encodeURIComponent(did)}`, undefined, 'DELETE'));
        },
        async upload(image) {
            // Sent as bytes of no stated kind: the service says what an image
            // is from the bytes, and the node's proxy passes on no other body whole.
            const response = await fetcher(`${bases.memepool}/api/v1/images`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: image,
            });

            return json(response);
        },
        async state(did) {
            const response = await call(bases.memepool, `/objects/${encodeURIComponent(did)}/state`).catch(() => undefined);

            return response?.ok ? response.json() : undefined;
        },
        async timeline(authors, offset = 0, kinds) {
            if (authors.length === 0) {
                return { total: 0, publications: [] };
            }

            const query = new URLSearchParams(authors.map(author => ['author', author]));

            for (const kind of kinds ?? []) {
                query.append('kind', kind);
            }
            if (offset > 0) {
                query.set('offset', String(offset));
            }

            const page = await json(await call(bases.memeplex, `/timeline?${query}`)) as { total: number; publications: Publication[] };

            // An indexer that does not know the question gives every kind. What
            // it gave is still what the next page comes after.
            return kinds
                ? { ...page, publications: page.publications.filter(each => kinds.includes(String(each.memeplex?.kind))), read: page.publications.length }
                : page;
        },
        thread: async did => json(await call(bases.memeplex, `/threads/${encodeURIComponent(did)}`)),
        async responses(did) {
            const [boosts, ratings, tags] = await Promise.all(['boosts', 'ratings', 'tags'].map(
                async view => json(await call(bases.memeplex, `/${view}/${encodeURIComponent(did)}`)),
            ));

            return { boosts, ratings, tags };
        },
        async publication(did) {
            const response = await call(bases.memeplex, `/publications/${encodeURIComponent(did)}`);

            return response.status === 404 ? undefined : json(response);
        },
        async revision(did, versionId) {
            const response = await call(bases.memeplex, `/publications/${encodeURIComponent(did)}?versionId=${encodeURIComponent(versionId)}`);

            if (response.status === 404) {
                const reason = await response.json().then(body => (body as { reason?: unknown } | null)?.reason, () => undefined);

                return reason === 'no-revision' ? 'no-revision' : undefined;
            }

            const publication = await json(response) as Publication;

            // An answer has to be the version asked for: an indexer that does
            // not know the question answers with the publication as it is.
            return publication.versions?.[publication.current ?? -1]?.opid === versionId ? publication : undefined;
        },
        async content(cid) {
            // The node serves what is on IPFS itself, to anyone, by its CID.
            const response = await fetcher(`${bases.node ?? ''}/api/v1/ipfs/text/${encodeURIComponent(cid)}`);

            return response.ok ? response.text() : undefined;
        },
        avatar: did => `${bases.memepool}/api/v1/avatars/${encodeURIComponent(did)}`,
        image: (did, versionId) => `${bases.memepool}/api/v1/images/${encodeURIComponent(did)}?versionId=${encodeURIComponent(versionId)}`,
        async identity(did) {
            const response = await call(bases.memepool, `/identities/${encodeURIComponent(did)}`);

            if (!response.ok) {
                return {};
            }

            const { name, address } = await response.json() as Person;

            return { name: typeof name === 'string' ? name : undefined, address: typeof address === 'string' ? address : undefined };
        },
    };
}
