import { readFileSync, writeFileSync } from 'node:fs';
import { authorityAt, readGrant } from '@didcid/memeplex';
import { build } from './grant-vectors.ts';

// Grants and their authority intervals: docs/plans/memeplex-1436.md, "One grant,
// one client, one chain" and "Authority is an interval".
//
// MEMEPLEX_WRITE_VECTORS=1 writes the fixture file from the builder.

const FIXTURE = new URL('../fixtures/memeplex-v1-grant-vectors.json', import.meta.url).pathname;
let vectors: Awaited<ReturnType<typeof build>>;

beforeAll(async () => {
    const built = await build();
    if (process.env.MEMEPLEX_WRITE_VECTORS) {
        writeFileSync(FIXTURE, `${JSON.stringify(built, null, 1)}\n`);
    }
    vectors = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(vectors).toStrictEqual(JSON.parse(JSON.stringify(built)));
}, 120_000);

it('reads each grant from the versions a Gatekeeper resolved', () => {
    const wrong = vectors.cases
        .map(each => ({ name: each.name, expect: each.expect, got: readGrant(each.history) }))
        .filter(each => JSON.stringify(each.got) !== JSON.stringify(each.expect));

    expect(wrong).toStrictEqual([]);
});

it('finds the authority each position should have', () => {
    const wrong = vectors.cases.flatMap(each => {
        const grant = readGrant(each.history);
        if (grant.status !== 'valid') {
            return each.probes.map(probe => ({ name: each.name, probe, got: `a grant that is ${grant.status}` }));
        }
        return each.probes
            .map(probe => ({ name: each.name, probe, got: authorityAt(grant, { block: probe.block, time: probe.time }, probe.kind) as string }))
            .filter(({ probe, got }) => got !== probe.expect);
    });

    expect(wrong).toStrictEqual([]);
});

it('shows every status, every reason a grant is void, and every authority', () => {
    const statuses = new Set(vectors.cases.map(each => each.expect.status));
    const reasons = new Set(vectors.cases.flatMap(each => each.expect.status === 'void' ? [each.expect.reason] : []));
    const authorities = new Set(vectors.cases.flatMap(each => each.probes.map(probe => probe.expect)));

    expect([...statuses].sort()).toStrictEqual(['pending', 'unsupported', 'valid', 'void']);
    expect([...reasons].sort()).toStrictEqual(['client-is-user', 'expires-by-registration', 'invalid', 'not-a-grant', 'registry']);
    expect([...authorities].sort()).toStrictEqual(['after-end', 'before-grant', 'expired', 'permitted', 'scope', 'unordered']);
});

it('reads nothing as a grant', () => {
    expect(readGrant([])).toStrictEqual({ status: 'void', reason: 'not-a-grant' });
});

it('does not take an unreadable block time as before an expiry', () => {
    const expiring = vectors.cases.find(each => each.name === 'expired')!;
    const grant = readGrant(expiring.history);

    expect(grant.status === 'valid' && authorityAt(grant, { block: 150, time: 'soon' })).toBe('expired');
});
