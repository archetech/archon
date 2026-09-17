import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import { generateCID } from '@didcid/ipfs/utils';
import MemoryClient from '@didcid/ipfs/memory';
import type { Operation, GatekeeperEvent } from '@didcid/gatekeeper/types';

class Db extends DbMemory {
    snapshot() { return this.loadDb(); }
}

// Shared signed vectors exercise the registration contract in both ports.
const vector = JSON.parse(readFileSync('tests/gatekeeper/registration-transition-v1-vectors.json', 'utf8')) as {
    agent: Operation; did: string; unsupportedGenesis: Operation; invalidGenesis: Operation[];
    cases: { agent?: Operation; did?: string; name: string; operation: Operation; accepted: boolean; expectedRegistration: Record<string, unknown> }[];
};
const event = (operation: Operation): GatekeeperEvent => ({ operation, registry: 'hyperswarm', time: operation.proof!.created });

it.each(vector.cases)('enforces v1 $name across submission, import, and restart', async ({ agent = vector.agent, did = vector.did, operation, accepted, expectedRegistration }) => {
    for (const mode of ['direct', 'import', 'replay']) {
        const db = new Db('registration-v1');
        const ipfs = new MemoryClient();
        let g = new Gatekeeper({ db, ipfs, registries: mode === 'direct' ? ['hyperswarm', 'BTC:signet'] : ['hyperswarm'] });
        if (mode === 'direct') {
            await g.createDID(agent);
            const before = JSON.stringify(db.snapshot());
            expect(await g.updateDID(operation)).toBe(accepted);
            if (!accepted) expect(JSON.stringify(db.snapshot())).toBe(before);
        } else if (mode === 'import') {
            await g.importEvent(event(agent));
            expect(await g.importEvent(event(operation))).toBe(accepted ? 'added' : 'rejected');
        } else {
            // Simulate an old projection that bypassed registration validation.
            const events = await Promise.all([agent, operation].map(async op => ({ ...event(op), opid: await generateCID(op) })));
            await db.setEvents(did, events);
            await db.setCandidates(did, events);
        }
        for (const restart of [false, true]) {
            if (restart) g = new Gatekeeper({ db, ipfs, registries: mode === 'direct' ? ['hyperswarm', 'BTC:signet'] : ['hyperswarm'] });
            for (const verify of [false, true]) {
                const doc = await g.resolveDID(did, { verify });
                expect(doc.didDocument?.id).toBe(did);
                expect(doc.didDocumentRegistration).toEqual(expectedRegistration);
                expect(doc.didDocumentMetadata?.versionSequence).toBe(accepted ? '2' : '1');
            }
        }
    }
});

it('does not activate version 2 genesis', async () => {
    const db = new Db('registration-v2-disabled');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    await expect(g.createDID(vector.unsupportedGenesis)).rejects.toThrow('registration.version=2');
    expect(await g.importEvent(event(vector.unsupportedGenesis))).toBe('rejected');
    expect(await db.getAllKeys()).toEqual([]);
});

it.each(vector.invalidGenesis)('rejects malformed genesis expiry before writes', async operation => {
    const db = new Db('invalid-registration');
    const g = new Gatekeeper({ db, ipfs: new MemoryClient() });
    const before = db.snapshot();
    await expect(g.createDID(operation)).rejects.toThrow();
    expect(db.snapshot()).toEqual(before);
    // Existing malformed-string errors keep their retry classification (#1178).
    expect(await g.importEvent(event(operation))).toBe(typeof operation.registration?.validUntil === 'string' ? 'deferred' : 'rejected');
    expect(await db.getAllKeys()).toEqual([]);
});

it('treats undefined optional registration members like JSON omission in local SDK calls', async () => {
    const g = new Gatekeeper({ db: new Db('registration-undefined'), ipfs: new MemoryClient() });
    await g.createDID(vector.agent);
    const operation = structuredClone(vector.cases.find(item => item.name === 'remove_expiry')!.operation);
    operation.doc!.didDocumentRegistration!.validUntil = undefined;
    operation.doc!.didDocumentRegistration!.prefix = undefined;
    expect(await g.updateDID(operation)).toBe(true);
    const omitted = structuredClone(vector.cases.find(item => item.name === 'omit_registration')!.operation);
    // Use a fresh DID history so the already signed predecessor remains current.
    const second = new Gatekeeper({ db: new Db('registration-undefined-component'), ipfs: new MemoryClient() });
    await second.createDID(vector.agent);
    omitted.doc!.didDocumentRegistration = undefined;
    expect(await second.updateDID(omitted)).toBe(true);
});
