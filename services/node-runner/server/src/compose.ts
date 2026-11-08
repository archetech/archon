import { spawn } from 'child_process';

export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

// Runs a command, optionally reporting each output line as it arrives.
// With `capture: false` only the line callback sees the output, and just the
// tail of stderr is kept for an error message: a long build's output is not
// held in memory.
export type Exec = (command: string, args: string[], options: { cwd: string, env: NodeJS.ProcessEnv, onLine?: (line: string) => void, capture?: boolean }) => Promise<CommandResult>;

const STDERR_TAIL = 16 * 1024;

export const exec: Exec = (command, args, options) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env });
    let stdout = '';
    let stderr = '';
    const partial = { out: '', err: '' };
    const feed = (which: 'out' | 'err', chunk: string) => {
        if (!options.onLine) {
            return;
        }
        const parts = (partial[which] + chunk).split(/\r?\n|\r/);
        partial[which] = parts.pop() ?? '';
        parts.forEach(line => options.onLine!(line));
    };
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    const capture = options.capture !== false;
    child.stdout.on('data', (chunk: string) => {
        if (capture) {
            stdout += chunk;
        }
        feed('out', chunk);
    });
    child.stderr.on('data', (chunk: string) => {
        stderr = capture ? stderr + chunk : (stderr + chunk).slice(-STDERR_TAIL);
        feed('err', chunk);
    });
    child.on('error', reject);
    child.on('close', code => {
        (['out', 'err'] as const).forEach(which => {
            if (partial[which] && options.onLine) {
                options.onLine(partial[which]);
            }
        });
        resolve({ code: code ?? 1, stdout, stderr });
    });
});

export class ComposeError extends Error {
    constructor(message: string, readonly status = 500) {
        super(message);
    }
}

export interface ComposeService {
    profiles?: string[];
    build?: { context?: string, dockerfile?: string, args?: Record<string, string | null> };
    image?: string;
}

export interface ComposeConfig {
    name: string;
    services: Record<string, ComposeService>;
}

// Compose warns on stderr about every unset variable; only the last real
// error line explains a failure.
function failure(result: CommandResult): string {
    const lines = result.stderr.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !/level=warning/.test(l));
    return lines.at(-1)?.replace(/^time="[^"]*" level=\w+ msg=/, '') ?? `exit code ${result.code}`;
}

export interface ComposeApi {
    command(args: string[], options?: { envFile?: string, onLine?: (line: string) => void }): Promise<CommandResult>;
    validate(envFile?: string): Promise<void>;
    config(envFile?: string, allProfiles?: boolean): Promise<ComposeConfig>;
    hashes(envFile?: string): Promise<Map<string, string>>;
}

// The node's Compose project, run from its directory exactly as an operator
// runs it. The environment is reduced to what Compose needs, so nothing in
// node-runner's own environment overrides the node's .env.
export class Compose implements ComposeApi {
    constructor(
        private readonly nodeDir: string,
        private readonly gitCommit: () => Promise<string>,
        private readonly run: Exec = exec,
        // Pinned, so commands act on the project node-runner reads containers
        // from, even when that was set explicitly rather than from .env.
        private readonly project?: string,
    ) {}

    private async env(): Promise<NodeJS.ProcessEnv> {
        return {
            PATH: process.env.PATH,
            HOME: process.env.HOME && process.env.HOME !== '/' ? process.env.HOME : '/tmp',
            GIT_COMMIT: await this.gitCommit(),
        };
    }

    private args(envFile: string | undefined, args: string[]): string[] {
        return ['compose', '--project-directory', this.nodeDir, ...(this.project ? ['--project-name', this.project] : []), ...(envFile ? ['--env-file', envFile] : []), ...args];
    }

    async command(args: string[], options: { envFile?: string, onLine?: (line: string) => void } = {}): Promise<CommandResult> {
        // A streamed command is read line by line; only its exit code matters.
        return this.run('docker', this.args(options.envFile, args), { cwd: this.nodeDir, env: await this.env(), onLine: options.onLine, capture: !options.onLine });
    }

    private async checked(args: string[], envFile?: string): Promise<string> {
        const result = await this.command(args, { envFile });
        if (result.code !== 0) {
            throw new ComposeError(failure(result), 400);
        }
        return result.stdout;
    }

    // Fails with Compose's own message when the configuration is invalid.
    async validate(envFile?: string): Promise<void> {
        await this.checked(['config', '--quiet'], envFile);
    }

    async config(envFile?: string, allProfiles = false): Promise<ComposeConfig> {
        return JSON.parse(await this.checked([...(allProfiles ? ['--profile', '*'] : []), 'config', '--format', 'json'], envFile));
    }

    // Each enabled service's configuration hash: the value Compose compares
    // with a container's com.docker.compose.config-hash label to decide
    // whether `up` recreates it.
    async hashes(envFile?: string): Promise<Map<string, string>> {
        const out = await this.checked(['config', '--hash', '*'], envFile);
        return new Map(out.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 2) as [string, string][]);
    }
}
