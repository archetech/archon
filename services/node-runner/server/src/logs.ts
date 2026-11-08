import type { Readable } from 'stream';
import { DockerError, LogDecoder, type DockerApi } from './docker.js';

export interface LogEntry {
    service: string;
    stream: 'stdout' | 'stderr';
    time: string;
    text: string;
}

export interface LogTarget {
    service: string;
    id: string;
    tty: boolean;
}

export const MAX_TAIL = 5000;

// Docker trims trailing zeros from the fraction of its RFC 3339 timestamps,
// so they only sort as strings once padded to nanoseconds.
export function timeKey(time: string): string {
    const match = time.match(/^([^.]+?)(?:\.(\d+))?Z$/);
    return match ? `${match[1]}.${(match[2] ?? '').padEnd(9, '0')}Z` : time;
}

export function byTime(a: LogEntry, b: LogEntry): number {
    const ka = timeKey(a.time);
    const kb = timeKey(b.time);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function parseTail(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_TAIL) : fallback;
}

// Resolves service names to this project's containers. Unknown names are an
// error rather than silently empty output, since they are always a mistake.
export async function resolveTargets(docker: DockerApi, project: string, services: string[]): Promise<LogTarget[]> {
    const containers = await docker.listContainers(project);
    const byService = new Map(containers.map(c => [c.Labels['com.docker.compose.service'], c]));
    const wanted = services.length ? services : [...byService.keys()];
    const unknown = wanted.filter(service => !byService.has(service));
    if (unknown.length) {
        throw new DockerError(`No container for ${unknown.join(', ')} in project ${project}`, 404);
    }
    return Promise.all(wanted.map(async service => {
        const id = byService.get(service)!.Id;
        const inspect = await docker.inspect(id);
        return { service, id, tty: inspect.Config.Tty };
    }));
}

function decode(target: LogTarget, stream: Readable, onEntry: (entry: LogEntry) => void): Promise<void> {
    const decoder = new LogDecoder(target.tty);
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => decoder.push(chunk).forEach(line => onEntry({ service: target.service, ...line })));
        stream.on('end', () => {
            decoder.flush().forEach(line => onEntry({ service: target.service, ...line }));
            resolve();
        });
        stream.on('close', resolve);
        stream.on('error', reject);
    });
}

// The last `tail` lines of each target, merged in time order.
export async function collectLogs(docker: DockerApi, targets: LogTarget[], options: { tail: number, since?: number }): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];
    await Promise.all(targets.map(async target => {
        const stream = await docker.logs(target.id, { tail: options.tail, since: options.since });
        await decode(target, stream, entry => entries.push(entry));
    }));
    return entries.sort(byTime);
}

// Follows every target until `signal` aborts. Lines arrive in the order each
// container produces them; the client merges across services by time.
export async function followLogs(
    docker: DockerApi,
    targets: LogTarget[],
    options: { tail: number, since?: number },
    onEntry: (entry: LogEntry) => void,
    signal: AbortSignal,
): Promise<void> {
    const streams = await Promise.all(targets.map(async target => ({
        target,
        stream: await docker.logs(target.id, { tail: options.tail, since: options.since, follow: true }),
    })));
    const stop = () => streams.forEach(({ stream }) => stream.destroy());
    if (signal.aborted) {
        stop();
        return;
    }
    signal.addEventListener('abort', stop, { once: true });
    await Promise.allSettled(streams.map(({ target, stream }) => decode(target, stream, onEntry)));
}
