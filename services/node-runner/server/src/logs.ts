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
    running: boolean;
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
        return { service, id, tty: inspect.Config.Tty, running: inspect.State.Running };
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

// Which containers the selected services have and whether each is running.
// A change means the stream should end so the client resolves them again.
export async function containerSignature(docker: DockerApi, project: string, services: string[]): Promise<string> {
    const containers = await docker.listContainers(project);
    return containers
        .map(c => ({ service: c.Labels['com.docker.compose.service'], id: c.Id, running: c.State === 'running' }))
        .filter(c => !services.length || services.includes(c.service))
        .map(c => `${c.service}:${c.id}:${c.running}`)
        .sort()
        .join(',');
}

export interface Watch {
    signature: () => Promise<string>;
    intervalMs: number;
}

// Sends the tail of every target, then follows the running ones until
// `signal` aborts, a follower ends, or the containers change (one starts,
// stops or is recreated), so the caller can reconnect and resolve the
// services again. A stopped container's log is finite: it is read once, not
// followed, so it cannot end the stream. Every stream opened is closed on the
// way out, including after a failure part-way through opening them.
export async function followLogs(
    docker: DockerApi,
    targets: LogTarget[],
    options: { tail: number, since?: number },
    onEntry: (entry: LogEntry) => void,
    signal: AbortSignal,
    watch?: Watch,
): Promise<void> {
    const streams: Readable[] = [];
    const stop = () => streams.forEach(stream => stream.destroy());
    let timer: ReturnType<typeof setInterval> | undefined;
    signal.addEventListener('abort', stop, { once: true });
    try {
        const initial = watch ? await watch.signature() : '';

        const stopped = targets.filter(t => !t.running);
        if (stopped.length) {
            (await collectLogs(docker, stopped, options)).forEach(onEntry);
        }

        const opened = await Promise.allSettled(targets.filter(t => t.running).map(async target => {
            const stream = await docker.logs(target.id, { tail: options.tail, since: options.since, follow: true });
            streams.push(stream);
            if (signal.aborted) {
                stream.destroy();
            }
            return { target, stream };
        }));
        const failed = opened.find(result => result.status === 'rejected');
        if (failed) {
            throw (failed as PromiseRejectedResult).reason;
        }
        if (signal.aborted) {
            return;
        }

        const runs = (opened as PromiseFulfilledResult<{ target: LogTarget, stream: Readable }>[])
            .map(({ value }) => decode(value.target, value.stream, onEntry));
        // The followers left behind are destroyed below; their outcome no longer matters.
        runs.forEach(run => run.catch(() => {}));
        const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        const changed = new Promise<void>(resolve => {
            if (watch) {
                timer = setInterval(() => {
                    watch.signature().then(now => now !== initial && resolve(), () => {});
                }, watch.intervalMs);
            }
        });
        await Promise.race([...runs, aborted, changed]);
    }
    finally {
        clearInterval(timer);
        signal.removeEventListener('abort', stop);
        stop();
    }
}
