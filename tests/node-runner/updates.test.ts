import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec, type Exec } from '../../services/node-runner/server/src/compose.ts';
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
    const dataDir = join(nodeDir, 'data', 'node-runner');
    const nodeConfig = new NodeConfig({ nodeDir, dataDir, project: 'archon', compose, docker, healthTimeoutMs: 0, sleep: async () => {}, loadAverage: () => 0, cpuCount: () => 4 });
    updates = new Updates({ nodeDir, dataDir, nodeConfig, exec: mixedExec, selfImage: 'ghcr.io/archetech/node-runner', loadAverage: () => 0.5, cpuCount: () => 4 });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

async function run(confirm = false): Promise<string[]> {
    const { work } = await updates.run(confirm);
    const lines: string[] = [];
    await work(line => lines.push(line));
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
        expect(status.statefulBuilt).toEqual(['cln-mainnet-node']);
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

        const lines = await run(false);

        expect(compose.commands).toEqual([['build']]);
        expect(lines).toContain('Built. cln-mainnet-node would be recreated, which needs your confirmation:');
    });

    it('restarts it when confirmed', async () => {
        upstreamCommit(upstream, 'a.txt', 'second release', 'v0.2.0');
        docker.images.set('archon-cln-mainnet-node', 'sha:cln:new');

        await run(true);

        expect(compose.commands).toEqual([['build'], ['up', '-d']]);
    });

    it('refuses to run over local changes, or with nothing to update to', async () => {
        await expect(updates.run(false)).rejects.toMatchObject({ status: 409 });

        upstreamCommit(upstream, 'a.txt', 'second release', 'v0.2.0');
        writeFileSync(join(nodeDir, 'README'), 'edited\n');
        await expect(updates.run(false)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('README') });
    });

    it('replaces node-runner from a helper when its own files changed', async () => {
        upstreamCommit(upstream, 'services/node-runner/server/src/x.ts', 'node-runner change', 'v0.2.0');

        const lines = await run();

        expect(dockerCalls).toHaveLength(1);
        const args = dockerCalls[0];
        expect(args.slice(0, 5)).toEqual(['run', '--rm', '--detach', '--name', 'archon-node-runner-updater']);
        expect(args).toContain(`${nodeDir}:${nodeDir}`);
        expect(args.slice(-4)).toEqual(['ghcr.io/archetech/node-runner', 'up', '-d', '--build']);
        expect(lines.at(-2)).toMatch(/rebuilding itself/);
        expect(readFileSync(join(nodeDir, 'services/node-runner/server/src/x.ts'), 'utf-8')).toBe('node-runner change\n');
    });
});
