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
// A confirmed resolution stops at the last confirmed version. The Rust store
// resolver judged confirmation by the previous event's state and applied the
// first unconfirmed one, so the two ports resolved a controller with a pending
// update to different versions -- and, once a rotation is pending, to
// different keys, forking on every asset operation in that window. Nothing
// declarative reaches this: the update has to chain to a DID created in the
// run, so it is built and signed here.
async function runConfirmParity() {
    const keypair = cipher.generateRandomJwk();
    const sign = op => {
        const { proof, ...unsecured } = op;
        void proof;
        return fuzzHexToBase64url(cipher.signHash(cipher.hashJSON(unsecured), keypair.privateJwk));
    };
    const post = (path, body) => ({ method: 'POST', path, body, requiresAdminKey: true, headers: { 'content-type': 'application/json' } });
    const get = path => ({ method: 'GET', path, requiresAdminKey: true });
    const both = fixture => Promise.all([request(tsBaseUrl, fixture), request(rustBaseUrl, fixture)]);

    const createOp = {
        type: 'create',
        created: '2026-04-11T12:00:00Z',
        publicJwk: keypair.publicJwk,
        registration: { version: 1, type: 'agent', registry: 'local' },
    };
    createOp.proof = {
        type: 'EcdsaSecp256k1Signature2019',
        created: '2026-04-11T12:00:00Z',
        verificationMethod: '#key-1',
        proofPurpose: 'authentication',
        proofValue: sign(createOp),
    };
    const [tsCreate, rustCreate] = await both(post('/api/v1/did', createOp));
    if (tsCreate.status !== 200 || rustCreate.status !== 200 || tsCreate.body !== rustCreate.body) {
        throw new Error(`confirm parity: agent create disagreed (TS ${tsCreate.status} ${JSON.stringify(tsCreate.body)}, Rust ${rustCreate.status} ${JSON.stringify(rustCreate.body)})`);
    }
    const did = tsCreate.body;

    const [tsV1] = await both(get(`/api/v1/did/${did}`));
    const updateOp = {
        type: 'update',
        did,
        previd: tsV1.body.didDocumentMetadata.versionId,
        doc: { didDocumentData: { displayName: 'pending' } },
    };
    updateOp.proof = {
        type: 'EcdsaSecp256k1Signature2019',
        created: '2026-04-11T12:05:00Z',
        verificationMethod: `${did}#key-1`,
        proofPurpose: 'authentication',
        proofValue: sign(updateOp),
    };

    // The update arrives as a hyperswarm event: unconfirmed for a local DID.
    const event = { registry: 'hyperswarm', time: '2026-04-11T12:05:00Z', ordinal: [1], operation: updateOp };
    const [tsImport, rustImport] = await both(post('/api/v1/batch/import', [event]));
    if (tsImport.status !== 200 || rustImport.status !== 200) {
        throw new Error(`confirm parity: import disagreed (TS ${tsImport.status}, Rust ${rustImport.status})`);
    }
    await both({ method: 'POST', path: '/api/v1/events/process', requiresAdminKey: true });

    const [tsPlain, rustPlain] = await both(get(`/api/v1/did/${did}`));
    assertEqual('confirm parity: unconfirmed resolution', normalizeJson(tsPlain.body), normalizeJson(rustPlain.body));
    if (tsPlain.body.didDocumentMetadata.versionSequence !== '2') {
        throw new Error(`confirm parity: the unconfirmed update did not apply (version ${tsPlain.body.didDocumentMetadata.versionSequence}); the check would be vacuous`);
    }

    const [tsConfirmed, rustConfirmed] = await both(get(`/api/v1/did/${did}?confirm=true`));
    assertEqual('confirm parity: confirmed resolution', normalizeJson(tsConfirmed.body), normalizeJson(rustConfirmed.body));
    const metadata = tsConfirmed.body.didDocumentMetadata;
    if (metadata.versionSequence !== '1' || metadata.confirmed !== true) {
        throw new Error(`confirm parity: confirmed resolution must stop at v1 and say so, got v${metadata.versionSequence} confirmed=${metadata.confirmed}`);
    }
    console.log('ok confirm parity: both ports stop a confirmed resolution before the first unconfirmed event');
}

await resetServiceState(tsBaseUrl);
await resetServiceState(rustBaseUrl);
await runStructuralFuzz();
// The backdating gate (#1131), end to end on both ports through the paths a
// mediator uses. A controller is confirmed on chain with a rotation; an
// operation signed with the retired key and dated before the rotation is
// committed by the chain after it, and both ports must refuse it -- while one
// the chain committed earlier in the rotation's own block must be accepted
// (#1136). And a chain event handed in through the relay ingress must land as
// an unconfirmed hint on both. Every operation is pinned to the shared IPFS
// first so both ports fetch identical bytes by CID.
async function runBackdatingParity() {
    const legacyProof = (op, keypair, verificationMethod, created) => {
        const { proof, ...unsecured } = op;
        void proof;
        return {
            type: 'EcdsaSecp256k1Signature2019',
            created,
            verificationMethod,
            proofPurpose: 'authentication',
            proofValue: fuzzHexToBase64url(cipher.signHash(cipher.hashJSON(unsecured), keypair.privateJwk)),
        };
    };
    const post = (path, body) => ({ method: 'POST', path, body, requiresAdminKey: true, headers: { 'content-type': 'application/json' } });
    const get = path => ({ method: 'GET', path, requiresAdminKey: true });
    const both = fixture => Promise.all([request(tsBaseUrl, fixture), request(rustBaseUrl, fixture)]);
    const agree = (label, [ts, rust]) => {
        if (ts.status !== rust.status) {
            throw new Error(`${label}: status disagreed (TS ${ts.status}, Rust ${rust.status})`);
        }
        assertEqual(label, normalizeJson(ts.body), normalizeJson(rust.body));
        return ts;
    };
    // Pinned in canonical form, as an anchoring node pins the operations it
    // queues, so the CID is the one both ports compute for the operation.
    // `POST /ipfs/json` encodes the body as sent, and a non-canonical CID is
    // an input no mediator produces.
    const pin = async op => {
        const pinned = await request(tsBaseUrl, post('/api/v1/ipfs/json', JSON.parse(cipher.canonicalizeJSON(op))));
        if (pinned.status !== 200 || typeof pinned.body !== 'string') {
            throw new Error(`backdating parity: pin failed (${pinned.status} ${JSON.stringify(pinned.body)})`);
        }
        return pinned.body;
    };
    // What a chain mediator does for one block: import the block's operations
    // by CID with the block's position, then apply.
    const commit = async (cids, height, time) => {
        const imported = agree(`backdating parity: commit block ${height}`, await both(post('/api/v1/batch/import/cids', {
            cids,
            metadata: { registry: 'BTC:signet', time, ordinal: [height], registration: { height, index: 0, txid: `tx${height}`, batch: `b${height}` } },
        })));
        if (imported.body.rejected !== 0) {
            throw new Error(`backdating parity: block ${height} import rejected ${imported.body.rejected} operation(s) before processing`);
        }
        return agree(`backdating parity: process block ${height}`, await both({ method: 'POST', path: '/api/v1/events/process', requiresAdminKey: true }));
    };
    const T = hours => new Date(Date.UTC(2026, 3, 11, 12 + hours, 0, 0)).toISOString();

    const setup = async () => {
        const k1 = cipher.generateRandomJwk();
        const k2 = cipher.generateRandomJwk();
        const createOp = { type: 'create', created: T(0), publicJwk: k1.publicJwk, registration: { version: 1, type: 'agent', registry: 'BTC:signet' } };
        createOp.proof = legacyProof(createOp, k1, '#key-1', T(0));
        const alice = agree('backdating parity: create controller', await both(post('/api/v1/did', createOp))).body;

        const assetOp = { type: 'create', created: T(0), registration: { version: 1, type: 'asset', registry: 'BTC:signet' }, controller: alice, data: { mock: true } };
        assetOp.proof = legacyProof(assetOp, k1, `${alice}#key-1`, T(0));
        const asset = agree('backdating parity: create asset', await both(post('/api/v1/did', assetOp))).body;

        const v1 = agree('backdating parity: resolve controller v1', await both(get(`/api/v1/did/${alice}`))).body;
        const rotated = JSON.parse(JSON.stringify(v1.didDocument));
        rotated.verificationMethod[0].publicKeyJwk = k2.publicJwk;
        const rotationOp = { type: 'update', did: alice, previd: v1.didDocumentMetadata.versionId, doc: { didDocument: rotated } };
        rotationOp.proof = legacyProof(rotationOp, k1, `${alice}#key-1`, T(0));
        agree('backdating parity: rotate controller', await both(post('/api/v1/did', rotationOp)));

        const cids = { create: await pin(createOp), asset: await pin(assetOp), rotation: await pin(rotationOp) };
        return { k1, k2, alice, asset, cids };
    };
    const forgeryOn = async (asset, alice, k1, created, data) => {
        const current = agree('backdating parity: resolve asset', await both(get(`/api/v1/did/${asset}`))).body;
        const op = { type: 'update', did: asset, previd: current.didDocumentMetadata.versionId, doc: { didDocumentData: data } };
        op.proof = legacyProof(op, k1, `${alice}#key-1`, created);
        return op;
    };

    // 1. Committed after the rotation: refused by both.
    {
        const { k1, k2, alice, asset, cids } = await setup();
        await commit([cids.create, cids.asset], 100, T(0));
        await commit([cids.rotation], 200, T(1));
        const confirmed = agree('backdating parity: controller confirmed', await both(get(`/api/v1/did/${alice}?confirm=true`))).body;
        if (confirmed.didDocumentMetadata.confirmed !== true || JSON.stringify(confirmed.didDocument.verificationMethod[0].publicKeyJwk) !== JSON.stringify(k2.publicJwk)) {
            throw new Error('backdating parity: the rotation did not confirm; the forgery check would be vacuous');
        }

        const forged = await forgeryOn(asset, alice, k1, T(0), { stolen: true });
        const processed = await commit([await pin(forged)], 300, T(2));
        if (processed.body.rejected !== 1 || processed.body.added !== 0) {
            throw new Error(`backdating parity: a forgery committed after the rotation was not refused (${JSON.stringify(processed.body)})`);
        }
        const after = agree('backdating parity: asset after forgery', await both(get(`/api/v1/did/${asset}?confirm=true`))).body;
        if (after.didDocumentData?.stolen === true) {
            throw new Error('backdating parity: the forgery reached the confirmed document');
        }
    }

    // 2. Committed earlier in the rotation's own block: accepted by both.
    await resetServiceState(tsBaseUrl);
    await resetServiceState(rustBaseUrl);
    {
        const { k1, alice, asset, cids } = await setup();
        await commit([cids.create, cids.asset], 100, T(0));
        const genuine = await forgeryOn(asset, alice, k1, T(0), { legit: true });
        const processed = await commit([await pin(genuine), cids.rotation], 200, T(1));
        if (processed.body.rejected !== 0 || processed.body.added !== 2) {
            throw new Error(`backdating parity: an operation committed before the rotation in the same block was not accepted (${JSON.stringify(processed.body)})`);
        }
        const after = agree('backdating parity: asset after same-block', await both(get(`/api/v1/did/${asset}?confirm=true`))).body;
        if (after.didDocumentData?.legit !== true) {
            throw new Error('backdating parity: the genuine operation did not reach the confirmed document');
        }
    }

    // 3. A chain event through the relay ingress is a hint on both.
    await resetServiceState(tsBaseUrl);
    await resetServiceState(rustBaseUrl);
    {
        const keypair = cipher.generateRandomJwk();
        const createOp = { type: 'create', created: T(0), publicJwk: keypair.publicJwk, registration: { version: 1, type: 'agent', registry: 'BTC:signet' } };
        createOp.proof = legacyProof(createOp, keypair, '#key-1', T(0));
        const did = agree('backdating parity: relay create', await both(post('/api/v1/did', createOp))).body;
        const claimed = { registry: 'BTC:signet', time: T(0), ordinal: [100, 0], registration: { height: 100, index: 0, txid: 'tx100', batch: 'b100' }, operation: createOp };
        agree('backdating parity: relay import', await both(post('/api/v1/batch/import', [claimed])));
        agree('backdating parity: relay process', await both({ method: 'POST', path: '/api/v1/events/process', requiresAdminKey: true }));
        const exported = agree('backdating parity: relay export', await both(post('/api/v1/batch/export', { dids: [did] }))).body;
        if (exported[0].registry !== 'local' || exported[0].registration !== undefined) {
            throw new Error(`backdating parity: a relayed chain event was honoured as confirmed (${JSON.stringify(exported[0].registry)})`);
        }
    }

    // 4. The same complete set of operations reaches fresh nodes with the
    //    rotation and the forgery relayed in both orders; the confirmed
    //    verdict must agree across the ports and across the orders. Nothing
    //    but the two creates is applied before the relays land.
    await resetServiceState(tsBaseUrl);
    await resetServiceState(rustBaseUrl);
    {
        const k1 = cipher.generateRandomJwk();
        const k2 = cipher.generateRandomJwk();
        const createOp = { type: 'create', created: T(0), publicJwk: k1.publicJwk, registration: { version: 1, type: 'agent', registry: 'BTC:signet' } };
        createOp.proof = legacyProof(createOp, k1, '#key-1', T(0));
        const alice = agree('backdating parity: permute create', await both(post('/api/v1/did', createOp))).body;
        const assetOp = { type: 'create', created: T(0), registration: { version: 1, type: 'asset', registry: 'BTC:signet' }, controller: alice, data: { mock: true } };
        assetOp.proof = legacyProof(assetOp, k1, `${alice}#key-1`, T(0));
        const asset = agree('backdating parity: permute asset', await both(post('/api/v1/did', assetOp))).body;
        const v1 = agree('backdating parity: permute v1', await both(get(`/api/v1/did/${alice}`))).body;
        const rotated = JSON.parse(JSON.stringify(v1.didDocument));
        rotated.verificationMethod[0].publicKeyJwk = k2.publicJwk;
        const rotationOp = { type: 'update', did: alice, previd: v1.didDocumentMetadata.versionId, doc: { didDocument: rotated } };
        rotationOp.proof = legacyProof(rotationOp, k1, `${alice}#key-1`, T(0));
        const forged = await forgeryOn(asset, alice, k1, T(0), { stolen: true });
        const cids = { create: await pin(createOp), asset: await pin(assetOp), rotation: await pin(rotationOp), forgery: await pin(forged) };
        const relay = (height, time, operation) => ({ registry: 'BTC:signet', time, ordinal: [height, 0], registration: { height, index: 0, txid: `tx${height}`, batch: `b${height}` }, operation });
        const rotationEvent = relay(200, T(1), rotationOp);
        const forgeryEvent = relay(300, T(2), forged);

        const outcomes = [];
        for (const forgeryFirst of [false, true]) {
            await resetServiceState(tsBaseUrl);
            await resetServiceState(rustBaseUrl);
            agree('backdating parity: permute recreate', await both(post('/api/v1/did', createOp)));
            agree('backdating parity: permute recreate asset', await both(post('/api/v1/did', assetOp)));
            for (const event of forgeryFirst ? [forgeryEvent, rotationEvent] : [rotationEvent, forgeryEvent]) {
                agree('backdating parity: permute relay', await both(post('/api/v1/batch/import', [event])));
                agree('backdating parity: permute relay process', await both({ method: 'POST', path: '/api/v1/events/process', requiresAdminKey: true }));
            }
            await commit([cids.create, cids.asset], 100, T(0));
            await commit([cids.rotation], 200, T(1));
            await commit([cids.forgery], 300, T(2));
            const controller = agree(`backdating parity: permute controller (forgery first: ${forgeryFirst})`, await both(get(`/api/v1/did/${alice}?confirm=true`))).body;
            const after = agree(`backdating parity: permute asset (forgery first: ${forgeryFirst})`, await both(get(`/api/v1/did/${asset}?confirm=true`))).body;
            outcomes.push({ key: controller.didDocument.verificationMethod[0].publicKeyJwk, data: after.didDocumentData });
        }
        if (JSON.stringify(outcomes[0]) !== JSON.stringify(outcomes[1])) {
            throw new Error(`backdating parity: the confirmed verdict depended on relay order\n${JSON.stringify(outcomes[0])}\n${JSON.stringify(outcomes[1])}`);
        }
        if (JSON.stringify(outcomes[0].key) !== JSON.stringify(k2.publicJwk) || outcomes[0].data?.stolen === true) {
            throw new Error(`backdating parity: permuted relay ended with the wrong confirmed state ${JSON.stringify(outcomes[0])}`);
        }
    }

    // Event authorization selects one document. K2 is valid at the anchor,
    // although proof.created names a time before K2's rotation. Import and
    // verified replay must not add a second check against the old document.
    for (const kind of ['create', 'update', 'delete']) {
        await resetServiceState(tsBaseUrl);
        await resetServiceState(rustBaseUrl);
        const { k2, alice, asset, cids } = await setup();
        await commit([cids.create, cids.asset], 100, T(0));
        await commit([cids.rotation], 200, T(1));
        let operation;
        if (kind === 'create') {
            operation = { type: 'create', created: T(0), registration: { version: 1, type: 'asset', registry: 'BTC:signet' }, controller: alice, data: { authorized: true } };
        } else {
            const current = agree('event authorization: previous asset', await both(get(`/api/v1/did/${asset}`))).body;
            operation = { type: kind, did: asset, previd: current.didDocumentMetadata.versionId };
            if (kind === 'update') operation.doc = { didDocumentData: { authorized: true } };
        }
        operation.proof = legacyProof(operation, k2, `${alice}#key-1`, T(0));
        const cid = await pin(operation);
        const applied = await commit([cid], 300, T(2));
        if (applied.body.added !== 1 || applied.body.rejected !== 0 || applied.body.pending !== 0) {
            throw new Error(`event authorization: ${kind} did not accept the chain-selected authority: ${JSON.stringify(applied.body)}`);
        }
        const did = kind === 'create' ? `${alice.slice(0, alice.lastIndexOf(':'))}:${cid}` : asset;
        const plain = agree(`event authorization: ${kind} resolve`, await both(get(`/api/v1/did/${did}?confirm=true`)));
        const replay = agree(`event authorization: ${kind} replay`, await both(get(`/api/v1/did/${did}?confirm=true&verify=true`)));
        if (plain.status !== 200 || replay.status !== 200) {
            throw new Error(`event authorization: ${kind} resolution or replay failed`);
        }
        assertEqual(`event authorization: ${kind} replay matches import`, normalizeJson(plain.body), normalizeJson(replay.body));
        if (kind === 'delete' ? replay.body.didDocumentMetadata?.deactivated !== true : replay.body.didDocumentData?.authorized !== true) {
            throw new Error(`event authorization: ${kind} resolved the wrong state`);
        }
    }

    // A competing agent rotation must verify against its named predecessor,
    // even when a later rotation with a different key is already installed.
    await resetServiceState(tsBaseUrl);
    await resetServiceState(rustBaseUrl);
    {
        const { k1, alice, cids } = await setup();
        await commit([cids.create], 100, T(0));
        await commit([cids.rotation], 300, T(2));
        const v1 = agree('event authorization: reorg predecessor', await both(get(`/api/v1/did/${alice}?versionSequence=1`))).body;
        const k3 = cipher.generateRandomJwk();
        const replacementDoc = JSON.parse(JSON.stringify(v1.didDocument));
        replacementDoc.verificationMethod[0].publicKeyJwk = k3.publicJwk;
        const replacement = { type: 'update', did: alice, previd: v1.didDocumentMetadata.versionId, doc: { didDocument: replacementDoc } };
        replacement.proof = legacyProof(replacement, k1, `${alice}#key-1`, T(0));
        const result = await commit([await pin(replacement)], 200, T(1));
        if (result.body.added !== 1 || result.body.rejected !== 0 || result.body.pending !== 0) {
            throw new Error(`event authorization: competing rotation did not use its predecessor: ${JSON.stringify(result.body)}`);
        }
        const replay = agree('event authorization: reorg replay', await both(get(`/api/v1/did/${alice}?confirm=true&verify=true`)));
        if (replay.status !== 200 || replay.body.didDocumentMetadata?.versionSequence !== '2') {
            throw new Error('event authorization: competing rotation replay failed');
        }
        assertEqual('event authorization: competing rotation key', normalizeJson(replay.body.didDocument.verificationMethod[0].publicKeyJwk), normalizeJson(k3.publicJwk));
    }

    console.log('ok backdating parity: both ports refuse a proof the chain committed after the rotation, accept one committed before it, downgrade relayed claims, agree whichever order relays arrive in, and use one authority on import and replay');
}

await resetServiceState(tsBaseUrl);
await resetServiceState(rustBaseUrl);
await runConfirmParity();
await resetServiceState(tsBaseUrl);
await resetServiceState(rustBaseUrl);
await runBackdatingParity();
await runMetricsChecks();
console.log('Gatekeeper parity checks passed');
