import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// These packages share no dependency, so a helper needed by more than one is
// copied rather than imported. Nothing about a copy announces that it has a
// twin, and a suite importing one leaves the others unexercised: breaking
// ethereum's planAnchor to re-broadcast an anchored batch passed every test in
// this directory, and removing the rounding from satoshi-wallet's toFeeRate --
// the defect that stopped BTC anchoring in #1033 -- passed all of them too.
//
// Keeping the copies identical is what makes exercising them meaningful.

const MEDIATORS = 'services/mediators';

// Listed rather than discovered. Several files share a name across mediators
// without being copies -- derivation.ts, state.ts and sync.ts are per-chain
// implementations of 9 to 90 lines -- so identity has to be asserted only where
// it is intended. A helper copied to a new package belongs here.
const COPIED = ['batch.ts', 'fee.ts'];

function copiesOf(name: string): string[] {
    return readdirSync(MEDIATORS)
        .map(mediator => join(MEDIATORS, mediator, 'src', name))
        .filter(path => existsSync(path));
}

describe('helpers copied between mediators', () => {
    it.each(COPIED)('%s exists in more than one package', (name) => {
        // Guard the guard: a rename or a move must not leave the identity check
        // below comparing a file with itself.
        expect(copiesOf(name).length).toBeGreaterThan(1);
    });

    it.each(COPIED)('%s is identical in every package that has it', (name) => {
        const [reference, ...others] = copiesOf(name).map(path => readFileSync(path, 'utf-8'));

        for (const other of others) {
            expect(other).toBe(reference);
        }
    });
});
