import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import TestHelper from './helper.ts';

const mockConsole = {
    log: (): void => { },
    error: (): void => { },
    time: (): void => { },
    timeEnd: (): void => { },
} as unknown as typeof console;

const cipher = new CipherNode();
const db = new DbJsonMemory('test');
const ipfs = new MemoryClient();
const gatekeeper = new Gatekeeper({ db, ipfs, console: mockConsole, registries: ['local', 'hyperswarm'] });
const helper = new TestHelper(gatekeeper, cipher);

beforeAll(async () => { await ipfs.start(); });
afterAll(async () => { await ipfs.stop(); });
beforeEach(async () => { await gatekeeper.resetDb(); });

// A confirmed resolution stops at the last confirmed version and reports that
// version's flag. The Rust store resolver once stopped one event later and
// reported the result as unconfirmed, and every asset operation's controller
// is resolved this way -- so the ports authorized against different keys
// whenever a rotation was pending (#1145). This pins the TypeScript side.
describe('confirmed resolution', () => {
    async function pendingUpdate() {
        const keypair = cipher.generateRandomJwk();
        const did = await gatekeeper.createDID(await helper.createAgentOp(keypair, { registry: 'local' }));

        const v1 = await gatekeeper.resolveDID(did);
        v1.didDocumentData = { displayName: 'updated' };
        await gatekeeper.updateDID(await helper.createUpdateOp(keypair, did, v1));
        const v2 = await gatekeeper.resolveDID(did);
        v2.didDocumentData = { displayName: 'late-update' };
        await gatekeeper.updateDID(await helper.createUpdateOp(keypair, did, v2));

        // v2 arrived over hyperswarm: unconfirmed for a local DID.
        const events = await db.getEvents(did);
        events[1].registry = 'hyperswarm';
        await db.setEvents(did, events);

        return did;
    }

    it('stops before the first unconfirmed event and reports the confirmed flag of the version it stopped at', async () => {
        const did = await pendingUpdate();

        const confirmed = await gatekeeper.resolveDID(did, { confirm: true });
        expect(confirmed.didDocumentMetadata?.versionSequence).toBe('1');
        expect(confirmed.didDocumentMetadata?.confirmed).toBe(true);

        const plain = await gatekeeper.resolveDID(did);
        expect(plain.didDocumentMetadata?.versionSequence).toBe('3');
        expect(plain.didDocumentMetadata?.confirmed).toBe(false);
    });

    it('answers the same with and without verification', async () => {
        const did = await pendingUpdate();
        const strip = (doc: Awaited<ReturnType<typeof gatekeeper.resolveDID>>) => ({ ...doc, didResolutionMetadata: undefined });

        expect(strip(await gatekeeper.resolveDID(did, { confirm: true, verify: true })))
            .toEqual(strip(await gatekeeper.resolveDID(did, { confirm: true })));
        expect(strip(await gatekeeper.resolveDID(did, { verify: true })))
            .toEqual(strip(await gatekeeper.resolveDID(did)));
    });
});
