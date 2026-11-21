import { readFile } from 'fs/promises';

import { installProcessGuards } from '@didcid/common/process-guards';
import config from './config.js';
import { startMemepool } from './service.js';

async function main(startupComplete: () => void): Promise<void> {
    const commit = (process.env.GIT_COMMIT || 'unknown').slice(0, 7);
    let version = 'unknown';

    try {
        version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
    }
    catch {
        // The version stays unknown.
    }
    console.log(`Starting Memepool v${version} (${commit})`);

    await startMemepool(config, { version, commit });
    startupComplete();
}

// Fatal until startup is complete: a process that is listening with no
// Gatekeeper or no identity behind it would pass a health check and sign
// nobody in.
main(installProcessGuards('Memepool')).catch(error => {
    console.error(`Memepool failed to start: ${error}`);
    process.exit(1);
});
