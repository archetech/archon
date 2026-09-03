import { coveredOperations } from '../../services/mediators/satoshi/src/batch.ts';

// A batch asset certifies one specific op-set and is published before the
// transaction that anchors it can be attempted. Re-cutting it whenever the queue
// moves therefore strands the previous one: created, never anchored, never
// cleared, and stored permanently by every gatekeeper (#1033).

describe('coveredOperations', () => {
    const operations = ['op1', 'op2', 'op3'];
    const cids = ['cid1', 'cid2', 'cid3'];

    it('covers the whole queue when no batch is pending', () => {
        expect(coveredOperations(undefined, operations, cids)).toEqual(operations);
    });

    it('covers only what the pending batch certifies', () => {
        // The queue grew while the anchor was failing.
        const pending = { opids: ['cid1', 'cid2'] };

        expect(coveredOperations(pending, operations, cids)).toEqual(['op1', 'op2']);
    });

    it('still covers everything when the queue has not moved', () => {
        expect(coveredOperations({ opids: cids }, operations, cids)).toEqual(operations);
    });

    it('covers nothing once the batch operations have left the queue', () => {
        // Signals that the pending batch is stale and a new one must be cut.
        expect(coveredOperations({ opids: ['gone'] }, operations, cids)).toEqual([]);
    });
});
