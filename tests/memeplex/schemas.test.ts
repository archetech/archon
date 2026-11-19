import { readFileSync, writeFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { generateCID } from '@didcid/ipfs/utils';
import type { Operation } from '@didcid/gatekeeper/types';
import { execFileSync } from 'node:child_process';
import { schemas, validateGrant, validateGrantRequest, validateObject } from '@didcid/memeplex';
import { KINDS, SCHEMAS, build } from './vectors.ts';
import type { SchemaName } from './vectors.ts';
import type { Vectors } from './vectors.ts';

// The Memeplex v1 schemas in share/schema/memeplex/v1, the normative text they
// publish in docs/plans/memeplex-reference-1436.md, and signed objects that show
// what they accept.
//
// MEMEPLEX_WRITE_VECTORS=1 writes the fixture file from the builder.

const FIXTURE = new URL('../fixtures/memeplex-v1-vectors.json', import.meta.url).pathname;

function readSchema(name: SchemaName): Record<string, any> {
    return JSON.parse(readFileSync(new URL(`../../share/schema/memeplex/v1/${name}.json`, import.meta.url), 'utf8'));
}
const reference = readFileSync(new URL('../../docs/plans/memeplex-reference-1436.md', import.meta.url), 'utf8');

function section(from: string, to: string): string {
    const text = reference.split(from)[1]?.split(to)[0];
    if (text === undefined) throw new Error(`no section between "${from}" and "${to}"`);
    return text;
}

const schemaText = section('### Schema text', '### Checks beyond the schemas');
const blocks = [...schemaText.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
const [commonDefs, ...bodies] = blocks;

// The definitions a schema refers to, and the ones those refer to.
function referenced(node: unknown, found = new Set<string>()): Set<string> {
    if (Array.isArray(node)) {
        node.forEach(item => referenced(item, found));
    }
    else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            if (key === '$ref' && typeof value === 'string') {
                const name = value.replace('#/$defs/', '');
                if (!found.has(name)) {
                    found.add(name);
                    referenced(commonDefs[name], found);
                }
            }
            else {
                referenced(value, found);
            }
        }
    }
    return found;
}

describe('the published schemas', () => {
    it('are one for each schema the reference gives', () => {
        expect(bodies).toHaveLength(SCHEMAS.length);
    });

    it.each(SCHEMAS.map((name, index) => [name, index] as const))('%s is the reference text, standing alone', (name, index) => {
        const { $schema, $defs, ...body } = readSchema(name);
        const used = referenced(bodies[index]);

        expect($schema).toBe('https://json-schema.org/draft/2020-12/schema');
        expect(body).toStrictEqual(bodies[index]);
        expect(Object.keys($defs).sort()).toStrictEqual([...used].sort());
        for (const defined of used) {
            expect($defs[defined]).toStrictEqual(commonDefs[defined]);
        }
    });

    // Keymaster's createSchema takes a schema only if it has both.
    it.each(SCHEMAS)('%s can be published as a schema asset', name => {
        const schema = readSchema(name);

        expect(schema).toHaveProperty('$schema');
        expect(schema).toHaveProperty('properties');
    });

    // The package carries the schemas and validators compiled from them. Both are
    // generated, and a schema file changed without them would leave the verifier
    // judging by the old text.
    it('are the ones the verifier package is generated from', () => {
        for (const name of SCHEMAS) {
            expect(schemas[name]).toStrictEqual(readSchema(name));
        }
        expect(() => execFileSync('node', ['packages/memeplex/scripts/generate.mjs', '--check'], { stdio: 'pipe' })).not.toThrow();
    });

    it.each(Object.entries(KINDS))('%s lists every field of the field table', (kind, { allowed, required }) => {
        const schema = readSchema(kind as keyof typeof KINDS as never);
        const fields = Object.keys(schema.properties).filter(name => !['v', 'kind', 'author', 'grant'].includes(name));
        const permitted = fields.filter(name => schema.properties[name] !== false);

        expect(fields.sort()).toStrictEqual([...new Set(Object.values(KINDS).flatMap(each => each.allowed))].sort());
        expect(permitted.sort()).toStrictEqual([...allowed].sort());
        expect([...schema.required].sort()).toStrictEqual(['v', 'kind', ...required].sort());
    });
});

describe('the signed vectors', () => {
    let vectors: Vectors;

    beforeAll(async () => {
        const built = await build();
        if (process.env.MEMEPLEX_WRITE_VECTORS) {
            writeFileSync(FIXTURE, `${JSON.stringify(built, null, 1)}\n`);
        }
        vectors = JSON.parse(readFileSync(FIXTURE, 'utf8'));
        expect(vectors).toStrictEqual(JSON.parse(JSON.stringify(built)));
    }, 60_000);

    it('are operations a Gatekeeper accepts, each creating the DID it is given', async () => {
        const gatekeeper = new Gatekeeper({
            db: new DbJsonMemory('memeplex'),
            ipfs: new MemoryClient(),
            registries: ['hyperswarm', vectors.registry],
            // Nothing drains the registry's queue here, and a Gatekeeper stops
            // taking operations for a registry whose queue is full.
            maxQueueSize: 10_000,
        });
        const created = [
            ...Object.values(vectors.identities),
            ...Object.values(vectors.assets),
            ...vectors.cases.filter(each => each.operation).map(each => ({ did: each.did!, operation: each.operation! })),
        ];

        for (const { did, operation } of created) {
            expect(did).toBe(`did:cid:${await generateCID(operation, { canonical: true })}`);
            await expect(gatekeeper.createDID(operation as unknown as Operation)).resolves.toBe(did);
        }
        expect(new Set(created.map(each => each.did)).size).toBe(created.length);
    // Each operation's signature is verified; together they take several seconds.
    }, 60_000);

    it('have the outcome each one states', () => {
        const wrong = vectors.cases
            .map(each => {
                const data = each.request ?? (each.operation!.data as Record<string, unknown>)[each.member];
                // An object is judged by the schema its own kind names; a grant by the grant's.
                const got = each.member === 'memeplex' ? validateObject(data)
                    : each.member === 'memeplexGrant' ? validateGrant(data) : validateGrantRequest(data);
                return { name: each.name, expect: each.expect, got };
            })
            .filter(each => each.got !== each.expect);

        expect(wrong).toStrictEqual([]);
    });

    it('show every outcome', () => {
        expect([...new Set(vectors.cases.map(each => each.expect))].sort()).toStrictEqual(
            ['expiry-instant', 'kind', 'paper-authors', 'rating-bounds', 'schema', 'unsupported', 'valid', 'version']);
    });

    it('cover every required field and every field of another kind, for each kind', () => {
        const names = new Set(vectors.cases.map(each => each.name));
        const missing: string[] = [];

        for (const kind of Object.keys(KINDS)) {
            const schema = readSchema(kind as never);
            for (const field of schema.required.filter((name: string) => !['v', 'kind'].includes(name))) {
                if (!names.has(`${kind}: lacks ${field}`)) missing.push(`${kind}: lacks ${field}`);
            }
            for (const [field, rule] of Object.entries(schema.properties)) {
                if (rule === false && !names.has(`${kind}: has ${field}`)) missing.push(`${kind}: has ${field}`);
            }
        }
        expect(missing).toStrictEqual([]);
    });

    it('carry the grant each object names, created by its author for the client that signed the object', () => {
        const grants = new Map(vectors.cases.filter(each => each.schema === 'grant').map(each => [each.did, each.operation!]));
        const objects = vectors.cases.filter(each => each.member === 'memeplex' && each.expect === 'valid');

        expect(objects.length).toBeGreaterThan(0);
        for (const { operation } of objects) {
            const memeplex = (operation!.data as Record<string, any>).memeplex;
            const grant = grants.get(memeplex.grant) as Record<string, any>;

            expect(grant.controller).toBe(memeplex.author);
            expect(grant.data.memeplexGrant.client).toBe(operation!.controller);
            expect(grant.registration.registry).toBe((operation!.registration as Record<string, any>).registry);
        }
    });
});
