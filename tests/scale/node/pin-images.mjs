// Runs on a machine, in the cloned repository. The release's Compose files name no
// version, so they would pull `latest`. This resolves the release tag of every
// Archon image the node will run to a digest and writes docker-compose.override.yml
// naming each by that digest, which Compose reads without being told to.
//
//   node pin-images.mjs <release tag>
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const tag = process.argv[2];
const sh = (command, ...args) => execFileSync(command, args, { encoding: 'utf8' });
const config = JSON.parse(sh('docker', 'compose', 'config', '--format', 'json'));

const pinned = {};
for (const [service, definition] of Object.entries(config.services)) {
    const image = definition.image ?? '';
    if (!image.startsWith('ghcr.io/archetech/')) continue;
    const name = image.replace(/[:@].*$/, '');
    sh('docker', 'pull', '-q', `${name}:${tag}`);
    const digests = JSON.parse(sh('docker', 'image', 'inspect', '--format', '{{json .RepoDigests}}', `${name}:${tag}`));
    const digest = digests.find(entry => entry.startsWith(`${name}@sha256:`));
    if (!digest) throw new Error(`${name}:${tag} has no digest for its own repository: ${digests}`);
    pinned[service] = digest;
}
if (!Object.keys(pinned).length) throw new Error('no Archon images found in the Compose configuration');

const override = ['# Written by tests/scale/node/pin-images.mjs: every Archon image by digest.', 'services:',
    ...Object.entries(pinned).flatMap(([service, digest]) => [`  ${service}:`, `    image: ${digest}`])];
writeFileSync('docker-compose.override.yml', override.join('\n') + '\n');
console.log(JSON.stringify(pinned));
