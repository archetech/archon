import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp, readCookie, SESSION_COOKIE } from '../../services/node-runner/server/src/app.ts';
import { Auth } from '../../services/node-runner/server/src/auth.ts';
import { collectLogs, timeKey } from '../../services/node-runner/server/src/logs.ts';
import { FakeDocker, frame } from './helpers.ts';

const PASSWORD = 'correct horse battery';

let dataDir: string;
let auth: Auth;
let docker: FakeDocker;

function app(clientDir: string | null = null) {
    return createApp({ auth, docker, project: 'archon', gitCommit: 'abc1234', clientDir });
}

function cookieFrom(res: request.Response): string {
    const header = res.headers['set-cookie'] as unknown as string[];
    return header[0].split(';')[0];
}

async function signedIn(): Promise<string> {
    const code = await auth.ensureSetupCode();
    const res = await request(app()).post('/api/setup').send({ code, password: PASSWORD }).expect(200);
    return cookieFrom(res);
}

beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'node-runner-app-'));
    auth = new Auth({ dataDir, log: () => {}, failureDelayMs: 0 });
    docker = new FakeDocker([
        { service: 'gatekeeper', logs: ['2026-11-08T10:00:00.3Z gk one', '2026-11-08T10:00:02Z gk two'] },
        { service: 'keymaster', logs: ['2026-11-08T10:00:01Z km one', '!2026-11-08T10:00:00.25Z km err'] },
    ]);
});

afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
});

describe('readCookie', () => {
    it('finds a cookie among others', () => {
        expect(readCookie('a=1; node_runner_session=x%3Dy; b=2', SESSION_COOKIE)).toBe('x=y');
        expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
    });
});

describe('session API', () => {
    it('reports an unconfigured node-runner and issues a setup code', async () => {
        const res = await request(app()).get('/api/session').expect(200);

        expect(res.body).toEqual({ configured: false, authenticated: false, minPasswordLength: 12 });
        expect(await auth.ensureSetupCode()).toMatch(/^[A-Z2-9]{4}-/);
    });

    it('sets a strict, HttpOnly session cookie on setup', async () => {
        const code = await auth.ensureSetupCode();
        const res = await request(app()).post('/api/setup').send({ code, password: PASSWORD }).expect(200);

        const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
        expect(cookie).toMatch(/^node_runner_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
    });

    it('marks the cookie Secure behind an HTTPS proxy', async () => {
        const code = await auth.ensureSetupCode();
        const res = await request(app()).post('/api/setup').set('X-Forwarded-Proto', 'https').send({ code, password: PASSWORD });

        expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/; Secure$/);
    });

    it('rejects a wrong setup code and a wrong password', async () => {
        await auth.ensureSetupCode();
        await request(app()).post('/api/setup').send({ code: 'nope', password: PASSWORD }).expect(401);

        await signedIn();
        const res = await request(app()).post('/api/login').send({ password: 'not the password' }).expect(401);
        expect(res.body).toEqual({ error: 'The password is not correct' });
    });

    it('signs in, reports the session, and signs out', async () => {
        await signedIn();

        const login = await request(app()).post('/api/login').send({ password: PASSWORD }).expect(200);
        const cookie = cookieFrom(login);
        const session = await request(app()).get('/api/session').set('Cookie', cookie).expect(200);
        expect(session.body).toMatchObject({ configured: true, authenticated: true });

        await request(app()).post('/api/logout').set('Cookie', cookie).expect(200);
        await request(app()).get('/api/status').set('Cookie', cookie).expect(401);
    });

    it('ignores a form post, which cannot carry the JSON body', async () => {
        const code = await auth.ensureSetupCode();
        await request(app()).post('/api/setup').type('form').send({ code, password: PASSWORD }).expect(401);
    });
});

describe('protected API', () => {
    it('refuses every route without a session', async () => {
        await signedIn();
        for (const path of ['/api/info', '/api/status', '/api/logs', '/api/logs/stream']) {
            await request(app()).get(path).expect(401);
        }
    });

    it('ends sessions once the password hash is deleted', async () => {
        const cookie = await signedIn();
        rmSync(join(dataDir, 'admin-password'));

        const res = await request(app()).get('/api/status').set('Cookie', cookie).expect(401);
        expect(res.body.error).toBe('node-runner is not set up yet');
    });

    it('reports info and status', async () => {
        const cookie = await signedIn();

        expect((await request(app()).get('/api/info').set('Cookie', cookie)).body).toEqual({ project: 'archon', gitCommit: 'abc1234' });
        const status = await request(app()).get('/api/status').set('Cookie', cookie).expect(200);
        expect(status.body.services.map((s: { service: string }) => s.service)).toEqual(['gatekeeper', 'keymaster']);
    });

    it('merges logs from several services in time order', async () => {
        const cookie = await signedIn();

        const res = await request(app()).get('/api/logs').set('Cookie', cookie).expect(200);

        expect(res.body.entries.map((e: { text: string }) => e.text)).toEqual(['km err', 'gk one', 'km one', 'gk two']);
        expect(res.body.entries[0]).toMatchObject({ service: 'keymaster', stream: 'stderr' });
    });

    it('limits logs to the services and tail asked for', async () => {
        const cookie = await signedIn();

        const res = await request(app()).get('/api/logs?services=gatekeeper&tail=1').set('Cookie', cookie).expect(200);

        expect(res.body.entries.map((e: { text: string }) => e.text)).toEqual(['gk two']);
        expect(docker.logCalls).toEqual([{ id: 'id-gatekeeper', options: { tail: 1, since: undefined } }]);
    });

    it('downloads logs as text', async () => {
        const cookie = await signedIn();

        const res = await request(app()).get('/api/logs?services=gatekeeper&format=text').set('Cookie', cookie).expect(200);

        expect(res.headers['content-disposition']).toBe('attachment; filename="archon-logs.txt"');
        expect(res.text).toBe('2026-11-08T10:00:00.3Z gatekeeper gk one\n2026-11-08T10:00:02Z gatekeeper gk two\n');
    });

    it('names an unknown service instead of returning nothing', async () => {
        const cookie = await signedIn();

        const res = await request(app()).get('/api/logs?services=gatekeeper,nope').set('Cookie', cookie).expect(404);
        expect(res.body.error).toBe('No container for nope in project archon');
    });
});

describe('live logs', () => {
    let server: Server;

    afterEach(async () => {
        await new Promise(resolve => server?.close(resolve));
    });

    it('streams the tail and then new lines as server-sent events, and stops following on disconnect', async () => {
        const cookie = await signedIn();
        server = app().listen(0);
        const { port } = server.address() as AddressInfo;
        const controller = new AbortController();

        const res = await fetch(`http://127.0.0.1:${port}/api/logs/stream?services=gatekeeper&tail=1`, {
            headers: { Cookie: cookie },
            signal: controller.signal,
        });
        expect(res.headers.get('content-type')).toBe('text/event-stream');

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let text = '';
        const readUntil = async (needle: string) => {
            while (!text.includes(needle)) {
                const { value } = await reader.read();
                text += decoder.decode(value);
            }
        };

        await readUntil('gk two');
        expect(text).not.toContain('gk one');

        docker.followed[0].write(frame(1, '2026-11-08T10:00:03Z gk three\n'));
        await readUntil('gk three');

        const event = text.split('\n\n').find(block => block.includes('gk three'))!;
        expect(event.split('\n')[0]).toBe('event: log');
        expect(JSON.parse(event.split('\n')[1].replace(/^data: /, ''))).toEqual({
            service: 'gatekeeper', stream: 'stdout', time: '2026-11-08T10:00:03Z', text: 'gk three', key: '2026-11-08T10:00:03.000000000Z',
        });

        controller.abort();
        await new Promise<void>(resolve => {
            if (docker.followed[0].destroyed) {
                resolve();
            }
            else {
                docker.followed[0].on('close', () => resolve());
            }
        });
        expect(docker.followed[0].destroyed).toBe(true);
    });
});

describe('client', () => {
    it('serves the built client and falls back to index.html for its routes', async () => {
        const clientDir = join(dataDir, 'client');
        mkdirSync(join(clientDir, 'assets'), { recursive: true });
        writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>node-runner</title>');
        writeFileSync(join(clientDir, 'assets', 'app.js'), 'console.log(1)');

        await request(app(clientDir)).get('/assets/app.js').expect(200, 'console.log(1)');
        const page = await request(app(clientDir)).get('/logs').expect(200);
        expect(page.text).toContain('<title>node-runner</title>');
        expect(page.headers['x-frame-options']).toBe('DENY');
        await request(app(clientDir)).get('/api/nothing').expect(401);
    });
});

describe('timeKey', () => {
    it('pads Docker\'s trimmed fractions so timestamps sort as strings', () => {
        expect(timeKey('2026-11-08T10:00:00.3Z')).toBe('2026-11-08T10:00:00.300000000Z');
        expect(timeKey('2026-11-08T10:00:00Z')).toBe('2026-11-08T10:00:00.000000000Z');
        expect(timeKey('2026-11-08T10:00:00.25Z') < timeKey('2026-11-08T10:00:00.3Z')).toBe(true);
    });

    it('orders entries by it when collecting', async () => {
        const entries = await collectLogs(docker, [{ service: 'keymaster', id: 'id-keymaster', tty: false }], { tail: 10 });
        expect(entries.map(e => e.text)).toEqual(['km err', 'km one']);
    });
});
