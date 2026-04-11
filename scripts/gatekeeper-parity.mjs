#!/usr/bin/env node

import fs from 'node:fs/promises';

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

        const leftBody = fixture.compareMode === 'jsonLoose' ? normalizeJson(ts.body) : ts.body;
        const rightBody = fixture.compareMode === 'jsonLoose' ? normalizeJson(rust.body) : rust.body;
        assertEqual(`${fixture.name} body`, leftBody, rightBody);
        console.log(`ok api ${fixture.name}`);
    }
}

async function runApiFlows() {
    const context = {};

    for (const flow of apiFlows) {
        let body = flow.body;
        if (flow.bodyFrom) {
            const source = flow.bodyFrom.file === 'proof-vectors.json' ? proofVectors : null;
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
        const leftBody = compareMode === 'jsonLoose' ? normalizeJson(ts.body) : ts.body;
        const rightBody = compareMode === 'jsonLoose' ? normalizeJson(rust.body) : rust.body;
        assertEqual(`${flow.name} body`, leftBody, rightBody);

        if (flow.capture?.key) {
            context[flow.capture.key] = rust.body;
        }

        console.log(`ok flow ${flow.name}`);
    }
}

function parseMetricNames(metricsText) {
    return metricsText
        .split('\n')
        .filter(line => line && !line.startsWith('#'))
        .map(line => line.split('{')[0].split(' ')[0])
        .filter(Boolean);
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
        if (!rustMetrics.includes(`route=\"${route}\"`) && !rustMetrics.includes(`route="${route}"`)) {
            console.warn(`warn metrics route label not yet observed in Rust scrape: ${route}`);
        }
    }

    console.log('ok metrics required names');
}

await runApiFixtures();
await runApiFlows();
await runMetricsChecks();
console.log('Gatekeeper parity checks passed');
