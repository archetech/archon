import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import MemoryClient from '@didcid/ipfs/memory';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
// Requires a built Gatekeeper and an isolated Redis instance.
// Every run owns and removes only its unique Redis key prefix.
const directory = process.env.ARCHON_BENCHMARK_IMPLEMENTATION
    ?? fileURLToPath(new URL('../packages/gatekeeper/dist/esm', import.meta.url));
const impl = pathToFileURL(path.resolve(directory)).href;
const snapshot = process.env.ARCHON_BENCHMARK_HISTORIES;
const output = process.env.ARCHON_BENCHMARK_OUTPUT;
const reference = process.env.ARCHON_BENCHMARK_REFERENCE;
if (!snapshot || !output) throw Error('Set ARCHON_BENCHMARK_HISTORIES and ARCHON_BENCHMARK_OUTPUT');
const { default: Gatekeeper } = await import(impl + '/gatekeeper.js');
const { default: DbRedis } = await import(impl + '/db/redis.js');
const url = process.env.ARCHON_BENCHMARK_REDIS_URL;
if (!url) throw Error('Require isolated Redis URL');
process.env.ARCHON_REDIS_URL = url;
if (fs.existsSync(output)) throw Error('Benchmark output already exists; choose a new path');
if (reference && path.resolve(reference) === path.resolve(output)) throw Error('Reference and output must differ');
const histories = Object.entries(JSON.parse(fs.readFileSync(snapshot, 'utf8')));
const redis = new Redis(url);
const name = `archon-startup-benchmark-${process.pid}-${Date.now()}`;
const db = new DbRedis(name);
const calls = {};
const times = {};
for (const method of ['getBlock', 'getOperation', 'getEvents', 'getCandidates', 'setCandidates']) {
    const original = db[method].bind(db);
    db[method] = async (...args) => {
        const t = performance.now();
        calls[method] = (calls[method] || 0) + 1;
        const result = await original(...args);
        times[method] = (times[method] || 0) + performance.now() - t;
        return result;
    };
}
try {
    await db.start();
    let pipeline = redis.pipeline();
    async function flush() {
        const results = await pipeline.exec();
        for (const [error] of results) if (error) throw error;
        pipeline = redis.pipeline();
    }
    for (let i=0; i<histories.length; i++) {
        const [key, events] = histories[i];
        const batch = pipeline;
        const rows = events.map(({ operation, ...event }) => {
            batch.set(`${name}/ops/${event.opid}`, JSON.stringify(operation));
            return JSON.stringify(event);
        });
        if (rows.length) pipeline.rpush(`${name}/dids/${key}`, ...rows);
        pipeline.hset(`${name}/candidates`, `did:cid:${key}`, JSON.stringify(events));
        if (i%100===99) { await flush(); }
    }
    await flush();
    const gatekeeper = new Gatekeeper({db,ipfs:new MemoryClient(),registries:['hyperswarm','BTC:mainnet','BTC:signet']});
    const started = performance.now();
    if (typeof gatekeeper.initialize === 'function') {
        await gatekeeper.initialize();
    } else {
        // Baseline implementations predate the combined startup initializer.
        await gatekeeper.checkDIDs();
        await gatekeeper.initSearchIndex();
    }
    console.log(JSON.stringify({dids:histories.length,elapsed_ms:performance.now()-started,calls,times}));
    const accepted = {};
    for (let offset = 0; offset < histories.length; offset += 64) {
        await Promise.all(histories.slice(offset, offset + 64).map(async ([key]) => {
            accepted[key] = await db.getEvents(`did:cid:${key}`);
        }));
    }
    fs.writeFileSync(output, JSON.stringify(accepted), { flag: 'wx' });
    if (reference) {
        assert.deepEqual(accepted, JSON.parse(fs.readFileSync(reference)));
        console.log('All accepted histories match baseline recovery');
    }
} finally {
    await db.resetDb();
    await db.stop();
    await redis.quit();
}
