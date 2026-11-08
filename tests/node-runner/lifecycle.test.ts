import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../../services/node-runner/server/src/app.ts';
import { Auth } from '../../services/node-runner/server/src/auth.ts';
import { JobRunner } from '../../services/node-runner/server/src/jobs.ts';
import { Lifecycle, parseActionRequest, type ActionRequest } from '../../services/node-runner/server/src/lifecycle.ts';
import { NodeConfig } from '../../services/node-runner/server/src/node-config.ts';
import { FakeCompose, FakeDocker } from './helpers.ts';

let nodeDir: string;
let compose: FakeCompose;
let docker: FakeDocker;
let lifecycle: Lifecycle;

beforeEach(() => {
    nodeDir = mkdtempSync(join(tmpdir(), 'node-runner-life-'));
    mkdirSync(join(nodeDir, 'data', 'node-runner'), { recursive: true });
    writeFileSync(join(nodeDir, 'sample.env'), '');
    writeFileSync(join(nodeDir, '.env'), 'NODE=1\n');
    compose = new FakeCompose(nodeDir, { gatekeeper: {}, redis: {}, 'cln-mainnet-node': {}, 'lnbits-init': {}, grafana: {} });
    docker = new FakeDocker([
        { service: 'gatekeeper', hash: compose.currentHash('gatekeeper') },
        { service: 'redis', hash: compose.currentHash('redis') },
        { service: 'cln-mainnet-node', hash: compose.currentHash('cln-mainnet-node') },
        { service: 'lnbits-init', hash: compose.currentHash('lnbits-init'), inspect: { State: { Status: 'exited', Running: false, ExitCode: 0 } } },
        { service: 'grafana', hash: compose.currentHash('grafana'), inspect: { State: { Status: 'exited', Running: false, ExitCode: 0 } } },
    ]);
    // start, restart and up leave the containers they act on running; an
    // init container runs to completion.
    compose.onCommand = args => {
        if (!['start', 'restart', 'up'].includes(args[0])) {
            return;
        }
        const named = args.slice(1).filter(a => !a.startsWith('-'));
        for (const c of docker.containers.filter(c => !named.length || named.includes(c.service))) {
            c.inspect = c.service.endsWith('-init')
                ? { State: { Status: 'exited', Running: false, ExitCode: 0 } }
                : { State: { Status: 'running', Running: true } };
        }
    };
    const nodeConfig = new NodeConfig({ nodeDir, dataDir: join(nodeDir, 'data', 'node-runner'), project: 'archon', compose, docker, healthTimeoutMs: 0, sleep: async () => {}, loadAverage: () => 0, cpuCount: () => 4 });
    lifecycle = new Lifecycle({ project: 'archon', docker, nodeConfig });
});

afterEach(() => {
    rmSync(nodeDir, { recursive: true, force: true });
});

async function run(req: ActionRequest, confirm = false): Promise<string[]> {
    const { work } = await lifecycle.run(req, confirm);
    const lines: string[] = [];
    await work(line => lines.push(line));
    return lines;
}

describe('parseActionRequest', () => {
    it('accepts the three actions, for a service or the whole node', () => {
        expect(parseActionRequest({ action: 'restart', service: 'gatekeeper' })).toEqual({ action: 'restart', service: 'gatekeeper' });
        expect(parseActionRequest({ action: 'stop', down: true })).toEqual({ action: 'stop', down: true });
    });

    it('refuses anything else', () => {
        expect(() => parseActionRequest({ action: 'kill' })).toThrow('Unknown action: kill');
        expect(() => parseActionRequest({ action: 'stop', service: 'x; rm -rf /' })).toThrow('Not a valid service name');
        expect(() => parseActionRequest({ action: 'stop', service: 'redis', down: true })).toThrow('Only stopping the whole node');
        expect(() => parseActionRequest({ action: 'start', down: true })).toThrow('Only stopping the whole node');
    });
});

describe('one service', () => {
    it('restarts it and checks its health', async () => {
        const preview = await lifecycle.preview({ action: 'restart', service: 'gatekeeper' });
        expect(preview).toMatchObject({ title: 'Restart gatekeeper', command: 'docker compose restart gatekeeper', stateful: [], empty: false });

        const lines = await run({ action: 'restart', service: 'gatekeeper' });
        expect(compose.commands).toEqual([['restart', 'gatekeeper']]);
        expect(lines).toContain('  gatekeeper: running');
    });

    it('treats a Bitcoin node as stateful', async () => {
        docker.containers.push({ service: 'btc-signet-node' });

        expect((await lifecycle.preview({ action: 'stop', service: 'btc-signet-node' })).stateful).toEqual(['btc-signet-node']);
        expect((await lifecycle.preview({ action: 'restart' })).stateful).toContain('btc-signet-node');
    });

    it('needs confirmation to stop a stateful one', async () => {
        await expect(lifecycle.run({ action: 'stop', service: 'cln-mainnet-node' }, false)).rejects.toMatchObject({ status: 409 });

        await run({ action: 'stop', service: 'cln-mainnet-node' }, true);
        expect(compose.commands).toEqual([['stop', 'cln-mainnet-node']]);
    });

    it('starts a stopped one, and has nothing to do for one already running', async () => {
        await run({ action: 'start', service: 'grafana' });
        expect(compose.commands).toEqual([['start', 'grafana']]);

        expect((await lifecycle.preview({ action: 'start', service: 'gatekeeper' })).empty).toBe(true);
        await expect(lifecycle.run({ action: 'start', service: 'gatekeeper' }, false)).rejects.toMatchObject({ status: 409, message: 'Nothing to do' });
    });

    it('restarts a stopped one, which starts it', async () => {
        await run({ action: 'restart', service: 'grafana' });
        expect(compose.commands).toEqual([['restart', 'grafana']]);
    });

    it('marks an init container as one-shot', async () => {
        expect((await lifecycle.preview({ action: 'start', service: 'lnbits-init' })).services).toEqual([{ service: 'lnbits-init', stateful: false, oneShot: true }]);
    });

    it('names a service with no container', async () => {
        await expect(lifecycle.preview({ action: 'start', service: 'herald' })).rejects.toMatchObject({ status: 404 });
    });
});

describe('the whole node', () => {
    it('lists, checks and confirms a running service that only needs its image rebuilt', async () => {
        docker.missingImages.add('archon-redis');
        (compose as unknown as { services: Record<string, object> }).services.redis = { buildVars: [] };

        const preview = await lifecycle.preview({ action: 'start' });
        expect(preview.services.map(s => s.service)).toEqual(['grafana', 'lnbits-init', 'redis']);
        expect(preview.stateful).toEqual(['redis']);
        await expect(lifecycle.run({ action: 'start' }, false)).rejects.toMatchObject({ status: 409 });

        const lines = await run({ action: 'start' }, true);
        expect(compose.commands).toEqual([['build', 'redis'], ['up', '-d', '--no-build']]);
        expect(lines).toContain('  redis: running');
    });

    it('keeps each start\'s build targets to itself when previews overlap', async () => {
        (compose as unknown as { services: Record<string, object> }).services.gatekeeper = { buildVars: [] };
        docker.missingImages.add('archon-gatekeeper');
        const first = await lifecycle.run({ action: 'start' }, true);
        // A second preview, made after the image appeared, plans no build.
        docker.missingImages.delete('archon-gatekeeper');
        const second = await lifecycle.run({ action: 'start' }, true);
        await first.work(() => {});
        expect(compose.commands[0]).toEqual(['build', 'gatekeeper']);
        compose.commands.length = 0;
        await second.work(() => {});
        expect(compose.commands[0]).toEqual(['up', '-d', '--no-build']);
    });

    it('stops with stop, keeping its containers, after confirmation for stateful services', async () => {
        const preview = await lifecycle.preview({ action: 'stop' });
        expect(preview.services.map(s => s.service)).toEqual(['cln-mainnet-node', 'gatekeeper', 'redis']);
        expect(preview.stateful).toEqual(['cln-mainnet-node', 'redis']);
        expect(preview.command).toBe('docker compose stop');

        await run({ action: 'stop' }, true);
        expect(compose.commands).toEqual([['stop']]);
    });

    it('runs down only when asked', async () => {
        const preview = await lifecycle.preview({ action: 'stop', down: true });
        expect(preview).toMatchObject({ title: 'Stop the node and remove its containers', command: 'docker compose down' });

        await run({ action: 'stop', down: true }, true);
        expect(compose.commands).toEqual([['down']]);
    });

    it('starts with up -d, showing what it will start', async () => {
        const preview = await lifecycle.preview({ action: 'start' });
        expect(preview.services.map(s => s.service)).toEqual(['grafana', 'lnbits-init']);

        await run({ action: 'start' });
        expect(compose.commands).toEqual([['up', '-d', '--no-build']]);
    });

    it('builds a missing image under the load check before starting', async () => {
        docker.missingImages.add('archon-gatekeeper');
        (compose as unknown as { services: Record<string, object> }).services.gatekeeper = { buildVars: [] };

        await run({ action: 'start' });
        expect(compose.commands).toEqual([['build', 'gatekeeper'], ['up', '-d', '--no-build']]);
    });

    it('restarts only what is active, named, so stopped containers stay stopped', async () => {
        const preview = await lifecycle.preview({ action: 'restart' });
        expect(preview.command).toBe('docker compose stop cln-mainnet-node gatekeeper redis && docker compose up -d --no-build --no-recreate cln-mainnet-node gatekeeper redis');

        // Stop, then up, which starts them in dependency order: restart would
        // bring them all back at once, ignoring depends_on.
        await run({ action: 'restart' }, true);
        expect(compose.commands).toEqual([
            ['stop', 'cln-mainnet-node', 'gatekeeper', 'redis'],
            ['up', '-d', '--no-build', '--no-recreate', 'cln-mainnet-node', 'gatekeeper', 'redis'],
        ]);
    });

    it('lists, checks and confirms a stopped dependency that up would start', async () => {
        // gatekeeper depends on mongodb, which is enabled but stopped.
        const services = (compose as unknown as { services: Record<string, object> }).services;
        services.gatekeeper = { dependsOn: ['redis', 'mongodb'] };
        services.mongodb = {};
        docker.containers.push({ service: 'mongodb', inspect: { State: { Status: 'exited', Running: false, ExitCode: 0 } } });
        // Like Compose, up starts the dependencies of what it is given.
        const startNamed = compose.onCommand!;
        compose.onCommand = args => {
            startNamed(args);
            if (args[0] === 'up') {
                docker.containers.find(c => c.service === 'mongodb')!.inspect = { State: { Status: 'running', Running: true } };
            }
        };

        const preview = await lifecycle.preview({ action: 'restart' });
        expect(preview.services.map(s => s.service)).toEqual(['cln-mainnet-node', 'gatekeeper', 'mongodb', 'redis']);
        expect(preview.stateful).toEqual(['cln-mainnet-node', 'mongodb', 'redis']);
        expect(preview.command).toMatch(/also starts mongodb, which is a dependency/);

        const lines = await run({ action: 'restart' }, true);
        expect(compose.commands).toEqual([
            ['stop', 'cln-mainnet-node', 'gatekeeper', 'redis'],
            ['up', '-d', '--no-build', '--no-recreate', 'cln-mainnet-node', 'gatekeeper', 'redis'],
        ]);
        expect(lines).toContain('  mongodb: running');
    });

    it('counts restarting and paused containers as active', async () => {
        docker.containers.find(c => c.service === 'gatekeeper')!.inspect = { State: { Status: 'restarting', Running: true, Restarting: true } };
        docker.containers.find(c => c.service === 'redis')!.inspect = { State: { Status: 'paused', Running: true } };

        const preview = await lifecycle.preview({ action: 'stop' });
        expect(preview.services.map(s => s.service)).toEqual(['cln-mainnet-node', 'gatekeeper', 'redis']);
        expect(preview.stateful).toEqual(['cln-mainnet-node', 'redis']);
        expect((await lifecycle.preview({ action: 'stop', service: 'gatekeeper' })).empty).toBe(false);
        expect((await lifecycle.preview({ action: 'start', service: 'gatekeeper' })).empty).toBe(true);
    });
});

describe('actions API', () => {
    it('previews and runs an action as a job', async () => {
        const dataDir = join(nodeDir, 'data', 'node-runner');
        const auth = new Auth({ dataDir, log: () => {}, failureDelayMs: 0 });
        const jobs = new JobRunner(dataDir);
        const app = createApp({ auth, docker, project: 'archon', gitCommit: 'x', jobs, lifecycle, nodeConfig: new NodeConfig({ nodeDir, dataDir, project: 'archon', compose, docker, loadAverage: () => 0, cpuCount: () => 4 }) });
        const code = await auth.ensureSetupCode();
        const setup = await request(app).post('/api/setup').send({ code, password: 'correct horse battery' });
        const cookie = (setup.headers['set-cookie'] as unknown as string[])[0].split(';')[0];

        await request(app).post('/api/actions/preview').send({ action: 'stop' }).expect(401);
        const preview = await request(app).post('/api/actions/preview').set('Cookie', cookie).send({ action: 'stop', service: 'redis' }).expect(200);
        expect(preview.body.stateful).toEqual(['redis']);
        await request(app).post('/api/actions/run').set('Cookie', cookie).send({ action: 'stop', service: 'redis' }).expect(409);
        await request(app).post('/api/actions/run').set('Cookie', cookie).send({ action: 'jump' }).expect(400);

        const started = await request(app).post('/api/actions/run').set('Cookie', cookie).send({ action: 'stop', service: 'redis', confirmStateful: true }).expect(202);
        for (;;) {
            const job = await request(app).get(`/api/jobs/${started.body.id}`).set('Cookie', cookie);
            if (job.body.status !== 'running') {
                expect(job.body).toMatchObject({ title: 'Stop redis', status: 'succeeded' });
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(compose.commands).toEqual([['stop', 'redis']]);
    });
});
