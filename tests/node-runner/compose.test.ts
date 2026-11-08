import { Compose, exec, type Exec } from '../../services/node-runner/server/src/compose.ts';

function fakeExec(stdout: string, code = 0, stderr = ''): { run: Exec, calls: { command: string, args: string[], env: NodeJS.ProcessEnv }[] } {
    const calls: { command: string, args: string[], env: NodeJS.ProcessEnv }[] = [];
    const run: Exec = async (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return { code, stdout, stderr };
    };
    return { run, calls };
}

describe('Compose', () => {
    it('runs from the node directory with only PATH, HOME and the node\'s commit in its environment', async () => {
        const { run, calls } = fakeExec('{"name":"archon","services":{}}');
        const compose = new Compose('/srv/node', async () => 'abc1234', run);
        process.env.ARCHON_NODE_NAME = 'leaks';

        await compose.config('/data/draft.env', true);

        delete process.env.ARCHON_NODE_NAME;
        expect(calls[0].command).toBe('docker');
        expect(calls[0].args).toEqual(['compose', '--project-directory', '/srv/node', '--env-file', '/data/draft.env', '--profile', '*', 'config', '--format', 'json']);
        expect(Object.keys(calls[0].env).sort()).toEqual(['GIT_COMMIT', 'HOME', 'PATH']);
        expect(calls[0].env.GIT_COMMIT).toBe('abc1234');
    });

    it('pins the project node-runner reads containers from', async () => {
        const { run, calls } = fakeExec('');
        const compose = new Compose('/srv/node', async () => 'x', run, 'archon-prod');

        await compose.command(['stop']);

        expect(calls[0].args).toEqual(['compose', '--project-directory', '/srv/node', '--project-name', 'archon-prod', 'stop']);
    });

    it('parses config hashes', async () => {
        const { run } = fakeExec('gatekeeper 111\nredis 222\n');
        const compose = new Compose('/srv/node', async () => 'x', run);

        expect(Object.fromEntries(await compose.hashes())).toEqual({ gatekeeper: '111', redis: '222' });
    });

    it('reports Compose\'s error rather than its unset-variable warnings', async () => {
        const stderr = [
            'time="2026-11-08T10:39:06-05:00" level=warning msg="The \\"X\\" variable is not set. Defaulting to a blank string."',
            'required variable ARCHON_ADMIN_API_KEY is missing a value',
        ].join('\n');
        const { run } = fakeExec('', 1, stderr);
        const compose = new Compose('/srv/node', async () => 'x', run);

        await expect(compose.validate()).rejects.toMatchObject({ status: 400, message: 'required variable ARCHON_ADMIN_API_KEY is missing a value' });
    });
});

describe('exec', () => {
    it('keeps no output in memory when only the line callback needs it', async () => {
        const lines: string[] = [];
        const result = await exec('sh', ['-c', 'echo out; echo err >&2'], { cwd: '/', env: { PATH: process.env.PATH }, onLine: l => lines.push(l), capture: false });

        expect(lines.sort()).toEqual(['err', 'out']);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('err\n');
    });

    it('reports output line by line and the exit code', async () => {
        const lines: string[] = [];
        const result = await exec('sh', ['-c', 'printf "a\\nb"; printf "c\\n" >&2; exit 3'], { cwd: '/', env: { PATH: process.env.PATH }, onLine: l => lines.push(l) });

        expect(result.code).toBe(3);
        expect(lines.sort()).toEqual(['a', 'b', 'c']);
        expect(result.stdout).toBe('a\nb');
    });
});
