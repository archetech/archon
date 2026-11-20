import { readFileSync, writeFileSync } from 'node:fs';
import { attribute } from '@didcid/memeplex';
import { build } from './attribution-vectors.ts';

// Attribution and publication state: docs/plans/memeplex-1436.md, "One rule for
// publication".
//
// MEMEPLEX_WRITE_VECTORS=1 writes the fixture file from the builder.

const FIXTURE = new URL('../fixtures/memeplex-v1-attribution-vectors.json', import.meta.url).pathname;
let vectors: Awaited<ReturnType<typeof build>>;

beforeAll(async () => {
    const built = await build();
    if (process.env.MEMEPLEX_WRITE_VECTORS) {
        writeFileSync(FIXTURE, `${JSON.stringify(built, null, 1)}\n`);
    }
    vectors = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(vectors).toStrictEqual(JSON.parse(JSON.stringify(built)));
}, 240_000);

it('derives each publication from the versions of the object and of its grant', () => {
    const wrong = vectors.cases.map(each => {
        const publication = attribute(each.object, each.grant);
        const got = {
            state: publication.state,
            ...(publication.current === undefined ? {} : { current: publication.current }),
            versions: publication.versions.map(({ opid, type, ...outcome }) => {
                void opid; void type;
                if (outcome.outcome !== 'attributed') return outcome;
                return { outcome: outcome.outcome };
            }),
            ...(publication.memeplex ? { memeplex: publication.memeplex } : {}),
        };
        return { name: each.name, expect: each.expect, got };
    }).filter(each => JSON.stringify(each.got) !== JSON.stringify({
        state: each.expect.state,
        ...(each.expect.current === undefined ? {} : { current: each.expect.current }),
        versions: each.expect.versions,
        ...(each.expect.memeplex ? { memeplex: each.expect.memeplex } : {}),
    }));

    expect(wrong).toStrictEqual([]);
});

it('gives each version its operation and each attributed one its position', () => {
    for (const each of vectors.cases) {
        const { versions } = attribute(each.object, each.grant);

        expect(versions.map(version => version.opid)).toStrictEqual(each.object.map(version => version.didDocumentMetadata!.versionId));
        for (const [index, version] of versions.entries()) {
            if (version.outcome === 'attributed') {
                const { height, timeISO } = each.object[index].didDocumentMetadata!.timestamp!.upperBound!;

                expect(version.position).toStrictEqual({ block: height, time: timeISO });
            }
        }
    }
});

it('shows every state and every reason a version is not attributed', () => {
    const states = new Set(vectors.cases.map(each => each.expect.state));
    const reasons = new Set(vectors.cases.flatMap(each => each.expect.versions.flatMap(version => version.reason ?? [])));
    const authorities = new Set(vectors.cases.flatMap(each => each.expect.versions.flatMap(version => version.authority ?? [])));

    expect([...states].sort()).toStrictEqual(['none', 'pending', 'published', 'unsupported', 'withdrawn']);
    expect([...reasons].sort()).toStrictEqual([
        'author', 'authority', 'expires-by-registration', 'follows-unattributed', 'grant-mismatch', 'grant-void',
        'identity', 'invalid', 'not-an-object', 'publisher', 'registry',
    ]);
    expect([...authorities].sort()).toStrictEqual(['after-end', 'before-grant', 'expired', 'scope', 'unordered']);
});

it('attributes nothing without evidence', () => {
    expect(attribute([], [])).toStrictEqual({ state: 'none', versions: [] });
});
