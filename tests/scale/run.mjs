// Experiment A of docs/plans/scale-testing-1627.md: N nodes with empty histories on
// a private swarm, a stream of new identities into one of them, and how long each
// takes to reach the rest.
//
//   node run.mjs --nodes 5 --ops 30 --rate 1 [--wait <seconds>] [--snapshot <name>] [--ttl 3h] [--keep yes]
//
// Writes results/<run>.json and prints a summary. Removes its machines when it ends,
// unless --keep yes.
import { PREFIX, RELEASE, REMOTE, boxd, here, log, options, percentile, pool, region, run, sleep } from './lib.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const opts = options(process.argv.slice(2), {
    nodes: 5, ops: 30, rate: 1, wait: 0, snapshot: `${PREFIX}-${RELEASE.replace(/\./g, '-')}`, ttl: '3h', keep: 'no',
});
const id = randomBytes(3).toString('hex');
const protocol = `/ARCHON/scale-${id}`;
const names = Array.from({ length: opts.nodes }, (_, i) => `${PREFIX}-${id}-n${String(i + 1).padStart(2, '0')}`);
const node = `cd /home/boxd/archon`;
const METRICS = ['mediator_active_connections', 'mediator_messages_received_total', 'mediator_messages_relayed_total',
    'mediator_operations_imported_total', 'mediator_operations_exported_total', 'mediator_duplicate_batches_total',
    'mediator_errors_total'];

// Every series of a metric summed, whatever its labels.
function parseMetrics(text) {
    const totals = Object.fromEntries(METRICS.map(name => [name, 0]));
    for (const line of text.split('\n')) {
        const match = line.match(/^([a-z_]+)(?:\{[^}]*\})? ([0-9.e+-]+)$/);
        if (match && match[1] in totals) totals[match[1]] += Number(match[2]);
    }
    return totals;
}
const metrics = async machine => parseMetrics(await run(machine, 'curl -s -m 10 http://localhost:4232/metrics', { seconds: 30 }));
const jsonLines = text => text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));

// The machines this run made, and the ones it asked for without hearing that they
// were made. A request that times out or loses its answer can still have made a
// machine, which would be paid for until its deletion timer. Those are removed too,
// quietly, since most of them will not exist.
const created = [], asked = [];
async function teardown() {
    await pool(created, 8, name => boxd(['machine', 'remove', name, '-y']).catch(error => log(`could not remove ${name}: ${error.message}`)));
    const unsure = asked.filter(name => !created.includes(name));
    const found = (await pool(unsure, 8, name => boxd(['machine', 'remove', name, '-y']).then(() => name, () => null))).filter(Boolean);
    if (found.length) log(`also removed ${found.join(' ')}, made by requests that had reported failure`);
}

log(`run ${id}: ${opts.nodes} nodes in ${region()}, ${opts.ops} operations at ${opts.rate}/s, protocol ${protocol}`);
const result = { run: id, release: RELEASE, region: region(), options: opts, protocol, started: new Date().toISOString() };
try {
    log('creating machines');
    await pool(names, 10, name => (asked.push(name), boxd(['machine', 'new', name, '--from-snapshot', opts.snapshot, '--delete-after', opts.ttl,
        '--label', 'purpose=archon-scale', '--label', `run=${id}`])).then(() => created.push(name)));

    log('starting nodes');
    const images = await pool(names, 10, (name, index) => run(name, `set -euo pipefail
        ${node}
        bash ${REMOTE}/configure.sh ${name} ${protocol} ${index + 1}
        docker compose up -d --no-build >/dev/null 2>&1
        docker compose cp ${REMOTE}/generate.mjs cli:/app/generate.mjs >/dev/null
        docker compose config --images 2>/dev/null`, { seconds: 420 }));
    // The references Compose resolved, which name each Archon image by digest.
    result.images = images[0].trim().split('\n').sort();

    // A full mesh is not required. The mediator looks for peers again only once a
    // minute, so the wait ends when every node has every peer, or when no node's
    // count has changed for two of those rounds. With --wait the load begins after
    // that many seconds whatever the counts are doing, to see what time alone changes.
    log('waiting for the nodes to find each other');
    const waitBegan = Date.now();
    const deadline = waitBegan + (opts.wait ? opts.wait * 1000 : Number(process.env.SCALE_MESH_WAIT_MS || 720_000));
    const history = [];
    let connections = [], changed = Date.now();
    while (Date.now() < deadline) {
        const now = (await pool(names, 10, metrics)).map(m => m.mediator_active_connections);
        if (now.join() !== connections.join()) {
            changed = Date.now();
            history.push({ seconds: Math.round((changed - waitBegan) / 1000), connections: now });
        }
        connections = now;
        if (!opts.wait) {
            if (connections.every(count => count >= opts.nodes - 1)) break;
            if (Date.now() - changed > 130_000 && connections.every(count => count > 0)) break;
        }
        await sleep(Math.min(10_000, Math.max(0, deadline - Date.now())));
    }
    result.connectionHistory = history;
    result.connections = connections;
    result.meshWaitMs = Date.now() - waitBegan;
    log(`connections per node after ${Math.round(result.meshWaitMs / 1000)} s: ${connections.join(' ')}`);
    // Machines in one region can be on different hosts, each with a private network
    // and a public address of its own. Nodes on different hosts have not connected to
    // each other, so a network that came up in groups has to be read against this.
    // It is read before anything can stop the run: a node alone on a host has no
    // peers, and that is the failure this explains.
    result.addresses = await pool(names, 10, async name => {
        const [local = '', outbound = ''] = (await run(name,
            `ip -4 -o addr show eth0 | awk '{print $4}'; curl -s -m 8 https://api.ipify.org || true`, { seconds: 30 })).trim().split('\n');
        return { private: local, public: /^[\d.]+$/.test(outbound.trim()) ? outbound.trim() : '' };
    });
    // A node whose public address could not be read might be on any host, so the
    // count is then unknown and the run cannot be called valid.
    const hosts = [...new Set(result.addresses.map(address => address.public))];
    result.hosts = hosts.includes('') ? null : hosts.length;
    if (result.hosts === null) log('a node\'s public address could not be read, so the number of hosts is unknown');
    else if (result.hosts > 1) log(`the nodes are on ${result.hosts} hosts, which invalidates the run: ${result.addresses.map(address => hosts.indexOf(address.public) + 1).join(' ')}`);
    if (connections.some(count => count === 0)) throw new Error('a node has no peers, so there is nothing to measure');

    result.clocks = await pool(names, 8, name => run(name,
        "chronyc tracking 2>/dev/null | awk -F': *' '/System time/ {print $2}' || true; timedatectl show -p NTPSynchronized --value", { seconds: 30 })
        .then(text => text.trim().replace(/\n/g, '; ')));

    const since = new Date().toISOString();
    await pool(names, 8, name => run(name,
        `rm -f ${REMOTE}/watch.jsonl; setsid nohup node ${REMOTE}/watch.mjs ${since} ${REMOTE}/watch.jsonl >/dev/null 2>&1 & echo $! > ${REMOTE}/watch.pid`, { seconds: 30 }));
    const before = await pool(names, 8, metrics);

    log(`creating ${opts.ops} identities through ${names[0]}`);
    const operations = jsonLines(await run(names[0],
        `${node} && docker compose exec -T cli node generate.mjs ${opts.ops} ${opts.rate} hyperswarm scale-${id}`,
        { seconds: Math.ceil(opts.ops / opts.rate) + 180 }));
    if (operations.length !== opts.ops) throw new Error(`the generator made ${operations.length} of ${opts.ops} identities`);

    log('waiting for them to arrive everywhere');
    const settle = Date.now() + 90_000;
    let sightings = [];
    // A watcher also sees versions this run did not make, such as a node's own
    // identity, so arrival is judged by the generated versions and not by a count.
    const arrived = list => operations.every(operation =>
        list.some(entry => entry.did === operation.did && entry.versionId === operation.versionId));
    while (Date.now() < settle) {
        sightings = await pool(names, 8, name => run(name, `cat ${REMOTE}/watch.jsonl 2>/dev/null || true`, { seconds: 30 }).then(jsonLines));
        if (sightings.every(arrived)) break;
        await sleep(4000);
    }
    const after = await pool(names, 8, metrics);
    const stats = await pool(names, 8, name => run(name,
        `kill $(cat ${REMOTE}/watch.pid) 2>/dev/null; docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}'`, { seconds: 60 }));

    // How long after it was submitted each operation was first seen on each other node.
    const delays = [], missing = [];
    const perNode = names.map(() => []);
    for (const operation of operations) {
        let slowest = 0, absent = false;
        for (let i = 1; i < names.length; i++) {
            const sighting = sightings[i].find(entry => entry.did === operation.did && entry.versionId === operation.versionId);
            if (!sighting) { absent = true; continue; }
            const delay = sighting.seen - operation.submitted;
            perNode[i].push(delay);
            slowest = Math.max(slowest, delay);
        }
        if (absent) missing.push(operation.did);
        else delays.push(slowest);
    }
    delays.sort((a, b) => a - b);
    const delta = name => after.reduce((sum, m, i) => sum + m[name] - before[i][name], 0);
    const creates = operations.map(operation => operation.returned - operation.submitted).sort((a, b) => a - b);
    Object.assign(result, {
        finished: new Date().toISOString(),
        operations: operations.length,
        arrivedEverywhere: delays.length,
        missing,
        propagationMs: { p50: percentile(delays, 0.5), p95: percentile(delays, 0.95), max: delays.at(-1) ?? null },
        createMs: { p50: percentile(creates, 0.5), p95: percentile(creates, 0.95) },
        perNodeMedianMs: perNode.slice(1).map(list => percentile(list.sort((a, b) => a - b), 0.5)),
        mediator: Object.fromEntries(METRICS.filter(name => name.endsWith('_total')).map(name => [name, delta(name)])),
        stats: Object.fromEntries(names.map((name, i) => [name, stats[i].trim().split('\n')])),
    });

    mkdirSync(path.join(here, 'results'), { recursive: true });
    const file = path.join(here, 'results', `${id}.json`);
    writeFileSync(file, JSON.stringify(result, null, 4) + '\n');
    const per = name => (result.mediator[name] / operations.length).toFixed(1);
    console.log(`
run ${id}: ${opts.nodes} nodes, ${operations.length} operations at ${opts.rate}/s
  arrived on every node   ${delays.length} of ${operations.length}
  time to reach every node  p50 ${result.propagationMs.p50} ms, p95 ${result.propagationMs.p95} ms, max ${result.propagationMs.max} ms
  create at the origin    p50 ${result.createMs.p50} ms
  per operation, summed over the nodes: ${per('mediator_messages_relayed_total')} relayed, ${per('mediator_messages_received_total')} received, ${per('mediator_duplicate_batches_total')} duplicate batches
  connections per node    ${connections.join(' ')}
  hosts                   ${result.hosts === null ? 'unknown, so the run cannot be called valid' : result.hosts}${result.hosts > 1 ? ', so the run is not valid: nodes on different hosts do not connect' : ''}
  results                 ${file}`);
}
catch (error) {
    // What the run had learned by then, its nodes' hosts above all, says why it failed.
    result.error = error.message;
    mkdirSync(path.join(here, 'results'), { recursive: true });
    writeFileSync(path.join(here, 'results', `${id}.json`), JSON.stringify(result, null, 4) + '\n');
    throw error;
}
finally {
    if (opts.keep === 'yes') log(`left running: ${names.join(' ')}`);
    else { log('removing machines'); await teardown(); }
}
