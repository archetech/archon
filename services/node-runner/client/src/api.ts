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

export interface Warning {
    message: string;
    fix?: { key: string, value: string, label: string };
}

export interface SettingView {
    key: string;
    description: string;
    default: string;
    example?: string;
    secret: boolean;
    value: string | null;
    set: boolean;
    inEnv: boolean;
}

export interface ConfigView {
    profiles: { name: string, description: string, enabled: boolean, services: string[] }[];
    sections: { name: string, settings: SettingView[] }[];
    warnings: Warning[];
    configError: string | null;
    envMissing: boolean;
}

export interface Draft {
    settings: Record<string, string>;
    profiles?: string[];
}

export interface PlanService {
    service: string;
    stateful: boolean;
    oneShot?: boolean;
}

export interface Preview {
    reviewed: string;
    diff: { key: string, before: string | null, after: string | null, secret: boolean }[];
    warnings: Warning[];
    plan: { rebuild: PlanService[], create: PlanService[], recreate: PlanService[], start: PlanService[], stop: PlanService[], unchanged: number };
    stateful: string[];
    empty: boolean;
}

export interface JobLine {
    time: string;
    text: string;
}

export interface JobSummary {
    id: string;
    title: string;
    status: 'running' | 'succeeded' | 'failed';
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
}

export interface ActionRequest {
    action: 'start' | 'stop' | 'restart';
    service?: string;
    down?: boolean;
}

export interface ActionPreview {
    title: string;
    command: string;
    services: PlanService[];
    stateful: string[];
    empty: boolean;
}

export interface UpdateStatus {
    channel: 'release' | 'main';
    current: { commit: string, describe: string, branch: string | null };
    target: { ref: string, label: string, commit: string } | null;
    commits: { sha: string, subject: string }[];
    unfinished: boolean;
    note: string | null;
    dirty: string[];
    statefulAtRisk: string[];
    load: { load1: number, cores: number };
    fetchError: string | null;
}

export class ApiError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

async function call<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
    const res = await fetch(`/api${path}`, body === undefined
        ? { credentials: 'same-origin' }
        : { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
    config: () => call<ConfigView>('/config'),
    createEnv: (passphrase: string) => call<{ ok: true }>('/config/create', { passphrase }),
    preview: (draft: Draft) => call<Preview>('/config/preview', { draft }),
    apply: (draft: Draft, confirmStateful: boolean, reviewed: string) => call<{ id: string }>('/config/apply', { draft, confirmStateful, reviewed }),
    jobs: () => call<{ jobs: JobSummary[] }>('/jobs'),
    updates: (fetchRemote: boolean) => call<UpdateStatus>(`/updates${fetchRemote ? '?fetch=1' : ''}`),
    setChannel: (channel: 'release' | 'main') => call<{ channel: string }>('/updates/channel', { channel }, 'PUT'),
    runUpdate: (confirm: string[]) => call<{ id: string }>('/updates/run', { confirm }),
    previewAction: (request: ActionRequest) => call<ActionPreview>('/actions/preview', request),
    runAction: (request: ActionRequest, confirmStateful: boolean) => call<{ id: string }>('/actions/run', { ...request, confirmStateful }),
    jobStreamUrl: (id: string) => `/api/jobs/${encodeURIComponent(id)}/stream`,
    streamUrl: (services: string[], tail: number, since?: number) =>
        `/api/logs/stream?${logQuery(services, tail, since ? { since: String(since) } : {})}`,
};
