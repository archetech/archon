import http from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDockerApi, DockerError, LogDecoder, splitTimestamp } from '../../services/node-runner/server/src/docker.ts';
import { frame } from './helpers.ts';

describe('LogDecoder', () => {
    it('decodes stdout and stderr frames', () => {
        const decoder = new LogDecoder(false);

        const lines = decoder.push(Buffer.concat([
            frame(1, '2026-11-08T10:00:00.1Z first\n'),
            frame(2, '2026-11-08T10:00:00.2Z second\n'),
        ]));

        expect(lines).toEqual([
            { stream: 'stdout', time: '2026-11-08T10:00:00.1Z', text: 'first' },
            { stream: 'stderr', time: '2026-11-08T10:00:00.2Z', text: 'second' },
        ]);
    });

    it('reassembles frames and lines split across chunks', () => {
        const decoder = new LogDecoder(false);
        const bytes = Buffer.concat([
            frame(1, '2026-11-08T10:00:00Z one '),
            frame(1, 'line\n2026-11-08T10:00:01Z two\n'),
        ]);

        const lines = [];
        for (let i = 0; i < bytes.length; i += 5) {
            lines.push(...decoder.push(bytes.subarray(i, i + 5)));
        }

        expect(lines.map(l => l.text)).toEqual(['one line', 'two']);
    });

    it('keeps a stream\'s partial line until it ends', () => {
        const decoder = new LogDecoder(false);

        expect(decoder.push(frame(1, '2026-11-08T10:00:00Z no newline'))).toEqual([]);
        expect(decoder.flush()).toEqual([{ stream: 'stdout', time: '2026-11-08T10:00:00Z', text: 'no newline' }]);
        expect(decoder.flush()).toEqual([]);
    });

    it('reads a TTY container\'s plain text, including a character split across chunks', () => {
        const decoder = new LogDecoder(true);
        const bytes = Buffer.from('2026-11-08T10:00:00Z naïve\r\n');
        const split = bytes.indexOf(0xc3) + 1;

        const lines = [...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))];

        expect(lines).toEqual([{ stream: 'stdout', time: '2026-11-08T10:00:00Z', text: 'naïve' }]);
    });
});

describe('splitTimestamp', () => {
    it('leaves a line without a timestamp whole', () => {
        expect(splitTimestamp('plain line')).toEqual({ time: '', text: 'plain line' });
    });

    it('drops terminal color codes', () => {
        expect(splitTimestamp('2026-11-08T15:35:15Z \u001b[0mGET /api/v1/ready \u001b[32m200\u001b[0m 3.2 ms\u001b[0m'))
            .toEqual({ time: '2026-11-08T15:35:15Z', text: 'GET /api/v1/ready 200 3.2 ms' });
    });
});

describe('createDockerApi', () => {
    let dir: string;
    let server: http.Server;
    let requests: string[];

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'node-runner-docker-'));
        requests = [];
        server = http.createServer((req, res) => {
            requests.push(req.url!);
            if (req.url!.startsWith('/containers/json')) {
                res.end(JSON.stringify([{ Id: 'abc' }]));
            }
            else if (req.url === '/containers/missing/json') {
                res.statusCode = 404;
                res.end(JSON.stringify({ message: 'No such container: missing' }));
            }
            else if (req.url!.startsWith('/containers/abc/logs')) {
                res.end(frame(1, '2026-11-08T10:00:00Z hello\n'));
            }
            else {
                res.statusCode = 500;
                res.end('boom');
            }
        });
        await new Promise<void>(resolve => server.listen(join(dir, 'docker.sock'), resolve));
    });

    afterEach(async () => {
        await new Promise(resolve => server.close(resolve));
        rmSync(dir, { recursive: true, force: true });
    });

    it('lists only the project\'s containers', async () => {
        const docker = createDockerApi(join(dir, 'docker.sock'));

        expect(await docker.listContainers('archon')).toEqual([{ Id: 'abc' }]);
        const filters = new URL(requests[0], 'http://x').searchParams.get('filters');
        expect(JSON.parse(filters!)).toEqual({ label: ['com.docker.compose.project=archon'] });
    });

    it('turns a Docker error into a DockerError with its status and message', async () => {
        const docker = createDockerApi(join(dir, 'docker.sock'));

        await expect(docker.inspect('missing')).rejects.toMatchObject({ status: 404, message: 'Docker: No such container: missing' });
        await expect(docker.inspect('other')).rejects.toMatchObject({ status: 500, message: 'Docker: boom' });
    });

    it('asks for timestamped logs with the tail, since and follow given', async () => {
        const docker = createDockerApi(join(dir, 'docker.sock'));

        const stream = await docker.logs('abc', { tail: 10, since: 1700000000.5, follow: true });
        stream.resume();
        await new Promise(resolve => stream.on('end', resolve));

        const params = new URL(requests[0], 'http://x').searchParams;
        expect(Object.fromEntries(params)).toEqual({ stdout: '1', stderr: '1', timestamps: '1', tail: '10', since: '1700000000.5', follow: '1' });
    });

    it('reports an unreachable socket as 503', async () => {
        const docker = createDockerApi(join(dir, 'absent.sock'));

        const error = await docker.listContainers('archon').catch(e => e);
        expect(error).toBeInstanceOf(DockerError);
        expect(error.status).toBe(503);
    });
});
