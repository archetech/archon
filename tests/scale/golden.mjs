// Makes the snapshot every node of a run starts from: a machine with the repository
// at the release tag and the release's images pulled by digest, saved before a node
// has ever started on it, so machines made from it are distinct nodes.
//
//   node golden.mjs [--snapshot <name>]
import { PREFIX, RELEASE, REMOTE, boxd, copy, here, log, options, run } from './lib.mjs';
import path from 'node:path';

const { snapshot } = options(process.argv.slice(2), { snapshot: `${PREFIX}-${RELEASE.replace(/\./g, '-')}` });
const machine = `${PREFIX}-golden`;

log(`creating ${machine}`);
await boxd(['machine', 'new', machine, '--delete-after', '2h', '--label', 'purpose=archon-scale']);
try {
    await run(machine, `mkdir -p ${REMOTE}`);
    for (const file of ['pin-images.mjs', 'configure.sh', 'watch.mjs', 'generate.mjs']) {
        await copy(machine, path.join(here, 'node', file), `${REMOTE}/${file}`);
    }
    log(`cloning ${RELEASE} and pulling its images`);
    const pinned = await run(machine, `set -euo pipefail
        cd /home/boxd
        git clone -q --depth 1 --branch ${RELEASE} https://github.com/archetech/archon
        cd archon
        echo 'services: {}' > docker-compose.override.yml
        bash ${REMOTE}/configure.sh golden /ARCHON/golden 1
        node ${REMOTE}/pin-images.mjs ${RELEASE}
        docker compose pull -q
        rm -f .env scale-network.yml
        git status --porcelain data`, { seconds: 900 });
    const digests = JSON.parse(pinned.trim().split('\n').find(line => line.startsWith('{')));
    for (const [service, digest] of Object.entries(digests)) log(`  ${service}  ${digest}`);
    log(`saving snapshot ${snapshot}`);
    await boxd(['snapshots', 'save', machine, snapshot]);
    console.log(JSON.stringify({ snapshot, release: RELEASE, images: digests }, null, 4));
}
finally {
    await boxd(['machine', 'remove', machine, '-y']);
    log(`removed ${machine}`);
}
