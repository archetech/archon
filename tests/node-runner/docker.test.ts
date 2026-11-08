import http from 'http';
import type { AddressInfo } from 'net';
import { createDockerApi, DockerError, LogDecoder, splitTimestamp, type Transport } from '../../services/node-runner/server/src/docker.ts';
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

// The tests reach a local server over TCP rather than the default Unix
// socket transport. Jest shares core modules across the suites in a worker,
// and once any suite has loaded nock, its passthrough drops socketPath.
describe('createDockerApi', () => {
    let server: http.Server;
    let requests: string[];
    let tcp: Transport;

    beforeEach(async () => {
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
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address() as AddressInfo;
        tcp = (options, callback) => http.request({ ...options, host: '127.0.0.1', port }, callback);
    });

    afterEach(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    it('lists only the project\'s containers', async () => {
        const docker = createDockerApi('/var/run/docker.sock', tcp);

        expect(await docker.listContainers('archon')).toEqual([{ Id: 'abc' }]);
        const filters = new URL(requests[0], 'http://x').searchParams.get('filters');
        expect(JSON.parse(filters!)).toEqual({ label: ['com.docker.compose.project=archon'] });
    });

    it('turns a Docker error into a DockerError with its status and message', async () => {
        const docker = createDockerApi('/var/run/docker.sock', tcp);

        await expect(docker.inspect('missing')).rejects.toMatchObject({ status: 404, message: 'Docker: No such container: missing' });
        await expect(docker.inspect('other')).rejects.toMatchObject({ status: 500, message: 'Docker: boom' });
    });

    it('asks for timestamped logs with the tail, since and follow given', async () => {
        const docker = createDockerApi('/var/run/docker.sock', tcp);

        const stream = await docker.logs('abc', { tail: 10, since: 1700000000.5, follow: true });
        stream.resume();
        await new Promise(resolve => stream.on('end', resolve));

        const params = new URL(requests[0], 'http://x').searchParams;
        expect(Object.fromEntries(params)).toEqual({ stdout: '1', stderr: '1', timestamps: '1', tail: '10', since: '1700000000.5', follow: '1' });
    });

    it('reports an unreachable daemon as 503', async () => {
        await new Promise(resolve => server.close(resolve));
        const docker = createDockerApi('/var/run/docker.sock', tcp);
        server = http.createServer();
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

        const error = await docker.listContainers('archon').catch(e => e);
        expect(error).toBeInstanceOf(DockerError);
        expect(error.status).toBe(503);
    });
});
