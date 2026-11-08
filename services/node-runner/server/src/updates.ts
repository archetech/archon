import { promises as fs, statSync } from 'fs';
import os from 'os';
import { join } from 'path';
import type { Exec } from './compose.js';
import type { JobLog, JobRunner, JobWork } from './jobs.js';
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
    // An update that checked out its target but did not finish; running the
    // update again finishes it instead of looking for a newer one.
    unfinished: boolean;
    // Why no update is offered, when that is not simply "up to date".
    note: string | null;
    // Tracked files changed locally; an update refuses to run over them.
    dirty: string[];
    // Stateful services the update may recreate: those built from this
    // repository, and any already out of date. Each is restarted only if it
    // is named in the confirmation.
    statefulAtRisk: string[];
    load: { load1: number, cores: number };
    fetchError: string | null;
}

const SETTINGS_FILE = 'settings.json';
const PENDING_FILE = 'update.json';
const SELF_FILE = 'self-update.json';
const SELF_LOG = 'self-update.log';
const SELF_STATUS = 'self-update.status';
const SELF_TIMEOUT_MS = 30 * 60 * 1000;
// Lines copied from the helper's log into the job carry this prefix, so a
// node-runner that takes the job over knows how many it already has.
const HELPER_PREFIX = '│ ';

interface Pending {
    label: string;
    commit: string;
    from: string;
}
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
    sleep?: (ms: number) => Promise<void>;
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

    private async statefulAtRisk(): Promise<string[]> {
        const config = await this.options.nodeConfig.composeConfig();
        const built = Object.entries(config.services).filter(([name, def]) => def.build && isStateful(name)).map(([name]) => name);
        const { plan } = await this.options.nodeConfig.preview({});
        const stale = plan.recreate.filter(s => s.stateful).map(s => s.service);
        return [...new Set([...built, ...stale])].sort();
    }

    private path(name: string): string {
        return join(this.options.dataDir, name);
    }

    private async readJson<T>(name: string): Promise<T | null> {
        try {
            return JSON.parse(await fs.readFile(this.path(name), 'utf-8')) as T;
        }
        catch {
            return null;
        }
    }

    private async writeJson(name: string, value: unknown): Promise<void> {
        await fs.mkdir(this.options.dataDir, { recursive: true });
        await fs.writeFile(this.path(name), JSON.stringify(value), { mode: 0o600 });
    }

    async status(fetch: boolean): Promise<UpdateStatus> {
        const channel = await this.channel();
        let fetchError: string | null = null;
        // The installer clones with --depth 1. Ancestry is meaningless at a
        // shallow boundary, so the first fetch brings the full history.
        let shallow = (await this.git(['rev-parse', '--is-shallow-repository'])) === 'true';
        if (fetch) {
            try {
                await this.git(['fetch', '--tags', '--quiet', ...(shallow ? ['--unshallow'] : []), REMOTE]);
                shallow = false;
            }
            catch (error) {
                fetchError = error instanceof Error ? error.message : String(error);
            }
        }

        const commit = await this.git(['rev-parse', '--short', 'HEAD']);
        const full = await this.git(['rev-parse', 'HEAD']);
        const describe = await this.git(['describe', '--tags', '--always']);
        const branch = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], true) || null;
        const dirty = (await this.git(['diff', '--name-only', 'HEAD'])).split('\n').filter(Boolean);

        let target: UpdateStatus['target'] = null;
        let commits: Commit[] = [];
        let note: string | null = null;
        const pending = await this.readJson<Pending>(PENDING_FILE);
        const unfinished = !!pending && pending.commit === full;

        if (unfinished) {
            target = { ref: 'HEAD', label: pending!.label, commit };
            note = `The update to ${pending!.label} is checked out but not finished. Running the update finishes it.`;
        }
        else if (shallow) {
            note = 'This checkout is shallow; check for updates to fetch its history first.';
        }
        else if (channel === 'release') {
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
            const localMain = await this.git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], true);
            if (!remote) {
                note = `No ${ref} to follow.`;
            }
            else if (localMain && !(await this.isAncestor('refs/heads/main', ref))) {
                note = `The local branch main has commits that ${ref} does not, so updating would not build ${ref}.`;
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
            unfinished,
            note,
            dirty,
            statefulAtRisk: await this.statefulAtRisk(),
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
    // exactly what the operator's own `./node-runner up -d --build` would, and
    // writes its output and exit status to the data directory. The job stays
    // running until that status appears; the node-runner that replaces this
    // one takes the job over (resume) and settles it.
    private async updateSelf(jobId: string, log: JobLog): Promise<void> {
        await Promise.all([SELF_LOG, SELF_STATUS].map(name => fs.rm(this.path(name), { force: true })));
        await this.writeJson(SELF_FILE, { jobId });
        const gid = statSync('/var/run/docker.sock').gid;
        const data = this.options.dataDir;
        const script = `./node-runner up -d --build > "$1/${SELF_LOG}" 2>&1; echo $? > "$1/${SELF_STATUS}.tmp" && mv "$1/${SELF_STATUS}.tmp" "$1/${SELF_STATUS}"`;
        const args = [
            'run', '--rm', '--detach', '--name', UPDATER_NAME,
            '--user', `${process.getuid!()}:${process.getgid!()}`, '--group-add', String(gid),
            '--env', 'HOME=/tmp',
            '--volume', '/var/run/docker.sock:/var/run/docker.sock',
            '--volume', `${this.options.nodeDir}:${this.options.nodeDir}`,
            '--workdir', this.options.nodeDir,
            '--entrypoint', 'sh',
            this.options.selfImage, '-c', script, 'sh', data,
        ];
        log(`$ docker run … --name ${UPDATER_NAME} ${this.options.selfImage} ./node-runner up -d --build`);
        const result = await this.options.exec('docker', args, { cwd: this.options.nodeDir, env: { PATH: process.env.PATH, HOME: '/tmp' } });
        if (result.code !== 0) {
            await fs.rm(this.path(SELF_FILE), { force: true });
            throw new Error(`Could not start the node-runner updater: ${result.stderr.trim()}`);
        }
        log('node-runner is rebuilding itself and will restart; this page reconnects when it is back.');
        await this.awaitSelfUpdate(log, 0);
    }

    // Copies the helper's output into the job as it grows and settles the job
    // on the helper's exit status.
    private async awaitSelfUpdate(log: JobLog, copied: number): Promise<void> {
        const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
        const deadline = Date.now() + SELF_TIMEOUT_MS;
        const copy = async () => {
            const lines = (await fs.readFile(this.path(SELF_LOG), 'utf-8').catch(() => '')).split('\n').filter(Boolean);
            lines.slice(copied).forEach(line => log(HELPER_PREFIX + line));
            copied = Math.max(copied, lines.length);
        };
        for (;;) {
            await copy();
            const status = await fs.readFile(this.path(SELF_STATUS), 'utf-8').catch(() => null);
            if (status !== null) {
                await copy();
                await Promise.all([SELF_FILE, SELF_STATUS, SELF_LOG].map(name => fs.rm(this.path(name), { force: true })));
                if (status.trim() !== '0') {
                    throw new Error(`Replacing node-runner failed (exit ${status.trim()}); see the lines above`);
                }
                await fs.rm(this.path(PENDING_FILE), { force: true });
                log('node-runner replaced itself.');
                log('Done.');
                return;
            }
            if (Date.now() > deadline) {
                throw new Error('node-runner did not finish replacing itself in 30 minutes');
            }
            await sleep(2000);
        }
    }

    // Called at startup: takes over a self-update job that the previous
    // node-runner, which the helper replaced, left running.
    async resume(jobs: JobRunner): Promise<void> {
        const self = await this.readJson<{ jobId: string }>(SELF_FILE);
        if (!self) {
            return;
        }
        const job = await jobs.get(self.jobId);
        const copied = job?.lines.filter(l => l.text.startsWith(HELPER_PREFIX)).length ?? 0;
        const adopted = await jobs.adopt(self.jobId, log => this.awaitSelfUpdate(log, copied));
        if (!adopted) {
            await fs.rm(this.path(SELF_FILE), { force: true });
        }
    }

    // `confirmed` names the stateful services the operator agreed to restart.
    // Any other stateful service the update would recreate stops it after the
    // build, with the update left unfinished for a confirmed rerun.
    async run(confirmed: string[]): Promise<{ title: string, work: JobWork }> {
        const status = await this.status(true);
        if (status.fetchError && !status.unfinished) {
            throw new ConfigError(`Could not fetch updates: ${status.fetchError}`, 502);
        }
        if (status.dirty.length) {
            throw new ConfigError(`Tracked files have local changes: ${status.dirty.join(', ')}. Commit or discard them first.`, 409);
        }
        if (!status.target) {
            throw new ConfigError(status.note ?? 'Already up to date', 409);
        }
        const { nodeConfig } = this.options;
        const allowed = new Set(confirmed.filter(name => status.statefulAtRisk.includes(name)));
        const label = status.target.label;
        return {
            title: status.unfinished ? `Finish the update to ${label}` : `Update to ${label}`,
            work: async (log, jobId) => {
                let pending = await this.readJson<Pending>(PENDING_FILE);
                if (!status.unfinished) {
                    log(`Updating from ${status.current.describe} to ${label} (${status.commits.length} commits)`);
                    const from = await this.git(['rev-parse', 'HEAD']);
                    await this.checkout(status, log);
                    pending = { label, commit: await this.git(['rev-parse', 'HEAD']), from };
                    await this.writeJson(PENDING_FILE, pending);
                }
                else {
                    log(`Finishing the update to ${label}`);
                }

                await nodeConfig.waitForLoad(log);
                await nodeConfig.runCompose(['build'], log);

                const { plan } = await nodeConfig.preview({});
                const touched = [...plan.create, ...plan.recreate, ...plan.start];
                const unconfirmed = plan.recreate.filter(s => s.stateful && !allowed.has(s.service)).map(s => s.service);
                if (unconfirmed.length) {
                    log(`Built. Recreating ${unconfirmed.join(', ')} needs your confirmation, so nothing was restarted.`);
                    log('Confirm it on the Updates page and run the update again to finish.');
                    return;
                }
                if (touched.length) {
                    // Everything was built above, under the load check.
                    await nodeConfig.runCompose(['up', '-d', '--no-build'], log);
                    await nodeConfig.verify(touched.map(s => s.service), log);
                }
                else {
                    log('No container needed recreating.');
                }

                const changedSelf = pending && await this.git(['diff', '--name-only', pending.from, 'HEAD', '--', ...SELF_PATHS]);
                if (changedSelf) {
                    await this.updateSelf(jobId, log);
                    return;
                }
                await fs.rm(this.path(PENDING_FILE), { force: true });
                log('Done.');
            },
        };
    }
}
