// Makes the snapshot every node of a run starts from: a machine with the repository
// at the release tag and the release's images pulled by digest, saved before a node
// has ever started on it, so machines made from it are distinct nodes.
//
//   node golden.mjs [--snapshot <name>] [--mediator <directory>]
//
// With --mediator the snapshot's nodes run a Hyperswarm mediator made of the release's
// image with the compiled files in that directory laid over its own, which is how a
// change to the mediator is tried without building an image. Compile them from the
// release's source with the change applied, so that nothing else differs. Every
// other service stays the release's.
import { PREFIX, RELEASE, REMOTE, boxd, copy, here, log, options, run } from './lib.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const { snapshot, mediator } = options(process.argv.slice(2), { snapshot: `${PREFIX}-${RELEASE.replace(/\./g, '-')}`, mediator: '' });
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
    if (mediator) {
        const image = `archon-scale/hyperswarm-mediator:${path.basename(path.resolve(mediator))}`;
        const entry = 'hyperswarm-mediator.js';
        const expected = createHash('sha256').update(readFileSync(path.join(mediator, entry))).digest('hex');
        log(`laying ${mediator} over the release's mediator as ${image}`);
        await run(machine, `rm -rf ${REMOTE}/mediator-dist && mkdir ${REMOTE}/mediator-dist`);
        for (const file of readdirSync(mediator).filter(name => name.endsWith('.js'))) {
            await copy(machine, path.join(mediator, file), `${REMOTE}/mediator-dist/${file}`);
        }
        const actual = await run(machine, `set -euo pipefail
            cd ${REMOTE}
            printf 'FROM %s\\nCOPY mediator-dist/ /app/hyperswarm/dist/\\n' '${digests['hyperswarm-mediator']}' > Dockerfile.mediator
            docker build -q -f Dockerfile.mediator -t ${image} . >/dev/null
            echo ${image} > ${REMOTE}/mediator-image
            docker run --rm --entrypoint sha256sum ${image} dist/${entry}`, { seconds: 600 });
        // The nodes must be running the files given, not the release's own.
        if (!actual.includes(expected)) throw new Error(`${image} does not hold the ${entry} it was given`);
        digests['hyperswarm-mediator'] = `${image}, over ${digests['hyperswarm-mediator']}`;
    }
    log(`saving snapshot ${snapshot}`);
    await boxd(['snapshots', 'save', machine, snapshot]);
    console.log(JSON.stringify({ snapshot, release: RELEASE, images: digests }, null, 4));
}
finally {
    await boxd(['machine', 'remove', machine, '-y']);
    log(`removed ${machine}`);
}
