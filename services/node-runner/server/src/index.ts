import { createApp } from './app.js';
import { Auth } from './auth.js';
import { loadConfig } from './config.js';
import { createDockerApi } from './docker.js';

async function main(): Promise<void> {
    const config = loadConfig();
    const auth = new Auth({ dataDir: config.dataDir });
    await auth.ensureSetupCode(true);

    const app = createApp({
        auth,
        docker: createDockerApi(config.dockerSocket),
        project: config.project,
        gitCommit: config.gitCommit,
        clientDir: config.clientDir,
    });

    app.listen(config.port, () => {
        console.log(`node-runner ${config.gitCommit} managing Compose project "${config.project}" in ${config.nodeDir}, listening on port ${config.port}`);
    });
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
