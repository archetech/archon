import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import { join } from 'path';
import { MANAGED_KEYS, isSecret, parseCatalog, type CatalogSetting } from './catalog.js';
import { ComposeError, type ComposeApi, type ComposeConfig } from './compose.js';
import type { DockerApi } from './docker.js';
import { applyChanges, envValues, parseEnv, VALID_KEY } from './envfile.js';
import type { JobLog } from './jobs.js';
import { PROFILE_DESCRIPTIONS, pairingWarnings, parseProfiles, type Warning } from './profiles.js';
import { isOneShot, isStateful, statusReport } from './status.js';

export class ConfigError extends Error {
    constructor(message: string, readonly status = 400) {
        super(message);
    }
}

export interface Draft {
    settings?: Record<string, string>;
    profiles?: string[];
}

export interface SettingView {
    key: string;
    description: string;
    default: string;
    example?: string;
    secret: boolean;
    // Never sent for a secret: only whether it is set.
    value: string | null;
    set: boolean;
    inEnv: boolean;
}

export interface ConfigView {
    profiles: { name: string, description: string, enabled: boolean, services: string[] }[];
    sections: { name: string, settings: SettingView[] }[];
    warnings: Warning[];
}

export interface DiffLine {
    key: string;
    before: string | null;
    after: string | null;
    secret: boolean;
}

export interface PlanService {
    service: string;
    stateful: boolean;
    // An init container that ran to completion; `up` runs it again.
    oneShot?: boolean;
}

export interface Plan {
    rebuild: PlanService[];
    create: PlanService[];
    recreate: PlanService[];
    start: PlanService[];
    stop: PlanService[];
    unchanged: number;
}

export interface Preview {
    diff: DiffLine[];
    warnings: Warning[];
    plan: Plan;
    stateful: string[];
    empty: boolean;
}

export interface NodeConfigOptions {
    nodeDir: string;
    dataDir: string;
    project: string;
    compose: ComposeApi;
    docker: DockerApi;
    // Overridable for tests.
    loadAverage?: () => number;
    cpuCount?: () => number;
    sleep?: (ms: number) => Promise<void>;
    healthTimeoutMs?: number;
}

const MAX_BACKUPS = 20;
const LOAD_WAIT_MS = 10 * 60 * 1000;
const POLL_MS = 5000;

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function changedKeys(before: Map<string, string>, after: Map<string, string>): string[] {
    return [...new Set([...before.keys(), ...after.keys()])].filter(key => (before.get(key) ?? '') !== (after.get(key) ?? ''));
}

function plain(names: Iterable<string>): PlanService[] {
    return [...new Set(names)].sort().map(service => ({ service, stateful: isStateful(service) }));
}

export class NodeConfig {
    private readonly envPath: string;
    private readonly samplePath: string;
    private readonly backupDir: string;
    private readonly loadAverage: () => number;
    private readonly cpuCount: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly healthTimeoutMs: number;

    constructor(private readonly options: NodeConfigOptions) {
        this.envPath = join(options.nodeDir, '.env');
        this.samplePath = join(options.nodeDir, 'sample.env');
        this.backupDir = join(options.dataDir, 'env-backups');
        this.loadAverage = options.loadAverage ?? (() => os.loadavg()[0]);
        this.cpuCount = options.cpuCount ?? (() => os.cpus().length);
        this.sleep = options.sleep ?? realSleep;
        this.healthTimeoutMs = options.healthTimeoutMs ?? 3 * 60 * 1000;
    }

    private async readEnv(): Promise<string> {
        try {
            return await fs.readFile(this.envPath, 'utf-8');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return '';
            }
            throw error;
        }
    }

    private async catalog(): Promise<{ sections: ReturnType<typeof parseCatalog>, byKey: Map<string, CatalogSetting> }> {
        const sections = parseCatalog(await fs.readFile(this.samplePath, 'utf-8').catch(() => ''));
        return { sections, byKey: new Map(sections.flatMap(s => s.settings).map(s => [s.key, s])) };
    }

    async view(): Promise<ConfigView> {
        const values = envValues(parseEnv(await this.readEnv()));
        const { sections, byKey } = await this.catalog();
        const all = await this.options.compose.config(undefined, true);
        const enabled = new Set(parseProfiles(values.get('COMPOSE_PROFILES')));

        const servicesByProfile = new Map<string, string[]>();
        for (const [service, def] of Object.entries(all.services)) {
            for (const profile of def.profiles ?? []) {
                servicesByProfile.set(profile, [...(servicesByProfile.get(profile) ?? []), service]);
            }
        }

        const view = (setting: CatalogSetting | null, key: string): SettingView => {
            const secret = setting?.secret ?? isSecret(key);
            const value = values.get(key);
            return {
                key,
                description: setting?.description ?? '',
                default: setting?.default ?? '',
                ...(setting?.example ? { example: setting.example } : {}),
                secret,
                value: secret ? null : value ?? null,
                set: !!value,
                inEnv: values.has(key),
            };
        };

        const unknown = [...values.keys()].filter(key => !byKey.has(key) && !MANAGED_KEYS.has(key));
        return {
            profiles: [...servicesByProfile.keys()].sort().map(name => ({
                name,
                description: PROFILE_DESCRIPTIONS[name] ?? '',
                enabled: enabled.has(name),
                services: (servicesByProfile.get(name) ?? []).sort(),
            })),
            sections: [
                ...sections.map(section => ({ name: section.name, settings: section.settings.map(s => view(s, s.key)) })),
                ...(unknown.length ? [{ name: 'Other settings in .env', settings: unknown.map(key => view(null, key)) }] : []),
            ],
            warnings: pairingWarnings([...enabled], values, byKey),
        };
    }

    private draftChanges(draft: Draft, known: Set<string>, current: string[]): Record<string, string> {
        const changes: Record<string, string> = {};
        for (const [key, value] of Object.entries(draft.settings ?? {})) {
            if (!VALID_KEY.test(key)) {
                throw new ConfigError(`Not a valid setting name: ${key}`);
            }
            if (MANAGED_KEYS.has(key)) {
                throw new ConfigError(`${key} is not edited as a setting`);
            }
            if (typeof value !== 'string' || /[\r\n]/.test(value)) {
                throw new ConfigError(`${key} must be a single line of text`);
            }
            changes[key] = value;
        }
        if (draft.profiles !== undefined) {
            const unknown = draft.profiles.filter(p => !known.has(p));
            if (unknown.length) {
                throw new ConfigError(`Unknown profile: ${unknown.join(', ')}`);
            }
            // Profiles kept stay where the operator put them; new ones go last.
            const wanted = new Set(draft.profiles);
            const kept = current.filter(p => wanted.has(p));
            changes.COMPOSE_PROFILES = [...new Set([...kept, ...draft.profiles])].join(',');
        }
        return changes;
    }

    // Writes a candidate .env privately to the data directory for Compose to
    // read, and removes it afterwards: it can hold secrets.
    private async withDraftFile<T>(text: string, use: (path: string) => Promise<T>): Promise<T> {
        await fs.mkdir(this.options.dataDir, { recursive: true });
        const path = join(this.options.dataDir, `draft-${randomBytes(6).toString('hex')}.env`);
        await fs.writeFile(path, text, { mode: 0o600 });
        try {
            return await use(path);
        }
        finally {
            await fs.rm(path, { force: true });
        }
    }

    async preview(draft: Draft): Promise<Preview & { text: string }> {
        const current = await this.readEnv();
        const { byKey } = await this.catalog();
        const all = await this.options.compose.config(undefined, true);
        const known = new Set(Object.values(all.services).flatMap(s => s.profiles ?? []));
        const before = envValues(parseEnv(current));
        const text = applyChanges(current, this.draftChanges(draft, known, parseProfiles(before.get('COMPOSE_PROFILES'))));

        const after = envValues(parseEnv(text));
        const diff: DiffLine[] = changedKeys(before, after).map(key => {
            const secret = byKey.get(key)?.secret ?? isSecret(key);
            return { key, before: secret ? null : before.get(key) ?? null, after: secret ? null : after.get(key) ?? null, secret };
        });

        const { hashes, nowConfig, draftConfig } = await this.withDraftFile(text, async path => {
            await this.options.compose.validate(path);
            return {
                hashes: await this.options.compose.hashes(path),
                nowConfig: await this.options.compose.config(),
                draftConfig: await this.options.compose.config(path),
            };
        });

        const plan = await this.plan(hashes, nowConfig, draftConfig);
        const stateful = [...plan.recreate, ...plan.stop].filter(s => s.stateful).map(s => s.service);
        // Applying is about changing .env; containers that drifted from it are
        // started or recreated from the service actions instead.
        const empty = diff.length === 0;
        return {
            text,
            diff,
            warnings: pairingWarnings(parseProfiles(after.get('COMPOSE_PROFILES')), after, byKey),
            plan,
            stateful,
            empty,
        };
    }

    // What `up -d` would do with the candidate configuration, decided the way
    // Compose decides it: a container is recreated when its config-hash label
    // differs from the service's hash. Build arguments are not part of that
    // hash, so a service whose build changed is rebuilt first.
    private async plan(hashes: Map<string, string>, nowConfig: ComposeConfig, draftConfig: ComposeConfig): Promise<Plan> {
        const containers = await this.options.docker.listContainers(this.options.project);
        const byService = new Map(containers.map(c => [c.Labels['com.docker.compose.service'], c]));
        const create: string[] = [];
        const recreate: string[] = [];
        const start: string[] = [];
        let unchanged = 0;

        for (const [service, hash] of hashes) {
            const container = byService.get(service);
            if (!container) {
                create.push(service);
            }
            else if (container.Labels['com.docker.compose.config-hash'] !== hash) {
                recreate.push(service);
            }
            else if (container.State !== 'running') {
                start.push(service);
            }
            else {
                unchanged += 1;
            }
        }

        const stop = containers
            .filter(c => c.State === 'running' && !hashes.has(c.Labels['com.docker.compose.service']))
            .map(c => c.Labels['com.docker.compose.service']);

        const rebuild = Object.entries(draftConfig.services)
            .filter(([service, def]) => def.build && nowConfig.services[service]?.build
                && JSON.stringify(def.build) !== JSON.stringify(nowConfig.services[service].build))
            .map(([service]) => service);

        const starts = await Promise.all(plain(start).map(async item => {
            const inspect = await this.options.docker.inspect(byService.get(item.service)!.Id);
            const oneShot = isOneShot(item.service) && inspect.State.ExitCode === 0;
            return oneShot ? { ...item, oneShot } : item;
        }));

        return { rebuild: plain(rebuild), create: plain(create), recreate: plain(recreate), start: starts, stop: plain(stop), unchanged };
    }

    private async backup(text: string, log: JobLog): Promise<void> {
        await fs.mkdir(this.backupDir, { recursive: true });
        const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.env`;
        await fs.writeFile(join(this.backupDir, name), text, { mode: 0o600 });
        log(`Backed up .env to ${join(this.backupDir, name)}`);
        const backups = (await fs.readdir(this.backupDir)).filter(f => f.endsWith('.env')).sort();
        for (const old of backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS))) {
            await fs.rm(join(this.backupDir, old), { force: true });
        }
    }

    // Replaces .env in one rename, keeping its permissions.
    private async writeEnv(text: string): Promise<void> {
        const mode = await fs.stat(this.envPath).then(s => s.mode & 0o777, () => 0o600);
        const tmp = `${this.envPath}.node-runner-${randomBytes(4).toString('hex')}`;
        await fs.writeFile(tmp, text, { mode });
        await fs.chmod(tmp, mode);
        await fs.rename(tmp, this.envPath);
    }

    // Builds wait until the host is not already busy: the node shares it.
    async waitForLoad(log: JobLog): Promise<void> {
        const limit = this.cpuCount();
        const deadline = Date.now() + LOAD_WAIT_MS;
        let load = this.loadAverage();
        if (load <= limit) {
            log(`Host load ${load.toFixed(2)} on ${limit} cores`);
            return;
        }
        while (load > limit) {
            if (Date.now() > deadline) {
                throw new Error(`Host load stayed at ${load.toFixed(2)} on ${limit} cores; not starting a build`);
            }
            log(`Host load ${load.toFixed(2)} on ${limit} cores; waiting before building`);
            await this.sleep(15000);
            load = this.loadAverage();
        }
    }

    async runCompose(args: string[], log: JobLog): Promise<void> {
        log(`$ docker compose ${args.join(' ')}`);
        const result = await this.options.compose.command(args, { onLine: line => line.trim() && log(line) });
        if (result.code !== 0) {
            throw new ComposeError(`docker compose ${args[0]} exited with code ${result.code}`);
        }
    }

    // Waits for the services just touched to settle, and fails the job if any
    // of them end up unhealthy.
    async verify(services: string[], log: JobLog): Promise<void> {
        if (!services.length) {
            return;
        }
        log('Waiting for health checks…');
        const deadline = Date.now() + this.healthTimeoutMs;
        for (;;) {
            const report = await statusReport(this.options.docker, this.options.project);
            const touched = report.services.filter(s => services.includes(s.service));
            const pending = touched.filter(s => s.health === 'starting' || s.health === 'restarting');
            if (!pending.length || Date.now() > deadline) {
                touched.forEach(s => log(`  ${s.service}: ${s.health}`));
                const bad = touched.filter(s => ['unhealthy', 'failed', 'restarting', 'starting'].includes(s.health));
                if (bad.length) {
                    throw new Error(`Not healthy: ${bad.map(s => s.service).join(', ')}`);
                }
                return;
            }
            await this.sleep(POLL_MS);
        }
    }

    // The apply job. The preview is recomputed here, so what runs is what the
    // configuration says now, not what a browser showed earlier.
    async apply(draft: Draft, confirmStateful: boolean): Promise<{ title: string, work: (log: JobLog) => Promise<void> }> {
        const preview = await this.preview(draft);
        if (preview.empty) {
            throw new ConfigError('Nothing to apply', 409);
        }
        const unconfirmed = preview.stateful.length && !confirmStateful;
        if (unconfirmed) {
            throw new ConfigError(`Confirm interrupting ${preview.stateful.join(', ')} first`, 409);
        }
        const count = preview.diff.length;
        return {
            title: `Apply ${count} configuration change${count === 1 ? '' : 's'}`,
            work: async log => {
                const { plan } = preview;
                await this.backup(await this.readEnv(), log);
                await this.writeEnv(preview.text);
                log(`Wrote ${this.envPath}`);
                if (plan.rebuild.length) {
                    await this.waitForLoad(log);
                    await this.runCompose(['build', ...plan.rebuild.map(s => s.service)], log);
                }
                if (plan.stop.length) {
                    await this.runCompose(['stop', ...plan.stop.map(s => s.service)], log);
                }
                if (plan.create.length || plan.recreate.length || plan.start.length || plan.rebuild.length) {
                    await this.runCompose(['up', '-d'], log);
                }
                await this.verify([...plan.create, ...plan.recreate, ...plan.start, ...plan.rebuild].map(s => s.service), log);
                log('Done.');
            },
        };
    }
}
