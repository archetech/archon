import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, normalizeProjectName, projectNameFromEnvFile, resolveProject } from '../../services/node-runner/server/src/config.ts';

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'node-runner-config-'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('project name', () => {
    it('normalizes the way Compose does', () => {
        expect(normalizeProjectName('My Node.2')).toBe('mynode2');
    });

    it('reads COMPOSE_PROJECT_NAME from the node\'s .env, quoted or not', () => {
        expect(projectNameFromEnvFile('A=1\nCOMPOSE_PROJECT_NAME="archon-main"\n')).toBe('archon-main');
        expect(projectNameFromEnvFile("  COMPOSE_PROJECT_NAME = 'x' ")).toBe('x');
        expect(projectNameFromEnvFile('# COMPOSE_PROJECT_NAME=commented\n')).toBeNull();
        expect(projectNameFromEnvFile('COMPOSE_PROJECT_NAME=\n')).toBeNull();
    });

    it('prefers an explicit name, then .env, then the directory name', () => {
        const nodeDir = join(dir, 'My.Node');
        expect(resolveProject(nodeDir)).toBe('mynode');
        expect(resolveProject(nodeDir, 'Explicit')).toBe('explicit');

        writeFileSync(join(dir, '.env'), 'COMPOSE_PROJECT_NAME=fromenv\n');
        expect(resolveProject(dir)).toBe('fromenv');
    });
});

describe('loadConfig', () => {
    it('needs the node directory', () => {
        expect(() => loadConfig({})).toThrow('ARCHON_NODE_RUNNER_NODE_DIR');
    });

    it('defaults everything else from it', () => {
        expect(loadConfig({ ARCHON_NODE_RUNNER_NODE_DIR: dir })).toEqual({
            port: 4280,
            nodeDir: dir,
            dataDir: join(dir, 'data', 'node-runner'),
            project: normalizeProjectName(dir.split('/').pop()!),
            dockerSocket: '/var/run/docker.sock',
            clientDir: null,
            gitCommit: 'unknown',
        });
    });

    it('takes overrides from the environment', () => {
        expect(loadConfig({
            ARCHON_NODE_RUNNER_NODE_DIR: dir,
            ARCHON_NODE_RUNNER_PORT: '5000',
            ARCHON_NODE_RUNNER_DATA_DIR: '/data',
            ARCHON_NODE_RUNNER_PROJECT: 'archon',
            ARCHON_NODE_RUNNER_DOCKER_SOCKET: '/run/docker.sock',
            ARCHON_NODE_RUNNER_CLIENT_DIR: '/app/client',
            GIT_COMMIT: 'abc1234',
        })).toEqual({
            port: 5000,
            nodeDir: dir,
            dataDir: '/data',
            project: 'archon',
            dockerSocket: '/run/docker.sock',
            clientDir: '/app/client',
            gitCommit: 'abc1234',
        });
    });
});
