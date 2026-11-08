import { createApp } from './app.js';
import { Auth } from './auth.js';
import { Compose, exec } from './compose.js';
import { loadConfig } from './config.js';
import { createDockerApi } from './docker.js';
import { JobRunner } from './jobs.js';
import { Lifecycle } from './lifecycle.js';
import { NodeConfig } from './node-config.js';
import { Updates } from './updates.js';

async function main(): Promise<void> {
    const config = loadConfig();
    const auth = new Auth({ dataDir: config.dataDir });
    await auth.ensureSetupCode(true);

    // The node's current commit, which its image builds are labelled with.
    const gitCommit = async () => {
        const result = await exec('git', ['-C', config.nodeDir, 'rev-parse', '--short', 'HEAD'], { cwd: config.nodeDir, env: process.env }).catch(() => null);
        return result?.code === 0 ? result.stdout.trim() : 'unknown';
    };

    const docker = createDockerApi(config.dockerSocket);
    const compose = new Compose(config.nodeDir, gitCommit, exec, config.project);
    const nodeConfig = new NodeConfig({ nodeDir: config.nodeDir, dataDir: config.dataDir, project: config.project, compose, docker });
    const jobs = new JobRunner(config.dataDir);
    const updates = new Updates({ nodeDir: config.nodeDir, dataDir: config.dataDir, nodeConfig, exec, selfImage: config.image });
    // A self-update that replaced the previous process is still running.
    await updates.resume(jobs);
    const app = createApp({
        auth,
        docker,
        project: config.project,
        gitCommit: config.gitCommit,
        clientDir: config.clientDir,
        nodeConfig,
        jobs,
        lifecycle: new Lifecycle({ project: config.project, docker, nodeConfig }),
        updates,
    });

    app.listen(config.port, () => {
        console.log(`node-runner ${config.gitCommit} managing Compose project "${config.project}" in ${config.nodeDir}, listening on port ${config.port}`);
    });
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
