// What the scale-test scripts share: running the boxd CLI, and small helpers.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const here = path.dirname(fileURLToPath(import.meta.url));
// The release under test, and the directory a machine keeps the harness's files in.
export const RELEASE = 'v0.14.1';
export const REMOTE = '/home/boxd/scale';
export const PREFIX = 'archon-scale';
const BOXD = process.env.BOXD || 'boxd';

export function region() {
    return process.env.BOXD_REGION || 'fra';
}

// Runs the boxd CLI. Resolves with its standard output, rejects with what it printed.
export function boxd(args, { timeout = 600_000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(BOXD, ['--region', region(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.on('data', data => { out += data; });
        child.stderr.on('data', data => { err += data; });
        const timer = setTimeout(() => child.kill(), timeout);
        child.on('error', reject);
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve(out);
            else reject(new Error(`boxd ${args.slice(0, 3).join(' ')} exited ${code}: ${(err || out).trim().slice(-600)}`));
        });
    });
}

// Runs a shell script on a machine.
export function run(machine, script, { seconds = 300 } = {}) {
    return boxd(['machine', 'exec', machine, '--timeout', String(seconds), '--', 'bash', '-c', script], { timeout: (seconds + 30) * 1000 });
}

export function copy(machine, local, remote) {
    return boxd(['machine', 'cp', local, `${machine}:${remote}`]);
}

export async function machines() {
    return JSON.parse(await boxd(['list', '--json']));
}

// Runs fn over the items, a few at a time, keeping the order of the results. After a
// failure no new item is started, and the failure is reported only once the calls
// already under way have finished, so a caller that cleans up afterwards is not
// racing one that is still creating something.
export async function pool(items, limit, fn) {
    const results = new Array(items.length);
    const failures = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length && !failures.length) {
            const index = next++;
            try {
                results[index] = await fn(items[index], index);
            }
            catch (error) {
                failures.push(error);
            }
        }
    }));
    if (failures.length) throw failures[0];
    return results;
}

export function options(argv, defaults) {
    const values = { ...defaults };
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        if (!(key in defaults) || argv[i + 1] === undefined) {
            const known = Object.keys(defaults).map(name => '--' + name).join(' ');
            throw new Error(`unknown or incomplete option ${argv[i]}; options are ${known}`);
        }
        values[key] = typeof defaults[key] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
    }
    return values;
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

export function percentile(sorted, p) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
