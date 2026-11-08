// Mirrors services/node-runner/server/src/status.ts and logs.ts.
export type Health = 'healthy' | 'unhealthy' | 'starting' | 'running' | 'restarting' | 'completed' | 'failed' | 'stopped';

export interface ServiceStatus {
    service: string;
    container: string;
    group: string;
    stateful: boolean;
    image: string;
    state: string;
    health: Health;
    hasHealthcheck: boolean;
    healthOutput: string | null;
    failingStreak: number;
    startedAt: string | null;
    finishedAt: string | null;
    exitCode: number | null;
    restarts: number;
    ports: string[];
}

export interface StatusReport {
    project: string;
    services: ServiceStatus[];
    counts: Record<Health, number>;
}

export interface LogEntry {
    service: string;
    stream: 'stdout' | 'stderr';
    time: string;
    text: string;
    key?: string;
}

export interface Session {
    configured: boolean;
    authenticated: boolean;
    minPasswordLength: number;
}

export interface Info {
    project: string;
    gitCommit: string;
}

export class ApiError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`/api${path}`, body === undefined
        ? { credentials: 'same-origin' }
        : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new ApiError(data.error ?? res.statusText, res.status);
    }
    return data as T;
}

function logQuery(services: string[], tail: number, extra: Record<string, string> = {}): string {
    const params = new URLSearchParams({ tail: String(tail), ...extra });
    if (services.length) {
        params.set('services', services.join(','));
    }
    return params.toString();
}

export const api = {
    session: () => call<Session>('/session'),
    setup: (code: string, password: string) => call<{ ok: true }>('/setup', { code, password }),
    login: (password: string) => call<{ ok: true }>('/login', { password }),
    logout: () => call<{ ok: true }>('/logout', {}),
    info: () => call<Info>('/info'),
    status: () => call<StatusReport>('/status'),
    logs: (services: string[], tail: number) => call<{ entries: LogEntry[] }>(`/logs?${logQuery(services, tail)}`),
    downloadUrl: (services: string[], tail: number) => `/api/logs?${logQuery(services, tail, { format: 'text' })}`,
    streamUrl: (services: string[], tail: number, since?: number) =>
        `/api/logs/stream?${logQuery(services, tail, since ? { since: String(since) } : {})}`,
};
