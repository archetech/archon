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
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

// Packages whose install scripts call prebuild-install. `napi` is the N-API
// build version prebuild-install resolves for Node 22 (the highest entry in the
// package's own `binary.napi_versions`); if a future bump changes it, the
// download 404s and we fall back to fetching at npm-ci time.
const TARGETS = [
    { name: '@ipshipyard/node-datachannel', repo: 'ipshipyard/js-node-datachannel', napi: 8 },
];

const PLATFORM = process.env.PREBUILD_PLATFORM || 'linux';
// Both arches, because the publish workflows build linux/amd64,linux/arm64.
const ARCHES = (process.env.PREBUILD_ARCH || 'x64,arm64').split(',');
const OUT_DIR = path.resolve(process.env.PREBUILD_DIR || 'prebuilds');
const RETRIES = 5;

// Every version of a package installed anywhere in the repo, not just at the
// root. Services carry their own lockfiles and can pin a different version
// than the root does, and the prebuild filename carries the version -- so
// seeding only the root leaves those services fetching over the network at
// npm-ci time, which is the path this script exists to remove.
async function resolveVersions(locks, name) {
    const versions = new Set();

    for (const lock of locks) {
        const version = lock.packages?.[`node_modules/${name}`]?.version;
        if (version) {
            versions.add(version);
        }
    }

    return [...versions].sort();
}

// Mirrors prebuild-install's default URL template in util.js: the scope is
// stripped from the package name, and the tag is `v` + version.
function assetFor({ name, repo, napi }, version, arch) {
    const bare = name.replace(/^@[^/]+\//, '');
    const file = `${bare}-v${version}-napi-v${napi}-${PLATFORM}-${arch}.tar.gz`;
    return { file, url: `https://github.com/${repo}/releases/download/v${version}/${file}` };
}

// Versions come from package-lock.json, so a separator in a version string
// would let the computed filename escape OUT_DIR. That lockfile is already
// trusted (npm ci runs install scripts from it), but containment is cheap.
function resolveInside(dir, file) {
    const full = path.resolve(dir, file);
    if (full !== path.join(dir, path.basename(full)) || !full.startsWith(dir + path.sep)) {
        throw new Error(`refusing to write outside ${dir}: ${file}`);
    }
    return full;
}

async function download(url, dest) {
    let lastErr;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        const tmp = `${dest}.tmp`;
        try {
            const res = await fetch(url, { redirect: 'follow' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            // A fetch response can legally carry a null body; without this the
            // Readable.fromWeb below throws something opaque instead of being
            // reported and retried like any other failure.
            if (!res.body) throw new Error('empty response body');
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

// Tracked lockfiles only, so a stray one under node_modules or a build
// directory cannot add versions nobody installs.
const lockPaths = execFileSync('git', ['ls-files', '*package-lock.json'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

const locks = await Promise.all(lockPaths.map(async p => JSON.parse(await readFile(p, 'utf8'))));
await mkdir(OUT_DIR, { recursive: true });

let failed = 0;
for (const target of TARGETS) {
    const versions = await resolveVersions(locks, target.name);
    if (versions.length === 0) {
        console.warn(`! ${target.name} not found in any lockfile, skipping`);
        continue;
    }

    for (const [version, arch] of versions.flatMap(v => ARCHES.map(a => [v, a]))) {
        const { file, url } = assetFor(target, version, arch);
        try {
            await download(url, resolveInside(OUT_DIR, file));
            console.log(`✓ ${file}`);
        } catch (err) {
            failed++;
            console.warn(`! failed to prefetch ${file}: ${err.message}`);
            console.warn('  build will fall back to fetching this at npm-ci time');
        }
    }
}

console.log(failed ? `prefetch finished with ${failed} failure(s)` : 'prefetch complete');
