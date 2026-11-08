import { readFileSync } from 'fs';
import { basename, join } from 'path';
import { envValues, parseEnv } from './envfile.js';

export interface NodeRunnerConfig {
    port: number;
    // The node's repository, mounted at the same path the host uses so that
    // Compose resolves its relative paths exactly as it does in a shell.
    nodeDir: string;
    dataDir: string;
    project: string;
    dockerSocket: string;
    clientDir: string | null;
    gitCommit: string;
    // node-runner's own image, which its self-update helper runs.
    image: string;
}

// Compose's own normalization of a project name: lower case, and only
// letters, digits, dashes and underscores.
export function normalizeProjectName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

// COMPOSE_PROJECT_NAME from the node's .env, the one place an operator would
// set it, read with Compose's quoting and comment rules.
export function projectNameFromEnvFile(text: string): string | null {
    return envValues(parseEnv(text)).get('COMPOSE_PROJECT_NAME') || null;
}

export function resolveProject(nodeDir: string, explicit?: string): string {
    if (explicit) {
        return normalizeProjectName(explicit);
    }
    try {
        const fromEnv = projectNameFromEnvFile(readFileSync(join(nodeDir, '.env'), 'utf-8'));
        if (fromEnv) {
            return normalizeProjectName(fromEnv);
        }
    }
    catch {
        // No .env: Compose falls back to the directory name, and so do we.
    }
    return normalizeProjectName(basename(nodeDir));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NodeRunnerConfig {
    const nodeDir = env.ARCHON_NODE_RUNNER_NODE_DIR;
    if (!nodeDir) {
        throw new Error('ARCHON_NODE_RUNNER_NODE_DIR must name the node directory; start node-runner with ./node-runner');
    }
    return {
        port: Number(env.ARCHON_NODE_RUNNER_PORT) || 4280,
        nodeDir,
        dataDir: env.ARCHON_NODE_RUNNER_DATA_DIR || join(nodeDir, 'data', 'node-runner'),
        project: resolveProject(nodeDir, env.ARCHON_NODE_RUNNER_PROJECT),
        dockerSocket: env.ARCHON_NODE_RUNNER_DOCKER_SOCKET || '/var/run/docker.sock',
        clientDir: env.ARCHON_NODE_RUNNER_CLIENT_DIR || null,
        gitCommit: env.GIT_COMMIT || 'unknown',
        image: env.ARCHON_NODE_RUNNER_IMAGE || 'ghcr.io/archetech/node-runner',
    };
}
