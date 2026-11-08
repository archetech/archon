import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PassThrough, Readable } from 'stream';
import type { CommandResult, ComposeApi, ComposeConfig } from '../../services/node-runner/server/src/compose.ts';
import { ComposeError } from '../../services/node-runner/server/src/compose.ts';
import type { ContainerInspect, ContainerSummary, DockerApi, LogOptions } from '../../services/node-runner/server/src/docker.ts';
import { envValues, parseEnv } from '../../services/node-runner/server/src/envfile.ts';
import { parseProfiles } from '../../services/node-runner/server/src/profiles.ts';

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
    // The com.docker.compose.config-hash label.
    hash?: string;
    // The image the container was created from.
    imageId?: string;
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
    // What each image name currently refers to.
    readonly images = new Map<string, string>();

    constructor(readonly containers: FakeContainer[], readonly project = 'archon') {}

    async listContainers(project: string): Promise<ContainerSummary[]> {
        if (project !== this.project) {
            return [];
        }
        return this.containers.map(c => ({
            Id: `id-${c.service}`,
            Names: [`/archon-${c.service}-1`],
            Image: `ghcr.io/archetech/${c.service}`,
            ...(c.imageId ? { ImageID: c.imageId } : {}),
            State: inspectOf(c).State.Status,
            Status: 'Up',
            Labels: {
                'com.docker.compose.project': project,
                'com.docker.compose.service': c.service,
                ...(c.hash ? { 'com.docker.compose.config-hash': c.hash } : {}),
            },
            Ports: c.ports ?? [],
        }));
    }

    async imageId(name: string): Promise<string | null> {
        return this.images.get(name) ?? null;
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

export interface FakeService {
    profiles?: string[];
    // Settings the service's configuration hash depends on.
    vars?: string[];
    // Settings passed as build arguments.
    buildVars?: string[];
}

// Stands in for the Compose CLI. Like Compose, it reads the env file it is
// given (or the node's .env), enables services by COMPOSE_PROFILES, and
// derives each service's hash from the settings it uses.
export class FakeCompose implements ComposeApi {
    readonly commands: string[][] = [];
    invalid: string | null = null;
    failing: string | null = null;

    constructor(private readonly nodeDir: string, private readonly services: Record<string, FakeService>) {}

    private values(envFile?: string): Map<string, string> {
        let text = '';
        try {
            text = readFileSync(envFile ?? join(this.nodeDir, '.env'), 'utf-8');
        }
        catch {
            // No .env: every setting is unset.
        }
        return envValues(parseEnv(text));
    }

    private active(values: Map<string, string>, all = false): [string, FakeService][] {
        const on = new Set(parseProfiles(values.get('COMPOSE_PROFILES')));
        return Object.entries(this.services).filter(([, s]) => all || !s.profiles || s.profiles.some(p => on.has(p)));
    }

    hashOf(service: string, values: Map<string, string>): string {
        const vars = this.services[service].vars ?? [];
        return createHash('sha256').update(service + vars.map(v => `${v}=${values.get(v) ?? ''}`).join('\n')).digest('hex');
    }

    // The hash a container created from the node's current .env carries.
    currentHash(service: string): string {
        return this.hashOf(service, this.values());
    }

    async validate(): Promise<void> {
        if (this.invalid) {
            throw new ComposeError(this.invalid, 400);
        }
    }

    async config(envFile?: string, allProfiles = false): Promise<ComposeConfig> {
        const values = this.values(envFile);
        return {
            name: 'archon',
            services: Object.fromEntries(this.active(values, allProfiles).map(([name, s]) => [name, {
                ...(s.profiles ? { profiles: s.profiles } : {}),
                ...(s.buildVars ? { build: { context: '.', args: Object.fromEntries(s.buildVars.map(v => [v, values.get(v) ?? ''])) } } : {}),
            }])),
        };
    }

    async hashes(envFile?: string): Promise<Map<string, string>> {
        const values = this.values(envFile);
        return new Map(this.active(values).map(([name]) => [name, this.hashOf(name, values)]));
    }

    async command(args: string[], options: { onLine?: (line: string) => void } = {}): Promise<CommandResult> {
        this.commands.push(args);
        options.onLine?.(`fake: ${args.join(' ')}`);
        return { code: this.failing === args[0] ? 1 : 0, stdout: '', stderr: '' };
    }
}
