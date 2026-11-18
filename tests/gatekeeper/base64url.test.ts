import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import { generateCID } from '@didcid/ipfs/utils';
import MemoryClient from '@didcid/ipfs/memory';
import type { Operation, GatekeeperEvent } from '@didcid/gatekeeper/types';

class Db extends DbMemory {
    snapshot() { return this.loadDb(); }
}

// Shared signed vectors: both ports refuse base64 padding in a proofValue and in
// a key's coordinates, on submission, import and replay. Every padded value here
// decodes to the bytes of a valid one, so a decoder that drops padding accepts it.
const vector = JSON.parse(readFileSync('tests/gatekeeper/base64url-v1-vectors.json', 'utf8')) as {
    cases: { name: string; did: string; agent?: Operation; prior?: Operation; operation: Operation; accepted: boolean }[];
};
const event = (operation: Operation): GatekeeperEvent => ({ operation, registry: 'hyperswarm', time: operation.proof!.created });

function submit(g: Gatekeeper, operation: Operation): Promise<unknown> {
    if (operation.type === 'create') return g.createDID(operation);
    return operation.type === 'delete' ? g.deleteDID(operation) : g.updateDID(operation);
}

it.each(vector.cases)('refuses padding in $name on submission, import and restart', async ({ did, agent, prior, operation, accepted }) => {
    const before = [agent, prior].filter((op): op is Operation => !!op);
    // Versions before the operation, and whether the DID exists without it.
    const base = before.length;
    for (const mode of ['direct', 'import', 'replay']) {
        const db = new Db('base64url');
        const ipfs = new MemoryClient();
        let g = new Gatekeeper({ db, ipfs, registries: ['hyperswarm'] });
        if (mode === 'direct') {
            for (const op of before) await submit(g, op);
            const stored = JSON.stringify(db.snapshot());
            const submitted = await submit(g, operation).then(result => result !== false, () => false);
            expect(submitted).toBe(accepted);
            if (!accepted) expect(JSON.stringify(db.snapshot())).toBe(stored);
        } else if (mode === 'import') {
            for (const op of before) expect(await g.importEvent(event(op))).toBe('added');
            // Refused is either status: the ports differ on which a malformed
            // proofValue gets, and neither adds it.
            const imported = await g.importEvent(event(operation));
            expect(accepted ? imported === 'added' : ['rejected', 'deferred'].includes(imported)).toBe(true);
        } else {
            // A projection written by a decoder that dropped the padding.
            const events = await Promise.all([...before, operation].map(async op => ({ ...event(op), opid: await generateCID(op) })));
            await db.setEvents(did, events);
            await db.setCandidates(did, events);
        }
        for (const restart of [false, true]) {
            if (restart) g = new Gatekeeper({ db, ipfs, registries: ['hyperswarm'] });
            for (const verify of [false, true]) {
                const doc = await g.resolveDID(did, { verify });
                const versions = accepted ? base + 1 : base;
                if (versions === 0) {
                    expect(doc.didResolutionMetadata?.error).toBe('notFound');
                } else {
                    expect(doc.didDocumentMetadata?.versionSequence).toBe(String(versions));
                    expect(!!doc.didDocumentMetadata?.deactivated).toBe(accepted && operation.type === 'delete');
                }
            }
        }
    }
});
