import assert from 'node:assert/strict';

// Checked decoder boundary for the shared chain receipt contract.
export function assertChainMetadata(event) {
    if (['local', 'hyperswarm', 'pin'].includes(event.registry)) return;
    const { ordinal: p, registration: r } = event;
    assert(Array.isArray(p) && p.length >= 3 && p.every(n => Number.isSafeInteger(n) && n >= 0), 'chain receipt requires an ordinal with complete position components');
    assert(r && r.height === p[0] && r.index === p[1] && r.opidx === p.at(-1)
        && typeof r.txid === 'string' && r.txid.length && typeof r.batch === 'string' && r.batch.length,
    'complete consistent chain metadata required');
}
