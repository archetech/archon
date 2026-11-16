// Runs experiment A at several sizes, several times each, one run after another, and
// writes one table of the results. A run that fails is recorded and the sweep goes on,
// unless it failed creating a machine.
//
//   node sweep.mjs [--sizes 2,5,10,20,40] [--repeats 3] [--ops 60] [--rate 1] [--cap 10]
//
// --cap is a spending limit in the account's currency: before each run the sweep reads
// the account's estimated usage and stops if the sweep has spent more than that.
import { boxd, here, log, options } from './lib.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const opts = options(process.argv.slice(2), { sizes: '2,5,10,20,40', repeats: 3, ops: 60, rate: 1, cap: 10 });
const sizes = opts.sizes.split(',').map(Number);
if (!sizes.length || sizes.some(size => !Number.isInteger(size) || size < 2)) {
    throw new Error(`--sizes takes whole numbers of two or more, separated by commas, not ${opts.sizes}`);
}

async function spent() {
    const total = (await boxd(['manage', 'usage'])).match(/Total: \D*([\d.]+)/);
    if (!total) throw new Error('could not read the account usage, so the spending limit cannot be kept');
    return Number(total[1]);
}

function runOnce(nodes) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [path.join(here, 'run.mjs'), '--nodes', String(nodes), '--ops', String(opts.ops), '--rate', String(opts.rate)],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', data => { out += data; process.stdout.write(data); });
        child.stderr.on('data', data => { out += data; process.stderr.write(data); });
        child.on('close', code => {
            const id = out.match(/run ([0-9a-f]{6}):/)?.[1];
            if (code === 0 && id) resolve(JSON.parse(readFileSync(path.join(here, 'results', `${id}.json`), 'utf8')));
            else resolve({ run: id, options: { nodes }, error: out.trim().split('\n').filter(line => /Error/.test(line)).pop() ?? `exited ${code}` });
        });
    });
}

// A run makes this directory only once it has something to write, and a sweep has to
// record a run that failed before that.
mkdirSync(path.join(here, 'results'), { recursive: true });
const before = await spent();
const runs = [];
const file = path.join(here, 'results', `sweep-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`);
outer: for (const nodes of sizes) {
    for (let repeat = 1; repeat <= opts.repeats; repeat++) {
        const used = await spent() - before;
        if (used > opts.cap) {
            log(`stopping: the sweep has spent ${used.toFixed(2)}, over the limit of ${opts.cap}`);
            break outer;
        }
        log(`=== ${nodes} nodes, run ${repeat} of ${opts.repeats} (spent so far ${used.toFixed(2)})`);
        const run = await runOnce(nodes);
        runs.push(run);
        writeFileSync(file, JSON.stringify({ options: opts, runs }, null, 4) + '\n');
        // A machine that cannot be created now cannot be created for a larger run either.
        if (/boxd machine new/.test(run.error ?? '')) {
            log('stopping: the host refused to create a machine');
            break outer;
        }
    }
}

const per = (run, name) => (run.mediator[name] / run.operations).toFixed(1);
const rows = runs.map(run => run.error
    ? `| ${run.options.nodes} | ${run.run ?? '-'} | failed: ${run.error} | | | | | | |`
    : `| ${run.options.nodes} | ${run.run} | ${run.arrivedEverywhere} of ${run.operations} | ${run.propagationMs.p50} | ${run.propagationMs.p95} | `
        + `${per(run, 'mediator_messages_relayed_total')} | ${per(run, 'mediator_duplicate_batches_total')} | `
        + `${Math.min(...run.connections)} to ${Math.max(...run.connections)} | ${run.hosts} |`);
console.log(['', '| Nodes | Run | Reached every node | p50 ms | p95 ms | Relayed per op | Duplicate batches per op | Peers per node | Hosts |',
    '|---|---|---|---|---|---|---|---|---|', ...rows, '', `spent ${(await spent() - before).toFixed(2)}; results in ${file}`].join('\n'));
