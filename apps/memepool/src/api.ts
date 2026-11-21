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

// Who is signed in: with a grant to publish under, or with the link that asks
// for one and any grants made and not yet anchored.
export interface Me {
    did: string;
    grant?: string;
    registry?: string;
    link?: string;
    pending?: string[];
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
    withdraw(did: string): Promise<void>;
    timeline(authors: string[]): Promise<Publication[]>;
    thread(did: string): Promise<Reply[]>;
    publication(did: string): Promise<Publication | undefined>;
}

export function createApi(bases: { memepool: string; memeplex: string }, fetcher: typeof fetch = (...args) => fetch(...args)): Api {
    const call = async (base: string, path: string, init?: RequestInit): Promise<Response> => {
        const response = await fetcher(`${base}/api/v1${path}`, {
            credentials: 'same-origin',
            ...init,
            headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
        });

        return response;
    };
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
        async withdraw(did) {
            await json(await post(`/objects/${encodeURIComponent(did)}`, undefined, 'DELETE'));
        },
        async timeline(authors) {
            if (authors.length === 0) {
                return [];
            }

            const query = new URLSearchParams(authors.map(author => ['author', author]));

            return (await json(await call(bases.memeplex, `/timeline?${query}`))).publications;
        },
        thread: async did => json(await call(bases.memeplex, `/threads/${encodeURIComponent(did)}`)),
        async publication(did) {
            const response = await call(bases.memeplex, `/publications/${encodeURIComponent(did)}`);

            return response.status === 404 ? undefined : json(response);
        },
    };
}
