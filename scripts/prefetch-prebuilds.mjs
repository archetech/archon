#!/usr/bin/env node
// Prefetch native-module prebuilt binaries into ./prebuilds so that Docker
// builds never have to reach the network for them.
//
// Why this exists: prebuild-install fetches these tarballs from GitHub release
// assets with a single request and no retry (see prebuild-install/download.js).
// A transient connection reset there fails `npm ci`, and the source-build
// fallback can't rescue it because the node:*-slim base images have no Python
// or C++ toolchain. prebuild-install checks a local prebuilds directory before
// both its cache and the network, so seeding that directory removes the
// network from the critical path entirely.
//
// This is best-effort: if a download fails, we warn and carry on. The build
// then behaves exactly as it does today (fetch at npm-ci time) rather than
// failing early on something that is only meant to be an accelerator.

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

// Packages whose install scripts call prebuild-install. `napi` is the N-API
// build version prebuild-install resolves for Node 22 (the highest entry in the
// package's own `binary.napi_versions`); if a future bump changes it, the
// download 404s and we fall back to fetching at npm-ci time.
const TARGETS = [
    { name: 'sqlite3', repo: 'TryGhost/node-sqlite3', napi: 6 },
    { name: '@ipshipyard/node-datachannel', repo: 'ipshipyard/js-node-datachannel', napi: 8 },
];

const PLATFORM = process.env.PREBUILD_PLATFORM || 'linux';
// Both arches, because the publish workflows build linux/amd64,linux/arm64.
const ARCHES = (process.env.PREBUILD_ARCH || 'x64,arm64').split(',');
const OUT_DIR = path.resolve(process.env.PREBUILD_DIR || 'prebuilds');
const RETRIES = 5;

async function resolveVersion(lock, name) {
    const entry = lock.packages?.[`node_modules/${name}`];
    return entry?.version;
}

// Mirrors prebuild-install's default URL template in util.js: the scope is
// stripped from the package name, and the tag is `v` + version.
function assetFor({ name, repo, napi }, version, arch) {
    const bare = name.replace(/^@[^/]+\//, '');
    const file = `${bare}-v${version}-napi-v${napi}-${PLATFORM}-${arch}.tar.gz`;
    return { file, url: `https://github.com/${repo}/releases/download/v${version}/${file}` };
}

async function download(url, dest) {
    let lastErr;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        const tmp = `${dest}.tmp`;
        try {
            const res = await fetch(url, { redirect: 'follow' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
            await rename(tmp, dest);
            return;
        } catch (err) {
            lastErr = err;
            await rm(tmp, { force: true });
            if (attempt < RETRIES) {
                const delay = 2 ** attempt * 1000;
                console.warn(`  attempt ${attempt} failed (${err.message}), retrying in ${delay}ms`);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
await mkdir(OUT_DIR, { recursive: true });

let failed = 0;
for (const target of TARGETS) {
    const version = await resolveVersion(lock, target.name);
    if (!version) {
        console.warn(`! ${target.name} not found in package-lock.json, skipping`);
        continue;
    }

    for (const arch of ARCHES) {
        const { file, url } = assetFor(target, version, arch);
        try {
            await download(url, path.join(OUT_DIR, file));
            console.log(`✓ ${file}`);
        } catch (err) {
            failed++;
            console.warn(`! failed to prefetch ${file}: ${err.message}`);
            console.warn('  build will fall back to fetching this at npm-ci time');
        }
    }
}

console.log(failed ? `prefetch finished with ${failed} failure(s)` : 'prefetch complete');
