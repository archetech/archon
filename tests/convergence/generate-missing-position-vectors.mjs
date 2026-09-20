// Same signed operations as the real ordinal-collision audit; no re-signing.
import { readFileSync, writeFileSync } from 'node:fs';
const tied = JSON.parse(readFileSync('tests/convergence/tied-anchor-vectors.json', 'utf8'));
const vectors = [];
for (const base of tied.filter(v => v.mode === 'tied-anchored-ordinals')) {
    const missing = structuredClone(base);
    missing.mode = 'missing-ordinals-use-cid';
    for (const event of missing.events.slice(2)) delete event.ordinal;
    vectors.push(missing);
    const positioned = structuredClone(missing);
    positioned.mode = 'known-position-before-smaller-cid';
    positioned.events[4].ordinal = base.events[4].ordinal;
    positioned.expected = [0, 1, 3]; positioned.expectedEvents = [0, 3, 4];
    vectors.push(positioned);
    const upgrade = structuredClone(missing);
    upgrade.mode = 'positioned-duplicates-upgrade-existing-receipts';
    upgrade.events.push(structuredClone(base.events[4]), structuredClone(base.events[3]));
    upgrade.expected = [0, 1, 3]; upgrade.expectedEvents = [0, 6, 5];
    upgrade.orders = upgrade.orders.map(order => [...order, 5, 6]);
    upgrade.orders.push([6, 5, 4, 3, 2, 1, 0]);
    vectors.push(upgrade);
    const wrong = structuredClone(missing);
    wrong.mode = 'wrong-chain-position-does-not-beat-cid';
    wrong.events[4].registry = 'BTC:signet'; wrong.events[4].ordinal = base.events[4].ordinal;
    vectors.push(wrong);
}
writeFileSync('tests/convergence/missing-position-vectors.json', JSON.stringify(vectors, null, 2) + '\n');
