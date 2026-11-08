import http from 'http';
import type { Readable } from 'stream';
import { StringDecoder } from 'string_decoder';

// The few Docker Engine API shapes node-runner reads. Fields Docker omits on
// some versions are optional.
export interface ContainerPort {
    IP?: string;
    PrivatePort: number;
    PublicPort?: number;
    Type: string;
}

export interface ContainerSummary {
    Id: string;
    Names: string[];
    Image: string;
    State: string;
    Status: string;
    Labels: Record<string, string>;
    Ports: ContainerPort[];
}

export interface HealthLogEntry {
    Start: string;
    End: string;
    ExitCode: number;
    Output: string;
}

export interface ContainerInspect {
    Id: string;
    Name: string;
    RestartCount: number;
    State: {
        Status: string;
        Running: boolean;
        Restarting: boolean;
        ExitCode: number;
        StartedAt: string;
        FinishedAt: string;
        Health?: {
            Status: string;
            FailingStreak: number;
            Log?: HealthLogEntry[];
        };
    };
    Config: {
        Image: string;
        Tty: boolean;
        Labels: Record<string, string>;
        Healthcheck?: { Test?: string[] };
    };
    HostConfig: {
        RestartPolicy?: { Name: string };
    };
}

export interface LogOptions {
    tail?: number;
    since?: number;
    follow?: boolean;
}

export interface DockerApi {
    listContainers(project: string): Promise<ContainerSummary[]>;
    inspect(id: string): Promise<ContainerInspect>;
    logs(id: string, options: LogOptions): Promise<Readable>;
}

export class DockerError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

// Talks to the Engine API over its Unix socket. Requests carry no API version
// prefix, so the daemon answers with its own current version.
export function createDockerApi(socketPath: string): DockerApi {
    function request(path: string): Promise<http.IncomingMessage> {
        return new Promise((resolve, reject) => {
            const req = http.request({ socketPath, path, method: 'GET' }, res => {
                if ((res.statusCode ?? 500) >= 400) {
                    let body = '';
                    res.setEncoding('utf-8');
                    res.on('data', chunk => { body += chunk; });
                    res.on('end', () => {
                        let message = body;
                        try {
                            message = JSON.parse(body).message ?? body;
                        }
                        catch {
                            // Not JSON: keep the raw body.
                        }
                        reject(new DockerError(`Docker: ${message.trim()}`, res.statusCode ?? 500));
                    });
                    return;
                }
                resolve(res);
            });
            req.on('error', error => reject(new DockerError(`Docker is not reachable at ${socketPath}: ${error.message}`, 503)));
            req.end();
        });
    }

    async function json<T>(path: string): Promise<T> {
        const res = await request(path);
        let body = '';
        res.setEncoding('utf-8');
        for await (const chunk of res) {
            body += chunk;
        }
        return JSON.parse(body) as T;
    }

    return {
        listContainers(project) {
            const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }));
            return json<ContainerSummary[]>(`/containers/json?all=1&filters=${filters}`);
        },
        inspect(id) {
            return json<ContainerInspect>(`/containers/${encodeURIComponent(id)}/json`);
        },
        async logs(id, options) {
            const params = new URLSearchParams({ stdout: '1', stderr: '1', timestamps: '1' });
            params.set('tail', options.tail === undefined ? 'all' : String(options.tail));
            if (options.since) {
                params.set('since', String(options.since));
            }
            if (options.follow) {
                params.set('follow', '1');
            }
            return request(`/containers/${encodeURIComponent(id)}/logs?${params}`);
        },
    };
}

export interface LogLine {
    stream: 'stdout' | 'stderr';
    time: string;
    text: string;
}

// Terminal escape sequences, such as the colors some services log with.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
    return text.replace(ANSI_ESCAPE, '');
}

// Splits a log line Docker prefixed with its RFC 3339 timestamp, and drops the
// terminal escapes a browser would show as noise.
export function splitTimestamp(line: string): { time: string, text: string } {
    const space = line.indexOf(' ');
    if (space > 0 && /^\d{4}-\d{2}-\d{2}T/.test(line)) {
        return { time: line.slice(0, space), text: stripAnsi(line.slice(space + 1)) };
    }
    return { time: '', text: stripAnsi(line) };
}

// Docker frames the logs of a container without a TTY: each frame is an
// 8-byte header (stream type, three zero bytes, big-endian payload length)
// followed by the payload. A container with a TTY sends plain text instead.
// Frames and lines can both arrive split across chunks.
export class LogDecoder {
    private pending = Buffer.alloc(0);
    private readonly partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };

    // A TTY stream can split a multi-byte character across chunks.
    private readonly text = new StringDecoder('utf-8');

    constructor(private readonly tty: boolean) {}

    push(chunk: Buffer): LogLine[] {
        if (this.tty) {
            return this.lines('stdout', this.text.write(chunk));
        }
        this.pending = Buffer.concat([this.pending, chunk]);
        const lines: LogLine[] = [];
        while (this.pending.length >= 8) {
            const size = this.pending.readUInt32BE(4);
            if (this.pending.length < 8 + size) {
                break;
            }
            const stream = this.pending[0] === 2 ? 'stderr' : 'stdout';
            lines.push(...this.lines(stream, this.pending.subarray(8, 8 + size).toString('utf-8')));
            this.pending = this.pending.subarray(8 + size);
        }
        return lines;
    }

    // Whatever arrived after the last newline, once the stream has ended.
    flush(): LogLine[] {
        const lines: LogLine[] = [];
        for (const stream of ['stdout', 'stderr'] as const) {
            if (this.partial[stream]) {
                lines.push({ stream, ...splitTimestamp(this.partial[stream]) });
                this.partial[stream] = '';
            }
        }
        return lines;
    }

    private lines(stream: 'stdout' | 'stderr', text: string): LogLine[] {
        const parts = (this.partial[stream] + text).split('\n');
        this.partial[stream] = parts.pop() ?? '';
        return parts.map(part => ({ stream, ...splitTimestamp(part.replace(/\r$/, '')) }));
    }
}
