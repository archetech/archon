import type { JSONWebKeySet } from 'jose';

// Fetches and validates Personal Agent client metadata documents and key sets
// (spec 4.1). Every fetch goes to a URL the agent controls, named by a request
// that has not been authenticated yet, so fetches are bounded, never follow
// redirects, carry no credentials, and are throttled per URL (guides,
// "Fetching metadata safely"; Ample Computer's implementation report).

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClientMetadata {
    client_id: string;
    client_name?: string;
    logo_uri?: string;
    jwks_uri: string;
    redirect_uris: string[];
    token_endpoint_auth_method?: string;
    extensions?: Record<string, unknown>;
}

export interface Agent {
    clientId: string;
    domain: string;
    metadata: ClientMetadata;
    jwks: JSONWebKeySet;
}

export class AgentError extends Error {}

const MAX_DOCUMENT_BYTES = 100 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const MIN_CACHE_SECONDS = 60;
const MAX_CACHE_SECONDS = 24 * 60 * 60;
const DEFAULT_CACHE_SECONDS = 5 * 60;
const REFETCH_INTERVAL_MS = 30 * 1000;

function httpsUrl(value: unknown): URL | null {
    if (typeof value !== 'string') {
        return null;
    }
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url : null;
    }
    catch {
        return null;
    }
}

// Returns the client_id's host when the value can name a Personal Agent at all.
export function clientIdDomain(clientId: unknown): string | null {
    const url = httpsUrl(clientId);
    return url && !url.hash ? url.hostname.toLowerCase() : null;
}

function cacheSeconds(response: Response): number {
    const header = response.headers.get('cache-control') || '';
    if (/\b(no-store|no-cache)\b/i.test(header)) {
        return MIN_CACHE_SECONDS;
    }
    const match = /\bmax-age=(\d+)/i.exec(header);
    const seconds = match ? Number(match[1]) : DEFAULT_CACHE_SECONDS;
    return Math.min(MAX_CACHE_SECONDS, Math.max(MIN_CACHE_SECONDS, seconds));
}

async function readLimited(response: Response): Promise<string> {
    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_DOCUMENT_BYTES) {
        throw new AgentError('document too large');
    }
    if (!response.body) {
        return '';
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.byteLength;
        if (total > MAX_DOCUMENT_BYTES) {
            await reader.cancel();
            throw new AgentError('document too large');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function fetchJson(fetcher: Fetcher, url: string): Promise<{ body: unknown; ttl: number }> {
    let response: Response;
    try {
        response = await fetcher(url, {
            method: 'GET',
            headers: { accept: 'application/json' },
            redirect: 'manual',
            credentials: 'omit',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
    }
    catch {
        throw new AgentError(`could not fetch ${url}`);
    }
    if (response.status !== 200) {
        throw new AgentError(`${url} returned HTTP ${response.status}`);
    }
    const text = await readLimited(response);
    try {
        return { body: JSON.parse(text), ttl: cacheSeconds(response) };
    }
    catch {
        throw new AgentError(`${url} is not JSON`);
    }
}

export function validateClientMetadata(clientId: string, body: unknown): ClientMetadata {
    const domain = clientIdDomain(clientId);
    if (!domain) {
        throw new AgentError('client_id must be an HTTPS URL');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new AgentError('client metadata must be a JSON object');
    }
    const metadata = body as Record<string, unknown>;
    if (metadata.client_id !== clientId) {
        throw new AgentError('client metadata client_id does not equal the URL it was fetched from');
    }
    const jwksUri = httpsUrl(metadata.jwks_uri);
    if (!jwksUri || jwksUri.hostname.toLowerCase() !== domain) {
        throw new AgentError('jwks_uri must be an HTTPS URL on the client_id domain');
    }
    const redirectUris = metadata.redirect_uris ?? [];
    if (!Array.isArray(redirectUris) || !redirectUris.every(uri => httpsUrl(uri)?.hostname.toLowerCase() === domain)) {
        throw new AgentError('redirect_uris must be HTTPS URLs on the client_id domain');
    }
    if (metadata.token_endpoint_auth_method !== undefined && metadata.token_endpoint_auth_method !== 'private_key_jwt') {
        throw new AgentError('token_endpoint_auth_method must be private_key_jwt');
    }
    return {
        client_id: clientId,
        client_name: typeof metadata.client_name === 'string' ? metadata.client_name : undefined,
        logo_uri: httpsUrl(metadata.logo_uri)?.href,
        jwks_uri: jwksUri.href,
        redirect_uris: redirectUris as string[],
        token_endpoint_auth_method: 'private_key_jwt',
        extensions: metadata.extensions && typeof metadata.extensions === 'object'
            ? metadata.extensions as Record<string, unknown>
            : undefined,
    };
}

const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];

export function validateJwks(body: unknown): JSONWebKeySet {
    const keys = (body as { keys?: unknown })?.keys;
    if (!Array.isArray(keys)) {
        throw new AgentError('key set must have a keys array');
    }
    for (const key of keys) {
        if (!key || typeof key !== 'object' || PRIVATE_JWK_MEMBERS.some(member => member in key)) {
            throw new AgentError('key set must contain only public keys');
        }
    }
    return { keys } as JSONWebKeySet;
}

interface CacheEntry<T> {
    value?: T;
    error?: string;
    expiresAt: number;
    fetchedAt: number;
}

export class AgentDirectory {
    private readonly metadata = new Map<string, CacheEntry<ClientMetadata>>();
    private readonly keySets = new Map<string, CacheEntry<JSONWebKeySet>>();

    constructor(private readonly fetcher: Fetcher, private readonly now: () => number = Date.now) {}

    private async cached<T>(
        cache: Map<string, CacheEntry<T>>,
        url: string,
        load: (body: unknown) => T,
        refresh = false,
    ): Promise<T> {
        const entry = cache.get(url);
        const now = this.now();
        const fresh = entry && entry.expiresAt > now;
        // A refresh is honoured at most once per interval per URL, counting
        // failures, so a stream of bad requests cannot drive repeated fetches.
        const throttled = entry && now - entry.fetchedAt < REFETCH_INTERVAL_MS;
        if (entry && (throttled || (fresh && !refresh))) {
            if (entry.value !== undefined) {
                return entry.value;
            }
            throw new AgentError(entry.error || `could not load ${url}`);
        }
        try {
            const { body, ttl } = await fetchJson(this.fetcher, url);
            const value = load(body);
            cache.set(url, { value, expiresAt: now + ttl * 1000, fetchedAt: now });
            return value;
        }
        catch (error) {
            const message = error instanceof AgentError ? error.message : `could not load ${url}`;
            cache.set(url, { error: message, expiresAt: now + REFETCH_INTERVAL_MS, fetchedAt: now });
            throw error instanceof AgentError ? error : new AgentError(message);
        }
    }

    async get(clientId: string, refreshKeys = false): Promise<Agent> {
        const domain = clientIdDomain(clientId);
        if (!domain) {
            throw new AgentError('client_id must be an HTTPS URL');
        }
        const metadata = await this.cached(this.metadata, clientId, body => validateClientMetadata(clientId, body));
        const jwks = await this.cached(this.keySets, metadata.jwks_uri, validateJwks, refreshKeys);
        return { clientId, domain, metadata, jwks };
    }
}
