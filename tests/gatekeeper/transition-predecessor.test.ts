import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import Db from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { Operation } from '@didcid/gatekeeper/types';

const fixture = JSON.parse(readFileSync('tests/gatekeeper/transition-predecessor-vectors.json', 'utf8')) as {
    did: string; create: Operation; valid: Operation; successor: Operation;
    cases: { name: string; operation: Operation }[];
};

it.each(fixture.cases)('refuses $name before writing or distributing it', async ({ operation }) => {
    const db = new Db('predecessor');
    const ipfs = new MemoryClient();
    const g = new Gatekeeper({ db, ipfs });
    await g.createDID(fixture.create);
    const before = await db.getEvents(fixture.did);
    const queue = await db.getQueue('hyperswarm');
    const writes = jest.spyOn(db, 'addOperation');
    await expect(g.updateDID(operation)).rejects.toThrow('previd');
    expect(writes).not.toHaveBeenCalled();
    expect(await db.getEvents(fixture.did)).toEqual(before);
    expect(await db.getQueue('hyperswarm')).toEqual(queue);
    expect((await db.getCandidates())[fixture.did]).toHaveLength(1);
    const restarted = new Gatekeeper({ db, ipfs });
    expect((await restarted.resolveDID(fixture.did, { verify: true })).didDocumentMetadata?.versionSequence).toBe('1');
});

it('refuses a stale direct head but retains successors for later predecessor recovery', async () => {
    const db = new Db('predecessor-recovery');
    const ipfs = new MemoryClient();
    const g = new Gatekeeper({ db, ipfs });
    await g.createDID(fixture.create);
    await expect(g.updateDID(fixture.valid)).resolves.toBe(true);
    await expect(g.updateDID(fixture.valid)).rejects.toThrow('previd');
    await g.resetDb();
    const event = (operation: Operation) => ({ operation, registry: 'hyperswarm', time: operation.proof!.created });
    await g.importEvent(event(fixture.create));
    await g.importEvent(event(fixture.successor));
    expect((await g.resolveDID(fixture.did)).didDocumentMetadata?.versionSequence).toBe('1');
    await g.importEvent(event(fixture.valid));
    const restarted = new Gatekeeper({ db, ipfs });
    expect((await restarted.resolveDID(fixture.did, { verify: true })).didDocumentData).toEqual({ version: 3 });
});
