import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// A batch asset is published before the transaction that anchors it can be
// attempted, so an anchor that fails leaves a permanent asset behind. One
// mediator did that once a minute for five days, producing 69% of all new DIDs
// on the network in that window (#1033) -- and the same shape was in three
// others, because each chain's mediator was written from the last one.
//
// This asserts the shape rather than the behaviour: these modules cannot be
// imported in a test (module-level side effects), and the failure only appears
// when an anchor fails, which a unit test cannot stage against a live chain.

const MEDIATORS = 'services/mediators';

function anchoringMediators(): { name: string, source: string, path: string }[] {
    const found = readdirSync(MEDIATORS)
        .map(name => {
            const dir = join(MEDIATORS, name, 'src');
            if (!existsSync(dir)) {
                return undefined;
            }
            const file = readdirSync(dir).find(f => f.endsWith('-mediator.ts'));
            if (!file) {
                return undefined;
            }
            const path = join(dir, file);
            const source = readFileSync(path, 'utf-8');
            return source.includes('keymaster.createAsset') ? { name, source, path } : undefined;
        })
        .filter((m): m is { name: string, source: string, path: string } => !!m);

    // Guard the guard: a rename must not leave this asserting over nothing.
    expect(found.map(m => m.name).sort()).toEqual(['ethereum', 'satoshi', 'solana', 'zcash']);
    return found;
}

describe.each(anchoringMediators())('$name mediator', ({ source }) => {
    it('reuses the batch asset it already published', () => {
        // Without this a failed anchor mints another asset for the same
        // operations on the next cycle, and the previous one is never anchored.
        expect(source).toContain('pendingBatch');
        expect(source).toContain('coveredOperations');
    });

    it('keeps the pending batch until its operations are cleared', () => {
        // An anchor that succeeds while clearQueue fails leaves the operations
        // queued. Forgetting the batch there has them minted and anchored a
        // second time once the transaction confirms.
        expect(source).toMatch(/pendingBatch = \{[^}]*txid:/);
        expect(source).toMatch(/pending\?\.txid/);
    });

    it('retries the clear without broadcasting again', () => {
        const retry = source.indexOf('pending?.txid');
        const broadcastGuard = source.indexOf('return;', retry);

        expect(retry).toBeGreaterThan(-1);
        // The early return keeps a second transaction from being sent.
        expect(broadcastGuard).toBeGreaterThan(retry);
    });

    it('records the transaction before clearing the queue', () => {
        // The transaction is on the network and its fee is spent by this point.
        // Losing it has the next cycle anchor the same batch again.
        const persisted = source.search(/delete (db|data)\.pendingBatch/);
        const cleared = source.indexOf('clearQueue', persisted);

        expect(persisted).toBeGreaterThan(-1);
        expect(cleared).toBeGreaterThan(persisted);
    });

    it('counts an anchor that produced no transaction', () => {
        // The wallet services answer 500, so the failure arrives thrown rather
        // than as an empty txid; both paths have to increment.
        expect(source).toMatch(/anchor_failures_total/);
        expect(source).toMatch(/catch[\s\S]{0,400}AnchorFailures\.inc\(\)/);
    });
});
