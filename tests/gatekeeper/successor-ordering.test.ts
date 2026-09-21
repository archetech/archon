import { readFileSync } from 'node:fs';
import { compareSuccessors } from '../../packages/gatekeeper/src/gatekeeper.ts';

type Successor = Parameters<typeof compareSuccessors>[1];
const cases: { name: string; expectedRegistry: string | null; a: Successor; b: Successor; comparison: number }[] = JSON.parse(readFileSync('tests/convergence/successor-ordering.json', 'utf8'));
it.each(cases)('compares authorized successors: $name', ({ expectedRegistry, a, b, comparison }) => {
    expect(Math.sign(compareSuccessors(expectedRegistry ?? undefined, a, b))).toBe(comparison);
    expect(Math.sign(compareSuccessors(expectedRegistry ?? undefined, b, a)) || 0).toBe(-comparison || 0);
    expect(compareSuccessors(expectedRegistry ?? undefined, a, a)).toBe(0);
});
