import { AgentDirectory, clientIdDomain } from '../../services/herald/server/src/poppy/agents.ts';
import { AGENT_ID, TestAgent, fetcherFor, fetches, type Docs } from './poppy-helpers.ts';

// Fetching and validating Personal Agent client metadata and key sets. Every
// URL comes from an unauthenticated request, so each refusal here is a bound
// on what an arbitrary caller can make Herald fetch and accept.

const JWKS = 'https://agent.example/jwks.json';

let agent: TestAgent;
let docs: Docs;

beforeEach(async () => {
    fetches.length = 0;
    agent = await new TestAgent().init();
    docs = agent.docs();
});

// A fetcher that answers the metadata URL with `respond` and everything else
// from `docs`.
function metadataFetcher(respond: () => Response | Promise<Response>) {
    const fallback = fetcherFor(() => docs);
    return async (url: string) => (url === AGENT_ID ? respond() : fallback(url));
}

function metadata(overrides: Record<string, unknown>) {
    docs[AGENT_ID] = { ...(docs[AGENT_ID] as object), ...overrides };
    return new AgentDirectory(fetcherFor(() => docs)).get(AGENT_ID);
}

describe('client_id', () => {
    it('names an agent only as an HTTPS URL without credentials or fragment', () => {
        expect(clientIdDomain('https://Agent.Example/agent.json')).toBe('agent.example');
        expect(clientIdDomain('http://agent.example/agent.json')).toBeNull();
        expect(clientIdDomain('https://user:pw@agent.example/agent.json')).toBeNull();
        expect(clientIdDomain('https://agent.example/agent.json#frag')).toBeNull();
        expect(clientIdDomain('not a url')).toBeNull();
        expect(clientIdDomain(42)).toBeNull();
    });

    it('refuses a non-HTTPS client_id without fetching it', async () => {
        const directory = new AgentDirectory(fetcherFor(() => docs));
        await expect(directory.get('http://agent.example/agent.json')).rejects.toThrow('client_id must be an HTTPS URL');
        expect(fetches).toEqual([]);
    });
});

describe('client metadata validation', () => {
    it('rejects metadata that is not a JSON object', async () => {
        docs[AGENT_ID] = ['not', 'an', 'object'];
        await expect(new AgentDirectory(fetcherFor(() => docs)).get(AGENT_ID)).rejects.toThrow('must be a JSON object');
    });

    it('rejects a redirect_uri on another domain', async () => {
        await expect(metadata({ redirect_uris: ['https://evil.example/cb'] })).rejects.toThrow('redirect_uris must be HTTPS URLs');
    });

    it('rejects redirect_uris that are not a list', async () => {
        await expect(metadata({ redirect_uris: 'https://agent.example/cb' })).rejects.toThrow('redirect_uris must be HTTPS URLs');
    });

    it('rejects any client authentication method but private_key_jwt', async () => {
        await expect(metadata({ token_endpoint_auth_method: 'client_secret_basic' })).rejects.toThrow('must be private_key_jwt');
    });

    it('drops a logo that is not an HTTPS URL', async () => {
        const loaded = await metadata({ logo_uri: 'http://agent.example/logo.png' });
        expect(loaded.metadata.logo_uri).toBeUndefined();
    });

    it('rejects a key set without a keys array', async () => {
        docs[JWKS] = { key: agent.publicJwk };
        await expect(new AgentDirectory(fetcherFor(() => docs)).get(AGENT_ID)).rejects.toThrow('must have a keys array');
    });
});

describe('fetching', () => {
    it('reports a fetch that fails outright', async () => {
        const directory = new AgentDirectory(metadataFetcher(() => {
            throw new TypeError('network down');
        }));
        await expect(directory.get(AGENT_ID)).rejects.toThrow(`could not fetch ${AGENT_ID}`);
    });

    it('rejects a document that is not JSON, including an empty one', async () => {
        const text = new AgentDirectory(metadataFetcher(() => new Response('<html>', { status: 200 })));
        await expect(text.get(AGENT_ID)).rejects.toThrow(`${AGENT_ID} is not JSON`);
        const empty = new AgentDirectory(metadataFetcher(() => new Response(null, { status: 200 })));
        await expect(empty.get(AGENT_ID)).rejects.toThrow(`${AGENT_ID} is not JSON`);
    });

    it('refuses a document that declares more than 100 KiB', async () => {
        const directory = new AgentDirectory(metadataFetcher(() => new Response(JSON.stringify(docs[AGENT_ID]), {
            status: 200,
            headers: { 'content-length': String(100 * 1024 + 1) },
        })));
        await expect(directory.get(AGENT_ID)).rejects.toThrow('document too large');
    });

    it('stops reading an undeclared document past 100 KiB', async () => {
        let cancelled = false;
        const chunk = new Uint8Array(40 * 1024).fill(0x20);
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(chunk);
            },
            cancel() {
                cancelled = true;
            },
        });
        const directory = new AgentDirectory(metadataFetcher(() => new Response(body, { status: 200 })));
        await expect(directory.get(AGENT_ID)).rejects.toThrow('document too large');
        expect(cancelled).toBe(true);
    });

    it('caches a no-store document for the minimum of one minute', async () => {
        let clock = 1_000_000;
        let served = 0;
        const directory = new AgentDirectory(metadataFetcher(() => {
            served += 1;
            return new Response(JSON.stringify(docs[AGENT_ID]), { status: 200, headers: { 'cache-control': 'no-store' } });
        }), () => clock);
        await directory.get(AGENT_ID);
        clock += 59_000;
        await directory.get(AGENT_ID);
        expect(served).toBe(1);
        clock += 2_000;
        await directory.get(AGENT_ID);
        expect(served).toBe(2);
    });

    it('evicts expired entries before live ones when the cache is full', async () => {
        let clock = 1_000_000;
        const directory = new AgentDirectory(fetcherFor(() => docs), () => clock);
        // The oldest entry, cached for the default five minutes.
        await directory.get(AGENT_ID);
        // Failures are remembered for thirty seconds; these fill the cache.
        for (let i = 1; i < 1000; i++) {
            await directory.get(`https://agent${i}.example/agent.json`).catch(() => undefined);
        }
        clock += 31_000;
        await directory.get('https://late.example/agent.json').catch(() => undefined);

        fetches.length = 0;
        await directory.get(AGENT_ID);
        expect(fetches).toEqual([]);
    });
});
