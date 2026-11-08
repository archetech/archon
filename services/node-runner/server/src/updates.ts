import { promises as fs, statSync } from 'fs';
import os from 'os';
import { join } from 'path';
import type { Exec } from './compose.js';
import type { JobLog } from './jobs.js';
import { ConfigError, type NodeConfig } from './node-config.js';
import { isStateful } from './status.js';

export type Channel = 'release' | 'main';

export interface Commit {
    sha: string;
    subject: string;
}

export interface UpdateStatus {
    channel: Channel;
    current: { commit: string, describe: string, branch: string | null };
    // What the channel offers, or null when there is nothing newer.
    target: { ref: string, label: string, commit: string } | null;
    commits: Commit[];
    // Why no update is offered, when that is not simply "up to date".
    note: string | null;
    // Tracked files changed locally; an update refuses to run over them.
    dirty: string[];
    // Stateful services built from this repository: the update restarts them
    // only if their image changes, and only once confirmed.
    statefulBuilt: string[];
    load: { load1: number, cores: number };
    fetchError: string | null;
}

const SETTINGS_FILE = 'settings.json';
const REMOTE = 'origin';

// Files whose change means node-runner itself needs rebuilding.
const SELF_PATHS = ['services/node-runner', 'docker/Dockerfile.node-runner', 'docker/node-runner', 'node-runner'];
export const UPDATER_NAME = 'archon-node-runner-updater';

export interface UpdatesOptions {
    nodeDir: string;
    dataDir: string;
    nodeConfig: NodeConfig;
    exec: Exec;
    // The image node-runner runs from, used for the helper that replaces it.
    selfImage: string;
    loadAverage?: () => number;
    cpuCount?: () => number;
}

export class Updates {
    constructor(private readonly options: UpdatesOptions) {}

    private async git(args: string[], allowFailure = false): Promise<string> {
        const result = await this.options.exec('git', ['-C', this.options.nodeDir, ...args], {
            cwd: this.options.nodeDir,
            env: { PATH: process.env.PATH, HOME: process.env.HOME && process.env.HOME !== '/' ? process.env.HOME : '/tmp', GIT_TERMINAL_PROMPT: '0' },
        });
        if (result.code !== 0 && !allowFailure) {
            // git explains itself on its fatal: or error: line; the lines after
            // it are generic advice.
            const lines = result.stderr.split('\n').map(l => l.trim()).filter(Boolean);
            const message = lines.find(l => /^(fatal|error):/.test(l)) ?? lines[0] ?? `git ${args[0]} exited with code ${result.code}`;
            throw new ConfigError(message.replace(/^(fatal|error):\s*/, ''), 500);
        }
        return result.code === 0 ? result.stdout.trim() : '';
    }

    async channel(): Promise<Channel> {
        try {
            const saved = JSON.parse(await fs.readFile(join(this.options.dataDir, SETTINGS_FILE), 'utf-8'));
            return saved.channel === 'main' ? 'main' : 'release';
        }
        catch {
            return 'release';
        }
    }

    async setChannel(channel: unknown): Promise<void> {
        if (channel !== 'release' && channel !== 'main') {
            throw new ConfigError('The channel is release or main');
        }
        await fs.mkdir(this.options.dataDir, { recursive: true });
        await fs.writeFile(join(this.options.dataDir, SETTINGS_FILE), JSON.stringify({ channel }), { mode: 0o600 });
    }

    private async isAncestor(older: string, newer: string): Promise<boolean> {
        const result = await this.options.exec('git', ['-C', this.options.nodeDir, 'merge-base', '--is-ancestor', older, newer], { cwd: this.options.nodeDir, env: { PATH: process.env.PATH } });
        return result.code === 0;
    }

    private async commitsBetween(from: string, to: string): Promise<Commit[]> {
        const out = await this.git(['log', '--format=%h%x09%s', `${from}..${to}`]);
        return out ? out.split('\n').map(line => {
            const [sha, ...subject] = line.split('\t');
            return { sha, subject: subject.join('\t') };
        }) : [];
    }

    // The newest release tag, by version order.
    private async latestRelease(): Promise<string | null> {
        const tags = await this.git(['tag', '--list', 'v*', '--sort=-v:refname']);
        return tags.split('\n').find(Boolean) ?? null;
    }

    private async statefulBuilt(): Promise<string[]> {
        const config = await this.options.nodeConfig.composeConfig();
        return Object.entries(config.services).filter(([name, def]) => def.build && isStateful(name)).map(([name]) => name).sort();
    }

    async status(fetch: boolean): Promise<UpdateStatus> {
        const channel = await this.channel();
        let fetchError: string | null = null;
        if (fetch) {
            try {
                await this.git(['fetch', '--tags', '--quiet', REMOTE]);
            }
            catch (error) {
                fetchError = error instanceof Error ? error.message : String(error);
            }
        }

        const commit = await this.git(['rev-parse', '--short', 'HEAD']);
        const describe = await this.git(['describe', '--tags', '--always']);
        const branch = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], true) || null;
        const dirty = (await this.git(['diff', '--name-only', 'HEAD'])).split('\n').filter(Boolean);

        let target: UpdateStatus['target'] = null;
        let commits: Commit[] = [];
        let note: string | null = null;

        if (channel === 'release') {
            const tag = await this.latestRelease();
            if (!tag) {
                note = 'No release tags found.';
            }
            else if (await this.isAncestor(tag, 'HEAD')) {
                const tagCommit = await this.git(['rev-parse', '--short', `${tag}^{commit}`]);
                note = tagCommit === commit ? null : `This node runs ${describe}, newer than the latest release ${tag}. The next release will be offered when it is tagged.`;
            }
            else {
                target = { ref: tag, label: tag, commit: await this.git(['rev-parse', '--short', `${tag}^{commit}`]) };
                commits = await this.commitsBetween('HEAD', tag);
            }
        }
        else {
            const ref = `${REMOTE}/main`;
            const remote = await this.git(['rev-parse', '--short', '--verify', '--quiet', ref], true);
            if (!remote) {
                note = `No ${ref} to follow.`;
            }
            else if (remote === commit || await this.isAncestor(ref, 'HEAD')) {
                note = null;
            }
            else if (!(await this.isAncestor('HEAD', ref))) {
                note = `This node's checkout has commits that ${ref} does not, so it cannot be fast-forwarded.`;
            }
            else {
                target = { ref, label: `main at ${remote}`, commit: remote };
                commits = await this.commitsBetween('HEAD', ref);
            }
        }

        return {
            channel,
            current: { commit, describe, branch },
            target,
            commits,
            note,
            dirty,
            statefulBuilt: await this.statefulBuilt(),
            load: { load1: (this.options.loadAverage ?? (() => os.loadavg()[0]))(), cores: (this.options.cpuCount ?? (() => os.cpus().length))() },
            fetchError,
        };
    }

    private async checkout(status: UpdateStatus, log: JobLog): Promise<void> {
        const run = async (args: string[]) => {
            log(`$ git ${args.join(' ')}`);
            const out = await this.git(args);
            out.split('\n').filter(Boolean).forEach(log);
        };
        if (status.channel === 'release') {
            await run(['checkout', '--detach', status.target!.ref]);
            return;
        }
        if (status.current.branch !== 'main') {
            const hasMain = await this.git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], true);
            await run(hasMain ? ['checkout', 'main'] : ['checkout', '-b', 'main', '--track', `${REMOTE}/main`]);
        }
        await run(['merge', '--ff-only', `${REMOTE}/main`]);
    }

    // Replaces node-runner's own container from a short-lived helper, since a
    // container cannot recreate itself while serving the request. The helper
    // runs ./node-runner from the node directory as the same user, so it sees
    // exactly what the operator's own `./node-runner up -d --build` would.
    private async updateSelf(log: JobLog): Promise<void> {
        const gid = statSync('/var/run/docker.sock').gid;
        const args = [
            'run', '--rm', '--detach', '--name', UPDATER_NAME,
            '--user', `${process.getuid!()}:${process.getgid!()}`, '--group-add', String(gid),
            '--env', 'HOME=/tmp',
            '--volume', '/var/run/docker.sock:/var/run/docker.sock',
            '--volume', `${this.options.nodeDir}:${this.options.nodeDir}`,
            '--workdir', this.options.nodeDir,
            '--entrypoint', './node-runner',
            this.options.selfImage, 'up', '-d', '--build',
        ];
        log(`$ docker ${args.join(' ')}`);
        const result = await this.options.exec('docker', args, { cwd: this.options.nodeDir, env: { PATH: process.env.PATH, HOME: '/tmp' } });
        if (result.code !== 0) {
            throw new Error(`Could not start the node-runner updater: ${result.stderr.trim()}`);
        }
        log('node-runner is rebuilding itself and will restart in a few minutes; this page reconnects when it is back.');
    }

    async run(confirmStateful: boolean): Promise<{ title: string, work: (log: JobLog) => Promise<void> }> {
        const status = await this.status(true);
        if (status.fetchError) {
            throw new ConfigError(`Could not fetch updates: ${status.fetchError}`, 502);
        }
        if (status.dirty.length) {
            throw new ConfigError(`Tracked files have local changes: ${status.dirty.join(', ')}. Commit or discard them first.`, 409);
        }
        if (!status.target) {
            throw new ConfigError(status.note ?? 'Already up to date', 409);
        }
        const { nodeConfig } = this.options;
        const from = await this.git(['rev-parse', 'HEAD']);
        return {
            title: `Update to ${status.target.label}`,
            work: async log => {
                log(`Updating from ${status.current.describe} to ${status.target!.label} (${status.commits.length} commits)`);
                await this.checkout(status, log);

                await nodeConfig.waitForLoad(log);
                await nodeConfig.runCompose(['build'], log);

                const { plan } = await nodeConfig.preview({});
                const touched = [...plan.create, ...plan.recreate, ...plan.start];
                const stateful = plan.recreate.filter(s => s.stateful).map(s => s.service);
                if (stateful.length && !confirmStateful) {
                    log(`Built. ${stateful.join(', ')} would be recreated, which needs your confirmation:`);
                    log('nothing was restarted. Review "Start node" on Overview to finish the update.');
                }
                else if (touched.length) {
                    await nodeConfig.runCompose(['up', '-d'], log);
                    await nodeConfig.verify(touched.map(s => s.service), log);
                }
                else {
                    log('No container needed recreating.');
                }

                const changedSelf = await this.git(['diff', '--name-only', from, 'HEAD', '--', ...SELF_PATHS]);
                if (changedSelf) {
                    await this.updateSelf(log);
                }
                log('Done.');
            },
        };
    }
}
