import { PassThrough, Readable } from 'stream';
import type { ContainerInspect, ContainerSummary, DockerApi, LogOptions } from '../../services/node-runner/server/src/docker.ts';

// One Docker log frame: stream type, three zero bytes, big-endian length.
export function frame(stream: 1 | 2, text: string): Buffer {
    const payload = Buffer.from(text, 'utf-8');
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
}

export interface FakeContainer {
    service: string;
    inspect?: Partial<Omit<ContainerInspect, 'State' | 'Config'>> & {
        State?: Partial<ContainerInspect['State']>;
        Config?: Partial<ContainerInspect['Config']>;
    };
    ports?: ContainerSummary['Ports'];
    // Lines as "<timestamp> <text>"; stderr lines start with "!".
    logs?: string[];
    tty?: boolean;
    // Opening its log stream fails, after a delay so others open first.
    failLogs?: boolean;
}

export function inspectOf(container: FakeContainer): ContainerInspect {
    const base: ContainerInspect = {
        Id: `id-${container.service}`,
        Name: `/archon-${container.service}-1`,
        RestartCount: 0,
        State: {
            Status: 'running',
            Running: true,
            Restarting: false,
            ExitCode: 0,
            StartedAt: '2026-11-08T10:00:00.000000000Z',
            FinishedAt: '0001-01-01T00:00:00Z',
        },
        Config: { Image: `ghcr.io/archetech/${container.service}`, Tty: !!container.tty, Labels: {} },
        HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
    };
    return {
        ...base,
        ...container.inspect,
        State: { ...base.State, ...container.inspect?.State },
        Config: { ...base.Config, ...container.inspect?.Config },
        HostConfig: { ...base.HostConfig, ...container.inspect?.HostConfig },
    } as ContainerInspect;
}

export class FakeDocker implements DockerApi {
    readonly followed: PassThrough[] = [];
    readonly logCalls: { id: string, options: LogOptions }[] = [];

    constructor(readonly containers: FakeContainer[], readonly project = 'archon') {}

    async listContainers(project: string): Promise<ContainerSummary[]> {
        if (project !== this.project) {
            return [];
        }
        return this.containers.map(c => ({
            Id: `id-${c.service}`,
            Names: [`/archon-${c.service}-1`],
            Image: `ghcr.io/archetech/${c.service}`,
            State: 'running',
            Status: 'Up',
            Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': c.service },
            Ports: c.ports ?? [],
        }));
    }

    async inspect(id: string): Promise<ContainerInspect> {
        const container = this.containers.find(c => `id-${c.service}` === id);
        if (!container) {
            throw new Error(`no such container ${id}`);
        }
        return inspectOf(container);
    }

    async logs(id: string, options: LogOptions): Promise<Readable> {
        this.logCalls.push({ id, options });
        const container = this.containers.find(c => `id-${c.service}` === id)!;
        if (container.failLogs) {
            await new Promise(resolve => setTimeout(resolve, 20));
            throw new Error(`logs unavailable for ${container.service}`);
        }
        const lines = (container.logs ?? []).slice(-(options.tail ?? Infinity));
        const chunks = lines.map(line => {
            const stderr = line.startsWith('!');
            const text = `${stderr ? line.slice(1) : line}\n`;
            return container.tty ? Buffer.from(text) : frame(stderr ? 2 : 1, text);
        });
        if (!options.follow) {
            return Readable.from(chunks);
        }
        const stream = new PassThrough();
        chunks.forEach(chunk => stream.write(chunk));
        this.followed.push(stream);
        return stream;
    }
}
