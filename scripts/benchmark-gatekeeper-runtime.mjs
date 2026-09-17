// Measure running-time processing after startup recovery, with concurrent reads.
// Requires a built Gatekeeper, an accepted-history JSON map, and isolated Redis.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Redis } from 'ioredis';
import MemoryClient from '@didcid/ipfs/memory';

const mode = process.argv[2] ?? 'duplicates';
if (!['duplicates', 'status', 'deferred'].includes(mode)) throw new Error('Unknown benchmark mode');
const directory = process.env.ARCHON_BENCHMARK_IMPLEMENTATION
    ?? fileURLToPath(new URL('../packages/gatekeeper/dist/esm', import.meta.url));
const impl = pathToFileURL(path.resolve(directory)).href;
const snapshot = process.env.ARCHON_BENCHMARK_HISTORIES;
const redisURL = process.env.ARCHON_BENCHMARK_REDIS_URL;
if (!snapshot || !redisURL) throw new Error('Set ARCHON_BENCHMARK_HISTORIES and ARCHON_BENCHMARK_REDIS_URL');
process.env.ARCHON_REDIS_URL = redisURL;
const { default: Gatekeeper } = await import(impl + '/gatekeeper.js');
const { default: DbRedis } = await import(impl + '/db/redis.js');
const dbName = `archon-runtime-benchmark-${process.pid}-${Date.now()}`;
const redis = new Redis(redisURL);
const db = new DbRedis(dbName);
const log = console.log;
let done = false;
let probing;

try {
    const histories = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
    const candidates = Object.fromEntries(Object.entries(histories).map(([key, events]) => ['did:cid:' + key, events]));
    let pipeline = redis.pipeline();
    let count = 0;
    async function flush() {
        const results = await pipeline.exec();
        for (const [error] of results) if (error) throw error;
        pipeline = redis.pipeline();
    }
    for (const [key, events] of Object.entries(histories)) {
        const batch = pipeline;
        const rows = events.map(({ operation, ...event }) => {
            batch.set(`${dbName}/ops/${event.opid}`, JSON.stringify(operation));
            return JSON.stringify(event);
        });
        if (rows.length) pipeline.rpush(`${dbName}/dids/${key}`, ...rows);
        pipeline.hset(`${dbName}/candidates`, 'did:cid:' + key, JSON.stringify(events));
        if (++count % 100 === 0) await flush();
    }
    await flush();
    await db.start();
    const ipfs = new MemoryClient();
    let writes = 0;
    const add = ipfs.addJSON.bind(ipfs);
    ipfs.addJSON = async (...args) => { writes++; return add(...args); };
    const g = new Gatekeeper({ db, ipfs, registries: ['hyperswarm', 'BTC:mainnet', 'BTC:signet'] });
    // Deliberately isolate runtime from startup repair. No private state in a
    // running service is changed; this instance owns its temporary Redis prefix.
    g.historyReady = Promise.resolve();
    g.candidateHistory = structuredClone(candidates);
    for (const [did, events] of Object.entries(candidates)) g.indexCandidates(did, events);
    let reads = 0;
    const get = db.getEvents.bind(db);
    db.getEvents = async (...args) => { reads++; return get(...args); };
    const dependents = new Map();
    for (const events of Object.values(candidates)) {
        const controller = events[0]?.operation.controller;
        if (controller) dependents.set(controller, (dependents.get(controller) ?? 0) + 1);
    }
    const controller = [...dependents].filter(([did]) => candidates[did]).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!controller) throw new Error('Snapshot must include an agent and dependent assets');
    const events = [...candidates[controller], ...Object.values(candidates).flat().filter(event => event.did !== controller)].slice(0, 100);
    let deferred;
    if (mode === 'deferred') {
        const last = candidates[controller].at(-1);
        // Synthetic retained evidence with an absent predecessor exercises the
        // deferred path; its signature need not validate before that is found.
        const operation = { ...last.operation, previd: Object.values(candidates).find(items => items[0].did !== controller)[0].opid };
        deferred = { ...last, operation, opid: await g.generateCID(operation) };
        g.candidateHistory[controller].push(deferred);
        await db.setCandidates(controller, g.candidateHistory[controller]);
    }
    const latencies = [];
    async function probe() {
        while (!done) {
            const start = performance.now();
            await g.resolveDID(controller);
            latencies.push(performance.now() - start);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }
    console.log = () => {};
    const start = performance.now();
    const workload = mode === 'status' ? g.checkDIDs() : (async () => {
        const incoming = mode === 'deferred' ? [deferred] : events.map((event, index) => ({
            registry: 'hyperswarm', time: '2026-09-17T12:00:00.000Z', ordinal: [1789646400000, index], operation: event.operation,
        }));
        return { imported: await g.importBatch(incoming), processed: await g.processEvents() };
    })();
    probing = probe();
    const result = await workload;
    const elapsed = performance.now() - start;
    done = true;
    await probing;
    console.log = log;
    latencies.sort((a, b) => a - b);
    log(JSON.stringify({
        mode, dependent_count: dependents.get(controller), ipfs: 'memory', elapsed_ms: elapsed,
        reads, ipfs_writes: writes, requests: latencies.length,
        p95_ms: latencies[Math.floor(latencies.length * .95)], max_ms: latencies.at(-1),
        result: mode === 'status' ? { total: result.total, byType: result.byType } : result,
    }));
    // Compare every accepted history, not just the imported DIDs. Object key
    // order may change during Redis hydration, so compare structurally.
    const keys = Object.keys(histories);
    for (let i = 0; i < keys.length; i += 100) {
        const chunk = keys.slice(i, i + 100);
        const rows = await Promise.all(chunk.map(key => get('did:cid:' + key)));
        for (let j = 0; j < rows.length; j++) assert.deepEqual(rows[j], histories[chunk[j]], 'History changed: ' + chunk[j]);
    }
    log('Accepted histories unchanged: ' + keys.length);
} finally {
    done = true;
    try {
        if (probing) await probing;
    } finally {
        console.log = log;
        await db.stop();
        // Never flush the server: remove only keys owned by this benchmark run.
        const owned = await redis.keys(dbName + '/*');
        for (let i = 0; i < owned.length; i += 100) await redis.del(...owned.slice(i, i + 100));
        await redis.quit();
    }
}
