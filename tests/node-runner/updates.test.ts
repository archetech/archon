import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec, type Exec } from '../../services/node-runner/server/src/compose.ts';
import { JobRunner } from '../../services/node-runner/server/src/jobs.ts';
import { NodeConfig } from '../../services/node-runner/server/src/node-config.ts';
import { Updates } from '../../services/node-runner/server/src/updates.ts';
import { FakeCompose, FakeDocker } from './helpers.ts';

let root: string;
let origin: string;
let nodeDir: string;
let compose: FakeCompose;
let docker: FakeDocker;
let dockerCalls: string[][];
let updates: Updates;
let dataDir: string;
// What the self-update helper writes: its output and exit status.
let helper: { log: string, status: string | null };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

// A commit in the upstream repository, pushed to origin.
function upstreamCommit(work: string, file: string, message: string, tag?: string): void {
    mkdirSync(join(work, file, '..'), { recursive: true });
    writeFileSync(join(work, file), `${message}\n`);
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', message);
    if (tag) {
        git(work, 'tag', tag);
    }
    git(work, 'push', '-q', '--tags', 'origin', 'main');
}

// git really runs; docker is recorded.
const mixedExec: Exec = async (command, args, options) => {
    if (command === 'git') {
        return exec(command, args, options);
    }
    dockerCalls.push(args);
    if (args[0] === 'run') {
        writeFileSync(join(dataDir, 'self-update.log'), helper.log);
        if (helper.status !== null) {
            writeFileSync(join(dataDir, 'self-update.status'), `${helper.status}\n`);
        }
    }
    return { code: 0, stdout: '', stderr: '' };
};

let upstream: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'node-runner-updates-'));
    origin = join(root, 'origin.git');
    upstream = join(root, 'upstream');
    nodeDir = join(root, 'node');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, upstream);
    git(upstream, 'checkout', '-q', '-b', 'main');
    writeFileSync(join(upstream, '.gitignore'), '.env\ndata/\n');
    upstreamCommit(upstream, 'README', 'first release', 'v0.1.0');
    git(root, 'clone', '-q', origin, nodeDir);
    git(nodeDir, 'checkout', '-q', '--detach', 'v0.1.0');

    writeFileSync(join(nodeDir, '.env'), 'X=1\n');
    writeFileSync(join(nodeDir, 'sample.env'), '');
    mkdirSync(join(nodeDir, 'data', 'node-runner'), { recursive: true });
    compose = new FakeCompose(nodeDir, { gatekeeper: { buildVars: [] }, 'cln-mainnet-node': { buildVars: [] }, redis: {} });
    docker = new FakeDocker(['gatekeeper', 'cln-mainnet-node', 'redis'].map(service => ({
        service, hash: compose.currentHash(service), imageId: `sha:${service}:old`,
    })));
    dockerCalls = [];
    helper = { log: 'Building node-runner\nContainer recreated\n', status: '0' };
    dataDir = join(nodeDir, 'data', 'node-runner');
    const nodeConfig = new NodeConfig({ nodeDir, dataDir, project: 'archon', compose, docker, healthTimeoutMs: 0, sleep: async () => {}, loadAverage: () => 0, cpuCount: () => 4 });
    updates = new Updates({ nodeDir, dataDir, nodeConfig, exec: mixedExec, selfImage: 'ghcr.io/archetech/node-runner', loadAverage: () => 0.5, cpuCount: () => 4, sleep: async () => {} });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

async function run(confirm: string[] = []): Promise<string[]> {
    const { work } = await updates.run(confirm);
    const lines: string[] = [];
    await work(line => lines.push(line), 'job-1');
    return lines;
}

describe('channel', () => {
    it('defaults to releases and remembers a choice', async () => {
        expect(await updates.channel()).toBe('release');
        await updates.setChannel('main');
        expect(await updates.channel()).toBe('main');
        await expect(updates.setChannel('nightly')).rejects.toMatchObject({ status: 400 });
    });
});

describe('status', () => {
    it('offers the newest release with the commits it brings', async () => {
        upstreamCommit(upstream, 'a.txt', 'fix one');
        upstreamCommit(upstream, 'b.txt', 'second release', 'v0.2.0');
        upstreamCommit(upstream, 'c.txt', 'unreleased work');

        const status = await updates.status(true);

        expect(status.target).toMatchObject({ ref: 'v0.2.0', label: 'v0.2.0' });
        expect(status.commits.map(c => c.subject)).toEqual(['second release', 'fix one']);
        expect(status.current).toMatchObject({ describe: 'v0.1.0', branch: null });
        expect(status.statefulAtRisk).toEqual(['cln-mainnet-node']);
        expect(status.load).toEqual({ load1: 0.5, cores: 4 });
    });

    it('offers nothing when the node is newer than the latest release', async () => {
        upstreamCommit(upstream, 'a.txt', 'unreleased work');
        git(nodeDir, 'fetch', '-q', 'origin');
        git(nodeDir, 'checkout', '-q', 'origin/main');

        const status = await updates.status(false);

        expect(status.target).toBeNull();
        expect(status.note).toMatch(/newer than the latest release v0\.1\.0/);
    });

    it('follows main on the main channel', async () => {
        await updates.setChannel('main');
        upstreamCommit(upstream, 'a.txt', 'on main');

        const status = await updates.status(true);

        expect(status.target).toMatchObject({ ref: 'origin/main' });
        expect(status.commits.map(c => c.subject)).toEqual(['on main']);
    });

    it('lists tracked files changed locally', async () => {
        writeFileSync(join(nodeDir, 'README'), 'edited\n');

        expect((await updates.status(false)).dirty).toEqual(['README']);
    });

    it('reports a failed fetch', async () => {
        git(nodeDir, 'remote', 'set-url', 'origin', join(root, 'missing.git'));

        expect((await updates.status(true)).fetchError).toMatch(/does not appear to be a git repository/);
    });
});

describe('run', () => {
    it('checks out the release, builds, and recreates what changed', async () => {
        upstreamCommit(upstream, 'a.txt', 'second release', 'v0.2.0');
        docker.images.set('archon-gatekeeper', 'sha:gatekeeper:new');

        const lines = await run();

        expect(git(nodeDir, 'describe', '--tags')).toBe('v0.2.0');
        expect(compose.commands).toEqual([['build'], ['up', '-d']]);
        expect(lines).toContain('  gatekeeper: running');
        expect(dockerCalls).toEqual([]);
    });

    it('fast-forwards main on the main channel', async () => {
        await updates.setChannel('main');
        upstreamCommit(upstream, 'a.txt', 'on main');

        await run();

        expect(git(nodeDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
        expect(git(nodeDir, 'log', '-1', '--format=%s')).toBe('on main');
    });

    it('builds but does not restart a stateful service without confirmation', async () => {
        upstreamCommit(upstream, 'a.txt', 'second release', 'v0.2.0');
        docker.images.set('archon-cln-mainnet-node', 'sha:cln:new');

        const lines = await run([]);

        expect(compose.commands).toEqual([['build']]);
        expect(lines).toContain('Built. Recreating cln-mainnet-node needs your confirmation, so nothing was restarted.');

        // The update is unfinished, and running it again with consent finishes it.
        const status = await updates.status(false);
        expect(status).toMatchObject({ unfinished: true, target: { label: 'v0.2.0' } });
        await run(['cln-mainnet-node']);
        expect(compose.commands).toEqual([['build'], ['build'], ['up', '-d']]);
        expect((await updates.status(false)).unfinished).toBe(false);
    });

    it('restarts it when confirmed', async () => {
        upstreamCommit(upstream, 'a.txt', 'second release', 'v0.2.0');
        docker.images.set('archon-cln-mainnet-node', 'sha:cln:new');

        await run(['cln-mainnet-node']);

        expect(compose.commands).toEqual([['build'], ['up', '-d']]);
    });

    it('refuses to run over local changes, or with nothing to update to', async () => {
        await expect(updates.run([])).rejects.toMatchObject({ status: 409 });

        upstreamCommit(upstream, 'a.txt', 'second release', 'v0.2.0');
        writeFileSync(join(nodeDir, 'README'), 'edited\n');
        await expect(updates.run([])).rejects.toMatchObject({ status: 409, message: expect.stringContaining('README') });
    });

    it('only restarts the stateful services named in the consent', async () => {
        upstreamCommit(upstream, 'a.txt', 'second release', 'v0.2.0');
        docker.images.set('archon-cln-mainnet-node', 'sha:cln:new');
        docker.images.set('archon-redis', 'sha:redis:new');

        const lines = await run(['cln-mainnet-node', 'not-at-risk']);

        expect(compose.commands).toEqual([['build']]);
        expect(lines).toContain('Built. Recreating redis needs your confirmation, so nothing was restarted.');
    });

    it('can be finished after a failed build, at the same target', async () => {
        upstreamCommit(upstream, 'a.txt', 'second release', 'v0.2.0');
        compose.failing = 'build';
        const { work } = await updates.run([]);
        await expect(work(() => {}, 'job-1')).rejects.toThrow('docker compose build exited with code 1');

        const status = await updates.status(false);
        expect(status).toMatchObject({ unfinished: true, target: { label: 'v0.2.0' } });
        expect((await updates.run([])).title).toBe('Finish the update to v0.2.0');

        compose.failing = null;
        await run();
        expect((await updates.status(false))).toMatchObject({ unfinished: false, target: null });
    });

    it('replaces node-runner from a helper and settles on the helper\'s exit status', async () => {
        upstreamCommit(upstream, 'services/node-runner/server/src/x.ts', 'node-runner change', 'v0.2.0');

        const lines = await run();

        expect(dockerCalls).toHaveLength(1);
        const args = dockerCalls[0];
        expect(args.slice(0, 5)).toEqual(['run', '--rm', '--detach', '--name', 'archon-node-runner-updater']);
        expect(args).toContain(`${nodeDir}:${nodeDir}`);
        expect(args.at(-1)).toBe(dataDir);
        expect(lines).toContain('│ Container recreated');
        expect(lines.slice(-2)).toEqual(['node-runner replaced itself.', 'Done.']);
        expect((await updates.status(false)).unfinished).toBe(false);
    });

    it('fails the job when the helper fails', async () => {
        upstreamCommit(upstream, 'services/node-runner/server/src/x.ts', 'node-runner change', 'v0.2.0');
        helper = { log: 'build failed\n', status: '1' };

        const { work } = await updates.run([]);
        const lines: string[] = [];

        await expect(work(line => lines.push(line), 'job-1')).rejects.toThrow('Replacing node-runner failed (exit 1)');
        expect(lines).toContain('│ build failed');
    });

    it('lets the replacement node-runner take the job over and finish it', async () => {
        upstreamCommit(upstream, 'services/node-runner/server/src/x.ts', 'node-runner change', 'v0.2.0');
        const jobs = new JobRunner(dataDir);
        // The helper is still running when this process is replaced.
        helper = { log: 'Building node-runner\n', status: null };
        // The old process waits until it is replaced, which ends its wait.
        let replace!: () => void;
        const replaced = new Promise<void>(resolve => { replace = resolve; });
        const old = new Updates({
            nodeDir, dataDir, exec: mixedExec, selfImage: 'img',
            nodeConfig: (updates as unknown as { options: { nodeConfig: NodeConfig } }).options.nodeConfig,
            sleep: () => replaced.then(() => { throw new Error('process replaced'); }),
        });
        const { title, work } = await old.run([]);
        const { job, done } = await jobs.start(title, work);
        while (!(await jobs.get(job.id))!.lines.some(l => l.text === '│ Building node-runner')) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        replace();
        await done;
        // The replaced process never got to record anything, so its job is
        // still marked running on disk.
        const record = JSON.parse(readFileSync(join(dataDir, 'jobs.json'), 'utf-8'));
        record[0] = { ...record[0], status: 'running', error: null, finishedAt: null };
        writeFileSync(join(dataDir, 'jobs.json'), JSON.stringify(record));

        // A new process finds the job left running and the helper's result.
        writeFileSync(join(dataDir, 'self-update.log'), 'Building node-runner\nContainer recreated\n');
        writeFileSync(join(dataDir, 'self-update.status'), '0\n');
        const restarted = new JobRunner(dataDir);
        await updates.resume(restarted);
        let settled = await restarted.get(job.id);
        while (settled!.status === 'running') {
            await new Promise(resolve => setTimeout(resolve, 5));
            settled = await restarted.get(job.id);
        }

        expect(settled!.status).toBe('succeeded');
        expect(settled!.lines.filter(l => l.text.startsWith('│ ')).map(l => l.text)).toEqual(['│ Building node-runner', '│ Container recreated']);
    });
});

describe('history and branches', () => {
    it('unshallows the installer\'s depth-1 clone before judging ancestry', async () => {
        upstreamCommit(upstream, 'a.txt', 'unreleased work');
        const shallowDir = join(root, 'shallow');
        git(root, 'clone', '-q', '--depth', '1', `file://${origin}`, shallowDir);
        writeFileSync(join(shallowDir, 'sample.env'), '');
        const shallow = new Updates({ nodeDir: shallowDir, dataDir: join(shallowDir, 'data'), nodeConfig: new NodeConfig({ nodeDir: shallowDir, dataDir: join(shallowDir, 'data'), project: 'archon', compose, docker }), exec: mixedExec, selfImage: 'img' });

        expect((await shallow.status(false)).note).toMatch(/shallow/);
        const status = await shallow.status(true);

        expect(git(shallowDir, 'rev-parse', '--is-shallow-repository')).toBe('false');
        expect(status.target).toBeNull();
        expect(status.note).toMatch(/newer than the latest release v0\.1\.0/);
    });

    it('refuses main when the local main has commits origin/main does not', async () => {
        await updates.setChannel('main');
        upstreamCommit(upstream, 'a.txt', 'on main');
        git(nodeDir, 'checkout', '-q', '-B', 'main', 'v0.1.0');
        writeFileSync(join(nodeDir, 'local.txt'), 'local\n');
        git(nodeDir, 'add', 'local.txt');
        git(nodeDir, 'commit', '-qm', 'local work');
        git(nodeDir, 'checkout', '-q', '--detach', 'v0.1.0');

        const status = await updates.status(true);

        expect(status.target).toBeNull();
        expect(status.note).toMatch(/local branch main has commits/);
    });
});
