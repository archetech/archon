import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../../services/node-runner/server/src/app.ts';
import { Auth } from '../../services/node-runner/server/src/auth.ts';
import { JobRunner } from '../../services/node-runner/server/src/jobs.ts';
import type { JobWork } from '../../services/node-runner/server/src/jobs.ts';
import type { Lifecycle } from '../../services/node-runner/server/src/lifecycle.ts';
import { ConfigError, NodeConfig } from '../../services/node-runner/server/src/node-config.ts';
import type { Updates } from '../../services/node-runner/server/src/updates.ts';
import { FakeCompose, FakeDocker } from './helpers.ts';

// The routes that start, stop and update the node. The lifecycle and the
// updater are replaced: each has its own tests, and what is checked here is
// what the routes pass them, what they answer, and that one job runs at a time.

const PASSWORD = 'correct horse battery';

let nodeDir: string;
let app: ReturnType<typeof createApp>;
let jobs: JobRunner;
let cookie: string;

const lifecycle = {
    preview: jest.fn<(request: unknown) => Promise<unknown>>(),
    run: jest.fn<(request: unknown, confirmStateful: boolean) => Promise<{ title: string; work: JobWork }>>(),
};
const updates = {
    status: jest.fn<(fetch: boolean) => Promise<unknown>>(),
    setChannel: jest.fn<(channel: unknown) => Promise<void>>(),
    run: jest.fn<(confirmed: string[]) => Promise<{ title: string; work: JobWork }>>(),
};

beforeEach(async () => {
    jest.resetAllMocks();
    nodeDir = mkdtempSync(join(tmpdir(), 'node-runner-actions-'));
    const dataDir = join(nodeDir, 'data', 'node-runner');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(nodeDir, 'sample.env'), 'ARCHON_NODE_NAME=mynode\n');
    writeFileSync(join(nodeDir, '.env'), 'ARCHON_NODE_NAME=alpha\n');
    const compose = new FakeCompose(nodeDir, { gatekeeper: { vars: ['ARCHON_NODE_NAME'] } });
    const docker = new FakeDocker([{ service: 'gatekeeper', hash: compose.currentHash('gatekeeper') }]);
    const auth = new Auth({ dataDir, log: () => {}, failureDelayMs: 0 });
    jobs = new JobRunner(dataDir);
    const nodeConfig = new NodeConfig({ nodeDir, dataDir, project: 'archon', compose, docker, healthTimeoutMs: 0, sleep: async () => {}, loadAverage: () => 0, cpuCount: () => 4 });
    app = createApp({
        auth, docker, project: 'archon', gitCommit: 'abc', nodeConfig, jobs,
        lifecycle: lifecycle as unknown as Lifecycle,
        updates: updates as unknown as Updates,
    });

    const code = await auth.ensureSetupCode();
    const res = await request(app).post('/api/setup').send({ code, password: PASSWORD });
    cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
});

afterEach(() => {
    rmSync(nodeDir, { recursive: true, force: true });
});

const post = (path: string, body: object = {}) => request(app).post(`/api${path}`).set('Cookie', cookie).send(body);
const get = (path: string) => request(app).get(`/api${path}`).set('Cookie', cookie);

// A job that runs until it is told to finish, so that another can be asked
// for meanwhile, and that can be made to print a line while it runs.
function held(title: string) {
    let finish!: () => void;
    let print!: (text: string) => void;
    const work: JobWork = async log => {
        print = log;
        log('started');
        await new Promise<void>(resolve => { finish = resolve; });
    };

    return { title, work, finish: () => finish(), print: (text: string) => print(text) };
}

async function finished(id: string) {
    for (;;) {
        const res = await get(`/jobs/${id}`).expect(200);
        if (res.body.status !== 'running') {
            return res.body;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

describe('actions', () => {
    it('previews an action as the lifecycle describes it', async () => {
        lifecycle.preview.mockResolvedValue({ services: ['gatekeeper'], stateful: [] });

        const res = await post('/actions/preview', { action: 'restart', service: 'gatekeeper' }).expect(200);

        expect(res.body).toStrictEqual({ services: ['gatekeeper'], stateful: [] });
        expect(lifecycle.preview).toHaveBeenCalledWith({ action: 'restart', service: 'gatekeeper' });
    });

    it('refuses a request that names no action, a bad service, or a removal that is not of the whole node', async () => {
        for (const body of [{}, { action: 'reboot' }, { action: 'stop', service: '../etc' }, { action: 'stop', service: 'gatekeeper', down: true }, { action: 'start', down: true }]) {
            const res = await post('/actions/preview', body);

            expect([body, res.status]).toStrictEqual([body, 400]);
        }
        expect(lifecycle.preview).not.toHaveBeenCalled();
    });

    it('answers a refusal from the lifecycle with its status, and anything else as an internal error', async () => {
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        lifecycle.preview.mockRejectedValueOnce(new ConfigError('No such service: nope', 404));
        const refused = await post('/actions/preview', { action: 'start', service: 'nope' });
        expect([refused.status, refused.body]).toStrictEqual([404, { error: 'No such service: nope' }]);

        lifecycle.preview.mockRejectedValueOnce(new Error('docker socket: permission denied'));
        const broken = await post('/actions/preview', { action: 'start' });
        // What went wrong inside is logged and not sent.
        expect([broken.status, broken.body]).toStrictEqual([500, { error: 'Internal error' }]);
        expect(logged).toHaveBeenCalledTimes(1);
        logged.mockRestore();
    });

    it('runs an action as a job, and passes on whether stateful services were confirmed', async () => {
        lifecycle.run.mockResolvedValue({ title: 'Stop the node', work: async log => { log('stopping'); } });

        const res = await post('/actions/run', { action: 'stop', down: true, confirmStateful: true }).expect(202);

        expect(lifecycle.run).toHaveBeenCalledWith({ action: 'stop', down: true }, true);
        expect(await finished(res.body.id)).toMatchObject({ title: 'Stop the node', status: 'succeeded' });

        // Anything but true is not a confirmation.
        await post('/actions/run', { action: 'start', confirmStateful: 'yes' }).expect(202);
        expect(lifecycle.run).toHaveBeenLastCalledWith({ action: 'start' }, false);
    });

    it('runs one job at a time', async () => {
        const first = held('Restart the node');
        lifecycle.run.mockResolvedValueOnce(first);
        const started = await post('/actions/run', { action: 'restart' }).expect(202);

        const second = await post('/actions/run', { action: 'start' });
        expect([second.status, second.body]).toStrictEqual([409, { error: 'Another job is running' }]);
        const update = await post('/updates/run', { confirm: [] });
        expect([update.status, update.body]).toStrictEqual([409, { error: 'Another job is running' }]);
        // Neither was prepared: the job that is running was the reason.
        expect(lifecycle.run).toHaveBeenCalledTimes(1);
        expect(updates.run).not.toHaveBeenCalled();

        first.finish();
        expect(await finished(started.body.id)).toMatchObject({ status: 'succeeded' });
    });

    it('starts no job for an action the lifecycle refuses', async () => {
        lifecycle.run.mockRejectedValue(new ConfigError('Confirm stopping stateful services: cln'));

        const res = await post('/actions/run', { action: 'stop' });

        expect([res.status, res.body]).toStrictEqual([400, { error: 'Confirm stopping stateful services: cln' }]);
        expect((await get('/jobs').expect(200)).body.jobs).toStrictEqual([]);
    });
});

describe('updates', () => {
    it('reports the update status, fetching only when asked to', async () => {
        updates.status.mockResolvedValue({ channel: 'release', current: 'v0.15.0', available: null });

        expect((await get('/updates').expect(200)).body).toStrictEqual({ channel: 'release', current: 'v0.15.0', available: null });
        expect(updates.status).toHaveBeenLastCalledWith(false);
        await get('/updates?fetch=1').expect(200);
        expect(updates.status).toHaveBeenLastCalledWith(true);
        // Any other value is not a request to fetch.
        await get('/updates?fetch=true').expect(200);
        expect(updates.status).toHaveBeenLastCalledWith(false);
    });

    it('sets the channel, and answers a refused one with the reason', async () => {
        updates.setChannel.mockResolvedValueOnce(undefined);
        const set = await request(app).put('/api/updates/channel').set('Cookie', cookie).send({ channel: 'main' }).expect(200);

        expect(set.body).toStrictEqual({ channel: 'main' });
        expect(updates.setChannel).toHaveBeenCalledWith('main');

        updates.setChannel.mockRejectedValueOnce(new ConfigError('Unknown channel: nightly'));
        const refused = await request(app).put('/api/updates/channel').set('Cookie', cookie).send({ channel: 'nightly' });
        expect([refused.status, refused.body]).toStrictEqual([400, { error: 'Unknown channel: nightly' }]);
    });

    it('runs an update as a job, with only the names that were confirmed', async () => {
        updates.run.mockResolvedValue({ title: 'Update to v0.16.0', work: async log => { log('pulling'); } });

        const res = await post('/updates/run', { confirm: ['cln', 7, null, 'bitcoin'] }).expect(202);

        expect(updates.run).toHaveBeenCalledWith(['cln', 'bitcoin']);
        expect(await finished(res.body.id)).toMatchObject({ title: 'Update to v0.16.0', status: 'succeeded' });

        // A confirmation that is no list confirms nothing.
        await post('/updates/run', { confirm: 'cln' }).expect(202);
        expect(updates.run).toHaveBeenLastCalledWith([]);
    });

    it('starts no job for an update that is refused, or that fails to prepare', async () => {
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        updates.status.mockRejectedValueOnce(new Error('git: not a repository'));
        expect((await get('/updates')).status).toBe(500);
        updates.run.mockRejectedValueOnce(new ConfigError('Nothing to update', 409));
        const refused = await post('/updates/run', {});
        expect([refused.status, refused.body]).toStrictEqual([409, { error: 'Nothing to update' }]);

        expect((await get('/jobs').expect(200)).body.jobs).toStrictEqual([]);
        logged.mockRestore();
    });
});

describe('a job\'s output', () => {
    // Reads a stream of server-sent events to its end, as events with their data.
    // What opens a stream (a retry hint, a comment) has no event and is left out.
    const events = (text: string) => text.split('\n\n').flatMap(block => {
        const lines = block.split('\n');
        const event = lines.find(line => line.startsWith('event: '));
        const data = lines.find(line => line.startsWith('data: '));

        return event && data ? [{ event: event.slice('event: '.length), data: JSON.parse(data.slice('data: '.length)) }] : [];
    });

    it('is not found for a job that does not exist', async () => {
        expect((await get('/jobs/nope')).status).toBe(404);
        expect((await get('/jobs/nope/stream')).status).toBe(404);
    });

    it('is every line and then the outcome, for a job that has finished', async () => {
        lifecycle.run.mockResolvedValue({ title: 'Start the node', work: async log => { log('one'); log('two'); } });
        const { body } = await post('/actions/run', { action: 'start' }).expect(202);
        await finished(body.id);

        const stream = await get(`/jobs/${body.id}/stream`).expect(200);
        const seen = events(stream.text);

        expect(stream.headers['content-type']).toMatch(/^text\/event-stream/);
        expect(seen.map(each => each.event)).toStrictEqual(['line', 'line', 'end']);
        expect(seen.slice(0, 2).map(each => each.data.text)).toStrictEqual(['one', 'two']);
        // The outcome is the job without its lines, which were already sent.
        expect(seen[2].data).toMatchObject({ id: body.id, status: 'succeeded' });
        expect(seen[2].data.lines).toBeUndefined();
    });

    it('follows a job that is still running to its end', async () => {
        const running = held('Restart the node');
        lifecycle.run.mockResolvedValue(running);
        const { body } = await post('/actions/run', { action: 'restart' }).expect(202);

        // The stream is listening once it has subscribed to the job. A line
        // printed after that can only reach it as it is printed.
        const subscribe = jobs.subscribe.bind(jobs);
        const listening = new Promise<void>(resolve => {
            jest.spyOn(jobs, 'subscribe').mockImplementation((id, listener) => {
                const unsubscribe = subscribe(id, listener);
                resolve();
                return unsubscribe;
            });
        });
        const stream = get(`/jobs/${body.id}/stream`).then(res => events(res.text));
        await listening;
        running.print('still going');
        running.finish();
        const seen = await stream;

        expect(seen.map(each => each.event)).toStrictEqual(['line', 'line', 'end']);
        expect(seen.slice(0, 2).map(each => each.data.text)).toStrictEqual(['started', 'still going']);
        expect(seen[2].data).toMatchObject({ status: 'succeeded' });
    });
});
