import { readFileSync } from 'fs';
import { planAnchor as satoshi, coveredOperations as satoshiCovered } from '../../services/mediators/satoshi/src/batch.ts';
import { planAnchor as ethereum, coveredOperations as ethereumCovered } from '../../services/mediators/ethereum/src/batch.ts';
import { planAnchor as solana, coveredOperations as solanaCovered } from '../../services/mediators/solana/src/batch.ts';
import { planAnchor as zcash, coveredOperations as zcashCovered } from '../../services/mediators/zcash/src/batch.ts';

// Each mediator is a standalone package with its own copy, so a suite that
// imports one leaves the other three unexercised: breaking ethereum's copy to
// re-broadcast an anchored batch passed every test in this directory.
const IMPLEMENTATIONS = [
    ['satoshi', satoshi, satoshiCovered],
    ['ethereum', ethereum, ethereumCovered],
    ['solana', solana, solanaCovered],
    ['zcash', zcash, zcashCovered],
] as const;

// A batch asset is published before the transaction that anchors it can be
// attempted, so every failure path has to be decided rather than improvised:
// one mediator re-cut its batch each cycle and produced 69% of all new DIDs on
// the network in five days (#1033). The decision lives here because the
// mediator modules cannot be imported in a test (#1041).

const OPS = ['op1', 'op2', 'op3'];
const CIDS = ['cid1', 'cid2', 'cid3'];

describe.each(IMPLEMENTATIONS)('%s planAnchor', (_name, planAnchor) => {
    it('mints when nothing is pending', () => {
        expect(planAnchor(undefined, OPS, CIDS)).toEqual({
            action: 'mint', covered: OPS, opids: CIDS,
        });
    });

    it('reuses a batch that was published but never anchored', () => {
        // The failure #1033 was: this used to mint again, stranding the last one.
        expect(planAnchor({ did: 'did:a', opids: CIDS }, OPS, CIDS)).toEqual({
            action: 'reuse', did: 'did:a', covered: OPS, opids: CIDS,
        });
    });

    it('covers only the operations its batch certifies when the queue has grown', () => {
        // Clearing the newer ones would drop operations this anchor never wrote.
        expect(planAnchor({ did: 'did:a', opids: ['cid1', 'cid2'] }, OPS, CIDS)).toEqual({
            action: 'reuse', did: 'did:a', covered: ['op1', 'op2'], opids: ['cid1', 'cid2'],
        });
    });

    it('carries the batch opids, not the queue, so a stamp cannot widen', () => {
        const plan = planAnchor({ did: 'did:a', opids: ['cid1'] }, OPS, CIDS);

        expect(plan.action).toBe('reuse');
        expect(plan.action === 'reuse' && plan.opids).toEqual(['cid1']);
    });

    it('clears without broadcasting once the batch is anchored', () => {
        // Its transaction is on the network and paid for; sending another would
        // anchor the same batch twice.
        expect(planAnchor({ did: 'did:a', opids: CIDS, txid: '0xabc' }, OPS, CIDS)).toEqual({
            action: 'clear', did: 'did:a', covered: OPS,
        });
    });

    it('clears even when its operations have already left the queue', () => {
        // Nothing left to clear, but the batch record still has to be dropped.
        expect(planAnchor({ did: 'did:a', opids: ['gone'], txid: '0xabc' }, OPS, CIDS)).toEqual({
            action: 'clear', did: 'did:a', covered: [],
        });
    });

    it('discards an unanchored batch whose operations have left the queue', () => {
        expect(planAnchor({ did: 'did:stale', opids: ['gone'] }, OPS, CIDS)).toEqual({
            action: 'mint', covered: OPS, opids: CIDS, discarded: 'did:stale',
        });
    });

    it('prefers clearing over reusing when a batch is both anchored and covered', () => {
        // Ordering matters: reuse would re-broadcast a transaction already sent.
        const plan = planAnchor({ did: 'did:a', opids: CIDS, txid: '0xabc' }, OPS, CIDS);

        expect(plan.action).toBe('clear');
    });
});

describe.each(IMPLEMENTATIONS)('%s coveredOperations', (_name, _plan, coveredOperations) => {
    it('covers the whole queue when no batch is pending', () => {
        expect(coveredOperations(undefined, OPS, CIDS)).toEqual(OPS);
    });

    it('covers nothing once the batch operations have left the queue', () => {
        expect(coveredOperations({ opids: ['gone'] }, OPS, CIDS)).toEqual([]);
    });
});

describe('the four copies', () => {
    it('are identical, so one reviewed change is four', () => {
        // They are duplicated because the mediators are standalone packages with
        // no shared dependency. Nothing but this stops them diverging.
        const [reference, ...others] = IMPLEMENTATIONS.map(
            ([name]) => readFileSync(`services/mediators/${name}/src/batch.ts`, 'utf-8'),
        );

        for (const other of others) {
            expect(other).toBe(reference);
        }
    });
});
