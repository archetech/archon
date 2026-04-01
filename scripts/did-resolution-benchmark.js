#!/usr/bin/env node

import { program } from 'commander';
import dotenv from 'dotenv';
import fs from 'fs';
import process from 'process';
import { performance } from 'perf_hooks';

dotenv.config();

function percentile(sorted, p) {
    if (sorted.length === 0) {
        return 0;
    }

    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[index];
}

function formatMs(value) {
    return `${value.toFixed(2)} ms`;
}

function buildHeaders(adminKey) {
    const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    };

    if (adminKey) {
        headers.Authorization = `Bearer ${adminKey}`;
    }

    return headers;
}

function buildResolveUrl(baseUrl, did, options) {
    const url = new URL(`/api/v1/did/${encodeURIComponent(did)}`, baseUrl);

    if (options.confirm) {
        url.searchParams.set('confirm', 'true');
    }

    if (options.verify) {
        url.searchParams.set('verify', 'true');
    }

    if (options.versionTime) {
        url.searchParams.set('versionTime', options.versionTime);
    }

    if (Number.isInteger(options.versionSequence)) {
        url.searchParams.set('versionSequence', String(options.versionSequence));
    }

    return url;
}

async function requestJson(url, init, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const text = await response.text();
        let body = text || null;

        if (text) {
            try {
                body = JSON.parse(text);
            }
            catch {
                body = text;
            }
        }

        return { response, body };
    }
    finally {
        clearTimeout(timeout);
    }
}

async function fetchDids(baseUrl, adminKey, limit, confirm) {
    const url = new URL('/api/v1/dids/', baseUrl);
    const { response, body } = await requestJson(
        url,
        {
            method: 'POST',
            headers: buildHeaders(adminKey),
            body: JSON.stringify({ confirm }),
        },
        30_000,
    );

    if (!response.ok) {
        throw new Error(`failed to fetch DID list: ${response.status} ${response.statusText}`);
    }

    if (!Array.isArray(body)) {
        throw new Error('Gatekeeper returned a non-array DID list');
    }

    return body.slice(0, limit).map(item => typeof item === 'string' ? item : item?.didDocument?.id).filter(Boolean);
}

function readDidsFromFile(pathname) {
    return fs
        .readFileSync(pathname, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
}

function summarize(results, startedAt, finishedAt) {
    const durations = results
        .filter(result => result.ok)
        .map(result => result.durationMs)
        .sort((a, b) => a - b);

    const failures = results.filter(result => !result.ok);
    const successCount = durations.length;
    const totalCount = results.length;
    const wallMs = finishedAt - startedAt;
    const avg = successCount ? durations.reduce((sum, value) => sum + value, 0) / successCount : 0;

    return {
        totalCount,
        successCount,
        failureCount: failures.length,
        wallMs,
        throughput: wallMs > 0 ? (successCount / wallMs) * 1000 : 0,
        minMs: successCount ? durations[0] : 0,
        maxMs: successCount ? durations[durations.length - 1] : 0,
        avgMs: avg,
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
        p99Ms: percentile(durations, 99),
        failures,
    };
}

function printHumanSummary(summary, didCount) {
    console.log(`DIDs tested: ${didCount}`);
    console.log(`Requests: ${summary.totalCount}`);
    console.log(`Successes: ${summary.successCount}`);
    console.log(`Failures: ${summary.failureCount}`);
    console.log(`Wall time: ${formatMs(summary.wallMs)}`);
    console.log(`Throughput: ${summary.throughput.toFixed(2)} req/s`);

    if (summary.successCount > 0) {
        console.log(`Latency min/avg/max: ${formatMs(summary.minMs)} / ${formatMs(summary.avgMs)} / ${formatMs(summary.maxMs)}`);
        console.log(`Latency p50/p95/p99: ${formatMs(summary.p50Ms)} / ${formatMs(summary.p95Ms)} / ${formatMs(summary.p99Ms)}`);
    }

    if (summary.failures.length > 0) {
        console.log('\nFailures:');
        for (const failure of summary.failures.slice(0, 10)) {
            console.log(`- ${failure.did}: ${failure.error}`);
        }

        if (summary.failures.length > 10) {
            console.log(`- ... ${summary.failures.length - 10} more`);
        }
    }
}

program
    .name('did-resolution-benchmark')
    .description('Benchmark DID resolution latency via the Gatekeeper HTTP API')
    .argument('[dids...]', 'one or more DIDs to resolve; if omitted, fetch a sample from Gatekeeper')
    .option('-b, --base-url <url>', 'Gatekeeper base URL', process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224')
    .option('-i, --iterations <count>', 'number of resolution requests to make', value => parseInt(value, 10), 100)
    .option('-c, --concurrency <count>', 'number of concurrent workers', value => parseInt(value, 10), 1)
    .option('-f, --file <path>', 'read DIDs from a file, one per line')
    .option('-l, --limit <count>', 'when auto-fetching DIDs, cap the sample size', value => parseInt(value, 10), 100)
    .option('--confirm', 'pass confirm=true')
    .option('--verify', 'pass verify=true')
    .option('--version-time <iso8601>', 'pass versionTime=<iso8601>')
    .option('--version-sequence <number>', 'pass versionSequence=<number>', value => parseInt(value, 10))
    .option('--timeout-ms <ms>', 'per-request timeout in milliseconds', value => parseInt(value, 10), 10_000)
    .option('--admin-key <key>', 'send Bearer auth to Gatekeeper')
    .option('--json', 'print the summary as JSON')
    .action(async (dids, options) => {
        const adminKey = options.adminKey || process.env.ARCHON_ADMIN_API_KEY;
        const requestedDids = [];

        if (options.file) {
            requestedDids.push(...readDidsFromFile(options.file));
        }

        if (Array.isArray(dids) && dids.length > 0) {
            requestedDids.push(...dids);
        }

        const uniqueDids = [...new Set(requestedDids)];
        const resolvedDids = uniqueDids.length > 0
            ? uniqueDids
            : await fetchDids(options.baseUrl, adminKey, options.limit, !!options.confirm);

        if (resolvedDids.length === 0) {
            throw new Error('no DIDs available to benchmark');
        }

        if (!Number.isInteger(options.iterations) || options.iterations < 1) {
            throw new Error('--iterations must be a positive integer');
        }

        if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
            throw new Error('--concurrency must be a positive integer');
        }

        const sharedOptions = {
            confirm: !!options.confirm,
            verify: !!options.verify,
            versionTime: options.versionTime,
            versionSequence: options.versionSequence,
        };

        const headers = buildHeaders(adminKey);
        const jobs = Array.from({ length: options.iterations }, (_, index) => resolvedDids[index % resolvedDids.length]);
        const results = [];
        let cursor = 0;
        const startedAt = performance.now();

        async function worker() {
            while (true) {
                const index = cursor;
                cursor += 1;

                if (index >= jobs.length) {
                    return;
                }

                const did = jobs[index];
                const url = buildResolveUrl(options.baseUrl, did, sharedOptions);
                const requestStarted = performance.now();

                try {
                    const { response, body } = await requestJson(
                        url,
                        {
                            method: 'GET',
                            headers,
                        },
                        options.timeoutMs,
                    );

                    const durationMs = performance.now() - requestStarted;

                    if (!response.ok) {
                        results.push({
                            ok: false,
                            did,
                            durationMs,
                            error: `${response.status} ${response.statusText}${body?.error ? `: ${body.error}` : ''}`,
                        });
                        continue;
                    }

                    results.push({
                        ok: true,
                        did,
                        durationMs,
                    });
                }
                catch (error) {
                    const durationMs = performance.now() - requestStarted;
                    results.push({
                        ok: false,
                        did,
                        durationMs,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }

        await Promise.all(Array.from({ length: options.concurrency }, () => worker()));

        const finishedAt = performance.now();
        const summary = summarize(results, startedAt, finishedAt);

        if (options.json) {
            console.log(JSON.stringify({
                baseUrl: options.baseUrl,
                didCount: resolvedDids.length,
                dids: resolvedDids,
                iterations: options.iterations,
                concurrency: options.concurrency,
                confirm: !!options.confirm,
                verify: !!options.verify,
                versionTime: options.versionTime || null,
                versionSequence: Number.isInteger(options.versionSequence) ? options.versionSequence : null,
                timeoutMs: options.timeoutMs,
                authenticated: !!adminKey,
                summary,
            }, null, 2));
            return;
        }

        printHumanSummary(summary, resolvedDids.length);
    });

program.parseAsync(process.argv).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
