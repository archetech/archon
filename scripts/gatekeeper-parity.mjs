#!/usr/bin/env node

import fs from 'node:fs/promises';
import CipherNode from '@didcid/cipher/node';
import { generateCID } from '@didcid/ipfs/utils';
import { base64url as fuzzBase64url } from 'multiformats/bases/base64';

const tsBaseUrl = process.env.TS_GATEKEEPER_URL;
const rustBaseUrl = process.env.RUST_GATEKEEPER_URL;
const adminKey = process.env.ARCHON_ADMIN_API_KEY || '';

if (!tsBaseUrl || !rustBaseUrl) {
    console.error('Set TS_GATEKEEPER_URL and RUST_GATEKEEPER_URL before running this script.');
    process.exit(1);
}

const apiFixtures = JSON.parse(
    await fs.readFile(new URL('../tests/gatekeeper/api-parity-fixtures.json', import.meta.url), 'utf8'),
);
const apiFlows = JSON.parse(
    await fs.readFile(new URL('../tests/gatekeeper/api-parity-flows.json', import.meta.url), 'utf8'),
);
const metricsFixture = JSON.parse(
    await fs.readFile(new URL('../tests/gatekeeper/metrics-parity.json', import.meta.url), 'utf8'),
);
const proofVectors = JSON.parse(
    await fs.readFile(new URL('../tests/gatekeeper/proof-vectors.json', import.meta.url), 'utf8'),
);
const deterministicVectors = JSON.parse(
    await fs.readFile(new URL('../tests/gatekeeper/deterministic-vectors.json', import.meta.url), 'utf8'),
);
const cipher = new CipherNode();

function normalizeJson(value) {
    if (Array.isArray(value)) {
        return value.map(normalizeJson);
    }
    if (value && typeof value === 'object') {
        const copy = {};
        for (const key of Object.keys(value).sort()) {
            if (key === 'retrieved') {
                copy[key] = '<dynamic>';
                continue;
            }
            if (key === 'uptimeSeconds') {
                copy[key] = '<dynamic>';
                continue;
            }
            if (
                key === 'rss' ||
                key === 'heapTotal' ||
                key === 'heapUsed' ||
                key === 'external' ||
                key === 'arrayBuffers'
            ) {
                copy[key] = '<dynamic>';
                continue;
            }
            copy[key] = normalizeJson(value[key]);
        }
        return copy;
    }
    return value;
}

async function request(baseUrl, fixture) {
    const headers = { ...(fixture.headers || {}) };
    if (fixture.requiresAdminKey && adminKey) {
        headers['X-Archon-Admin-Key'] = adminKey;
    }

    let requestBody;
    if (fixture.rawBody !== undefined) {
        requestBody = fixture.rawBody;
    } else if (fixture.body !== undefined) {
        requestBody = JSON.stringify(fixture.body);
    }

    const response = await fetch(`${baseUrl}${fixture.path}`, {
        method: fixture.method,
        headers,
        body: requestBody,
    });

    const contentType = response.headers.get('content-type') || '';
    const rawBody = await response.text();
    let body = rawBody;
    if (contentType.includes('application/json')) {
        try {
            body = JSON.parse(rawBody);
        } catch {
            body = rawBody;
        }
    }

    return {
        status: response.status,
        headers: contentType,
        body,
    };
}

async function resetServiceState(baseUrl) {
    if (!adminKey) {
        return;
    }

    const response = await fetch(`${baseUrl}/api/v1/db/reset`, {
        method: 'GET',
        headers: {
            'X-Archon-Admin-Key': adminKey,
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to reset ${baseUrl}: ${response.status} ${await response.text()}`);
    }
}

function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pointerLookup(root, pointer) {
    return pointer.split('.').reduce((current, segment) => current?.[segment], root);
}

function renderTemplate(value, context) {
    if (typeof value === 'string') {
        return value.replace(/\{\{([^}]+)\}\}/g, (_match, key) => {
            const trimmed = key.trim();
            return context[trimmed] ?? '';
        });
    }
    if (Array.isArray(value)) {
        return value.map(item => renderTemplate(item, context));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, renderTemplate(item, context)]),
        );
    }
    return value;
}

function assertEqual(label, left, right) {
    const lhs = JSON.stringify(left);
    const rhs = JSON.stringify(right);
    if (lhs !== rhs) {
        throw new Error(`${label} mismatch\nTS:   ${lhs}\nRust: ${rhs}`);
    }
}

function normalizeErrorText(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (value && typeof value === 'object' && typeof value.error === 'string') {
        return value.error.startsWith('Error: ') ? value.error : `Error: ${value.error}`;
    }
    return value;
}

function normalizeSetLikeJson(value) {
    if (Array.isArray(value)) {
        return value
            .map(item => normalizeSetLikeJson(item))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map(key => [key, normalizeSetLikeJson(value[key])]),
        );
    }
    return value;
}

async function runApiFixtures() {
    for (const fixture of apiFixtures) {
        const ts = await request(tsBaseUrl, fixture);
        const rust = await request(rustBaseUrl, fixture);

        if (fixture.expectedStatus != null) {
            if (ts.status !== fixture.expectedStatus) {
                throw new Error(`${fixture.name}: TypeScript status ${ts.status} != expected ${fixture.expectedStatus}`);
            }
            if (rust.status !== fixture.expectedStatus) {
                throw new Error(`${fixture.name}: Rust status ${rust.status} != expected ${fixture.expectedStatus}`);
            }
        }

        assertEqual(`${fixture.name} status`, ts.status, rust.status);

        const leftBody =
            fixture.compareMode === 'jsonLoose'
                ? normalizeJson(ts.body)
                : fixture.compareMode === 'errorText'
                    ? normalizeErrorText(ts.body)
                    : fixture.compareMode === 'jsonSet'
                        ? normalizeSetLikeJson(ts.body)
                        : ts.body;
        const rightBody =
            fixture.compareMode === 'jsonLoose'
                ? normalizeJson(rust.body)
                : fixture.compareMode === 'errorText'
                    ? normalizeErrorText(rust.body)
                    : fixture.compareMode === 'jsonSet'
                        ? normalizeSetLikeJson(rust.body)
                        : rust.body;
        assertEqual(`${fixture.name} body`, leftBody, rightBody);
        console.log(`ok api ${fixture.name}`);
    }
}

async function runApiFlows() {
    const context = {};

    for (const flow of apiFlows) {
        let body = flow.body;
        if (flow.bodyFrom) {
            const source =
                flow.bodyFrom.file === 'proof-vectors.json'
                    ? proofVectors
                    : flow.bodyFrom.file === 'deterministic-vectors.json'
                        ? deterministicVectors
                        : null;
            if (!source) {
                throw new Error(`Unsupported bodyFrom file: ${flow.bodyFrom.file}`);
            }
            body = deepClone(pointerLookup(source, flow.bodyFrom.pointer));
        } else if (flow.bodyTemplate) {
            body = renderTemplate(deepClone(flow.bodyTemplate), context);
        }

        const fixture = {
            ...flow,
            path: flow.pathTemplate ? renderTemplate(flow.pathTemplate, context) : flow.path,
            body,
        };

        const ts = await request(tsBaseUrl, fixture);
        const rust = await request(rustBaseUrl, fixture);

        if (flow.expectedStatus != null) {
            if (ts.status !== flow.expectedStatus) {
                throw new Error(`${flow.name}: TypeScript status ${ts.status} != expected ${flow.expectedStatus}`);
            }
            if (rust.status !== flow.expectedStatus) {
                throw new Error(`${flow.name}: Rust status ${rust.status} != expected ${flow.expectedStatus}`);
            }
        }

        assertEqual(`${flow.name} status`, ts.status, rust.status);

        const compareMode = flow.compareMode || 'json';
        const leftBody =
            compareMode === 'jsonLoose'
                ? normalizeJson(ts.body)
                : compareMode === 'errorText'
                    ? normalizeErrorText(ts.body)
                    : compareMode === 'jsonSet'
                        ? normalizeSetLikeJson(ts.body)
                        : ts.body;
        const rightBody =
            compareMode === 'jsonLoose'
                ? normalizeJson(rust.body)
                : compareMode === 'errorText'
                    ? normalizeErrorText(rust.body)
                    : compareMode === 'jsonSet'
                        ? normalizeSetLikeJson(rust.body)
                        : rust.body;
        assertEqual(`${flow.name} body`, leftBody, rightBody);

        if (flow.capture?.key) {
            context[flow.capture.key] = rust.body;
        }

        console.log(`ok flow ${flow.name}`);
    }
}

async function runDeterministicVectorChecks() {
    for (const [name, vector] of Object.entries(deterministicVectors)) {
        const canonical = cipher.canonicalizeJSON(vector.operation);
        if (canonical !== vector.canonical) {
            throw new Error(`${name}: canonical JSON mismatch\nexpected: ${vector.canonical}\nactual:   ${canonical}`);
        }

        const cid = await generateCID(JSON.parse(canonical));
        if (cid !== vector.cid) {
            throw new Error(`${name}: CID mismatch\nexpected: ${vector.cid}\nactual:   ${cid}`);
        }

        const fixture = {
            method: 'POST',
            path: '/api/v1/did/generate',
            headers: { 'content-type': 'application/json' },
            body: vector.operation,
        };

        const ts = await request(tsBaseUrl, fixture);
        const rust = await request(rustBaseUrl, fixture);

        assertEqual(`${name} /did/generate status`, ts.status, 200);
        assertEqual(`${name} /did/generate status parity`, ts.status, rust.status);
        assertEqual(`${name} /did/generate body parity`, ts.body, rust.body);
        assertEqual(`${name} /did/generate expected`, rust.body, vector.did);

        console.log(`ok vector ${name}`);
    }
}

function parseMetricNames(metricsText) {
    const names = new Set();
    for (const line of metricsText.split('\n')) {
        if (!line) {
            continue;
        }

        if (line.startsWith('# TYPE ')) {
            const parts = line.split(/\s+/);
            if (parts[2]) {
                names.add(parts[2]);
            }
            continue;
        }

        if (!line.startsWith('#')) {
            const name = line.split('{')[0].split(' ')[0];
            if (name) {
                names.add(name);
            }
        }
    }

    return [...names];
}

async function runMetricsChecks() {
    const [tsMetrics, rustMetrics] = await Promise.all([
        fetch(`${tsBaseUrl}/metrics`).then(response => response.text()),
        fetch(`${rustBaseUrl}/metrics`).then(response => response.text()),
    ]);

    const tsMetricNames = new Set(parseMetricNames(tsMetrics));
    const rustMetricNames = new Set(parseMetricNames(rustMetrics));

    for (const metricName of metricsFixture.requiredMetricNames) {
        if (!tsMetricNames.has(metricName)) {
            throw new Error(`TypeScript metrics missing ${metricName}`);
        }
        if (!rustMetricNames.has(metricName)) {
            throw new Error(`Rust metrics missing ${metricName}`);
        }
    }

    for (const route of metricsFixture.requiredNormalizedRoutes) {
        // One check, not two: inside a template literal `\"` is just `"`, so the
        // former operand was the same expression as the latter. A raw Prometheus
        // scrape writes labels as route="value", so that is the only form there
        // is to look for.
        if (!rustMetrics.includes(`route="${route}"`)) {
            console.warn(`warn metrics route label not yet observed in Rust scrape: ${route}`);
        }
    }

    console.log('ok metrics required names');
}

// Structural fuzz: mutate a valid operation at every field and assert both
// ports reach the same verdict for each mutation. The value is the acceptance
// fork -- one port accepting a malformed operation the other rejects -- which is
// a direct consensus split and the class #1115 and #1118 belonged to.
//
// Each mutation is RE-SIGNED with a test key (except a mutation to proofValue
// itself), so a port that wrongly accepts a bad field returns 200 where the
// other returns an error, instead of both failing a stale signature and hiding
// the fork. POST /did wraps every rejection in a 500, so this compares
// acceptance vs rejection; the finer refuse-vs-Invalid-operation error class is
// not visible at this endpoint and needs a verdict surface (follow-on).
function fuzzHexToBase64url(hex) {
    return fuzzBase64url.baseEncode(Uint8Array.from(Buffer.from(hex, 'hex')));
}

const fuzzKeypair = cipher.generateRandomJwk();

function fuzzSign(op) {
    const { proof, ...unsecured } = op;
    void proof;
    return fuzzHexToBase64url(cipher.signHash(cipher.hashJSON(unsecured), fuzzKeypair.privateJwk));
}

function fuzzSeed() {
    const op = {
        type: 'create',
        created: '2026-04-11T12:00:00Z',
        publicJwk: fuzzKeypair.publicJwk,
        registration: { version: 1, type: 'agent', registry: 'local' },
    };
    op.proof = {
        type: 'EcdsaSecp256k1Signature2019',
        created: '2026-04-11T12:00:00Z',
        verificationMethod: '#key-1',
        proofPurpose: 'authentication',
        proofValue: fuzzSign(op),
    };
    return op;
}

function structuralPaths(obj, prefix = []) {
    const out = [];
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const key of Object.keys(obj)) {
            out.push([...prefix, key]);
            out.push(...structuralPaths(obj[key], [...prefix, key]));
        }
    }
    return out;
}

function mutateAt(root, path, kind, value) {
    const copy = deepClone(root);
    let node = copy;
    for (const seg of path.slice(0, -1)) node = node[seg];
    const last = path[path.length - 1];
    if (kind === 'delete') delete node[last];
    else node[last] = value;
    return copy;
}

function structuralMutations(seed) {
    const structural = [
        ['delete', undefined], ['empty-string', ''], ['null', null],
        ['number', 7], ['object', {}], ['array', []], ['bool', true],
    ];
    const timestamps = ['2026-04-11', '2026-04-11 12:00:00', '2026-04-11t12:00:00z',
        '2026-04-11T12:00:00', '2026-04-11T12:00:00+00:00', '2026', 'not-a-date'];

    const out = [];
    for (const path of structuralPaths(seed)) {
        const label = path.join('.');
        const leaf = path[path.length - 1];
        // Re-sign only operation-level mutations, which are inside the legacy
        // signed payload; a stale signature there would mask an acceptance
        // fork. Mutations under `proof` keep the seed signature -- legacy proof
        // fields are outside the signed payload, so it stays valid -- and a
        // mutation that deletes or replaces `proof` must not be re-signed at
        // all (there is no proof object to sign into).
        const reSign = path[0] !== 'proof';
        const finish = op => {
            if (reSign && op.proof && typeof op.proof === 'object') {
                op.proof.proofValue = fuzzSign(op);
            }
            return op;
        };
        for (const [kind, value] of structural) {
            out.push({ name: `${label}:${kind}`, op: finish(mutateAt(seed, path, kind, value)) });
        }
        if (leaf === 'created') {
            for (const t of timestamps) out.push({ name: `${label}:ts=${t}`, op: finish(mutateAt(seed, path, 'set', t)) });
        }
    }
    return out;
}

function errorClass(body) {
    if (body && typeof body === 'object' && typeof body.error === 'string') return body.error;
    return typeof body === 'string' ? body.slice(0, 80) : JSON.stringify(body).slice(0, 80);
}

async function runStructuralFuzz() {
    const seed = fuzzSeed();
    const post = op => ({
        method: 'POST',
        path: '/api/v1/did',
        body: op,
        requiresAdminKey: true,
        headers: { 'content-type': 'application/json' },
    });

    // Control: the unmutated seed must be accepted by both ports. Without this,
    // a broken signing/encoding path would reject every operation and the phase
    // would pass while catching nothing -- a green-but-useless test.
    const tsSeed = await request(tsBaseUrl, post(seed));
    const rustSeed = await request(rustBaseUrl, post(seed));
    if (tsSeed.status !== 200 || rustSeed.status !== 200) {
        throw new Error(`structural fuzz control: the valid seed was not accepted by both ports ` +
            `(TS ${tsSeed.status} ${errorClass(tsSeed.body)}, Rust ${rustSeed.status} ${errorClass(rustSeed.body)}); ` +
            `the fuzz results would be meaningless`);
    }
    await resetServiceState(tsBaseUrl);
    await resetServiceState(rustBaseUrl);

    const mutations = structuralMutations(seed);
    const forks = [];
    for (const mutation of mutations) {
        const ts = await request(tsBaseUrl, post(mutation.op));
        const rust = await request(rustBaseUrl, post(mutation.op));
        if (ts.status !== rust.status) {
            forks.push(`${mutation.name}: TS ${ts.status} (${errorClass(ts.body)}) vs Rust ${rust.status} (${errorClass(rust.body)})`);
        }
    }

    if (forks.length > 0) {
        for (const fork of forks) console.error(`FORK ${fork}`);
        throw new Error(`structural fuzz: ${forks.length} acceptance divergence(s) across ${mutations.length} mutations`);
    }
    console.log(`ok structural fuzz: ${mutations.length} mutations agree on accept/reject`);
}

await resetServiceState(tsBaseUrl);
await resetServiceState(rustBaseUrl);
await runApiFixtures();
await runDeterministicVectorChecks();
await runApiFlows();
await resetServiceState(tsBaseUrl);
await resetServiceState(rustBaseUrl);
await runStructuralFuzz();
await runMetricsChecks();
console.log('Gatekeeper parity checks passed');
