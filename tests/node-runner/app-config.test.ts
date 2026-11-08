import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../../services/node-runner/server/src/app.ts';
import { Auth } from '../../services/node-runner/server/src/auth.ts';
import { JobRunner } from '../../services/node-runner/server/src/jobs.ts';
import { NodeConfig } from '../../services/node-runner/server/src/node-config.ts';
import { FakeCompose, FakeDocker } from './helpers.ts';

const PASSWORD = 'correct horse battery';
const ENV = 'COMPOSE_PROFILES=react-wallet\nARCHON_NODE_NAME=alpha\nARCHON_ADMIN_API_KEY=super-secret\n';

let nodeDir: string;
let app: ReturnType<typeof createApp>;
let jobs: JobRunner;
let cookie: string;

beforeEach(async () => {
    nodeDir = mkdtempSync(join(tmpdir(), 'node-runner-appcfg-'));
    const dataDir = join(nodeDir, 'data', 'node-runner');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(nodeDir, 'sample.env'), '# General\nARCHON_NODE_NAME=mynode\nARCHON_ADMIN_API_KEY=CHANGE_ME\n');
    writeFileSync(join(nodeDir, '.env'), ENV);
    const compose = new FakeCompose(nodeDir, {
        gatekeeper: { vars: ['ARCHON_NODE_NAME', 'ARCHON_ADMIN_API_KEY'] },
        'react-wallet': { profiles: ['react-wallet'] },
    });
    const docker = new FakeDocker([
        { service: 'gatekeeper', hash: compose.currentHash('gatekeeper') },
        { service: 'react-wallet', hash: compose.currentHash('react-wallet') },
    ]);
    const auth = new Auth({ dataDir, log: () => {}, failureDelayMs: 0 });
    jobs = new JobRunner(dataDir);
    const nodeConfig = new NodeConfig({ nodeDir, dataDir, project: 'archon', compose, docker, healthTimeoutMs: 0, sleep: async () => {} });
    app = createApp({ auth, docker, project: 'archon', gitCommit: 'abc', nodeConfig, jobs });

    const code = await auth.ensureSetupCode();
    const res = await request(app).post('/api/setup').send({ code, password: PASSWORD });
    cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
});

afterEach(() => {
    rmSync(nodeDir, { recursive: true, force: true });
});

async function finished(id: string) {
    for (;;) {
        const res = await request(app).get(`/api/jobs/${id}`).set('Cookie', cookie).expect(200);
        if (res.body.status !== 'running') {
            return res.body;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

describe('configuration API', () => {
    it('needs a session', async () => {
        await request(app).get('/api/config').expect(401);
        await request(app).post('/api/config/preview').send({}).expect(401);
        await request(app).post('/api/config/apply').send({}).expect(401);
        await request(app).get('/api/jobs').expect(401);
    });

    it('returns the view without secret values', async () => {
        const res = await request(app).get('/api/config').set('Cookie', cookie).expect(200);

        expect(res.body.profiles.map((p: { name: string }) => p.name)).toEqual(['react-wallet']);
        expect(res.text).not.toContain('super-secret');
    });

    it('previews without returning the candidate file', async () => {
        const res = await request(app).post('/api/config/preview').set('Cookie', cookie)
            .send({ draft: { settings: { ARCHON_ADMIN_API_KEY: 'new-secret-value' } } }).expect(200);

        expect(res.body.text).toBeUndefined();
        expect(res.body.source).toBeUndefined();
        expect(res.text).not.toContain('secret-value');
        expect(res.text).not.toContain('super-secret');
        expect(res.body.plan.recreate).toEqual([{ service: 'gatekeeper', stateful: false }]);
    });

    it('answers a bad draft with 400', async () => {
        const res = await request(app).post('/api/config/preview').set('Cookie', cookie)
            .send({ draft: { settings: { COMPOSE_PROJECT_NAME: 'x' } } }).expect(400);

        expect(res.body.error).toBe('COMPOSE_PROJECT_NAME is not edited as a setting');
    });

    it('applies as a job and records it', async () => {
        const res = await request(app).post('/api/config/apply').set('Cookie', cookie)
            .send({ draft: { settings: { ARCHON_NODE_NAME: 'beta' } } }).expect(202);

        const job = await finished(res.body.id);
        expect(job).toMatchObject({ title: 'Apply 1 configuration change', status: 'succeeded' });
        expect(job.lines.map((l: { text: string }) => l.text)).toContain('$ docker compose up -d --no-build');
        expect(readFileSync(join(nodeDir, '.env'), 'utf-8')).toContain('ARCHON_NODE_NAME=beta');

        const list = await request(app).get('/api/jobs').set('Cookie', cookie).expect(200);
        expect(list.body.jobs[0].lines).toBeUndefined();
    });

    it('refuses to start a second job while one runs', async () => {
        let release!: () => void;
        const { done } = await jobs.start('Holding', () => new Promise<void>(resolve => { release = resolve; }));

        const res = await request(app).post('/api/config/apply').set('Cookie', cookie)
            .send({ draft: { settings: { ARCHON_NODE_NAME: 'beta' } } }).expect(409);
        expect(res.body.error).toBe('Another job is running');
        release();
        await done;
    });

    it('streams a finished job\'s lines and its end', async () => {
        const { job, done } = await jobs.start('Short', async log => log('only line'));
        await done;

        const res = await request(app).get(`/api/jobs/${job.id}/stream`).set('Cookie', cookie).expect(200);

        expect(res.headers['content-type']).toBe('text/event-stream');
        expect(res.text).toContain('event: line\ndata: {"time"');
        expect(res.text).toContain('"text":"only line"');
        expect(res.text).toMatch(/event: end\ndata: \{[^\n]*"status":"succeeded"/);
    });

    it('ends a running job\'s stream when the session is logged out', async () => {
        let release!: () => void;
        const { job, done } = await jobs.start('Long', async log => {
            log('started');
            await new Promise<void>(resolve => { release = resolve; });
        });
        const server = app.listen(0);
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}/stream`, { headers: { Cookie: cookie } });
        const reader = res.body!.getReader();
        let text = '';
        while (!text.includes('started')) {
            text += new TextDecoder().decode((await reader.read()).value);
        }

        await request(app).post('/api/logout').set('Cookie', cookie).expect(200);
        while (!(await reader.read()).done) {
            // Drain until the server ends the stream.
        }

        release();
        await done;
        await new Promise(resolve => server.close(resolve));
    });

    it('answers 404 for an unknown job', async () => {
        await request(app).get('/api/jobs/nope').set('Cookie', cookie).expect(404);
        await request(app).get('/api/jobs/nope/stream').set('Cookie', cookie).expect(404);
    });
});
