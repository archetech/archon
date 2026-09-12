import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';

let ipfs: MemoryClient;
let gatekeeper: Gatekeeper;

beforeAll(async () => {
    ipfs = new MemoryClient();
    await ipfs.start();
});

afterAll(async () => {
    await ipfs.stop();
});

beforeEach(async () => {
    const db = new DbJsonMemory('test');
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm'] });
});

async function newKeymaster(): Promise<Keymaster> {
    const keymaster = new Keymaster({
        gatekeeper,
        wallet: new WalletJsonMemory(),
        cipher: new CipherNode(),
        passphrase: 'passphrase',
    });

    await keymaster.newWallet();

    return keymaster;
}

// The emitted form has to be one the gatekeeper accepts. A node running older
// code refuses the bound form outright, which is why every node upgrades in one
// go (#1125) rather than a wallet meeting one that cannot read it.
describe('operation proof emission', () => {

    it('signs the proof configuration into every operation', async () => {
        const keymaster = await newKeymaster();
        const did = await keymaster.createId('Alice', { registry: 'local' });
        const doc = await keymaster.resolveDID(did);

        // Resolution means the gatekeeper accepted the create operation, which
        // is the round trip this exists for.
        expect(doc.didDocument!.id).toBe(did);

        const events = await gatekeeper.exportDIDs([did]);
        const proof = events[0][0].operation.proof! as unknown as Record<string, string>;

        expect(proof.type).toBe('DataIntegrityProof');
        expect(proof.cryptosuite).toBe('archon-ecdsa-jcs-2019');
    });

    // An asset's operations are signed by its controller, where a create-agent
    // operation signs with its own new key.
    it('signs controller-signed creates and updates under the same suite', async () => {
        const keymaster = await newKeymaster();
        await keymaster.createId('Alice', { registry: 'local' });

        const asset = await keymaster.createAsset({ note: 'asset' }, { registry: 'local' });
        const doc = await keymaster.resolveDID(asset);
        doc.didDocumentData = { note: 'changed' };

        await keymaster.updateDID(asset, doc);

        const events = await gatekeeper.exportDIDs([asset]);
        const operations = events[0].map(event => event.operation);

        expect(operations.map(operation => operation.type)).toStrictEqual(['create', 'update']);

        for (const operation of operations) {
            expect(operation.proof!.type).toBe('DataIntegrityProof');
        }
    });

    it('produces a proof whose bound members cannot be moved', async () => {
        const keymaster = await newKeymaster();
        const did = await keymaster.createId('Alice', { registry: 'local' });
        const events = await gatekeeper.exportDIDs([did]);
        const operation = JSON.parse(JSON.stringify(events[0][0].operation));

        await expect(gatekeeper.verifyCreateOperation(operation)).resolves.toBe(true);

        operation.proof.created = '2030-01-01T00:00:00Z';

        await expect(gatekeeper.verifyCreateOperation(operation)).resolves.toBe(false);
    });
});

// The seed bank's DID is the CID of its operation, proof included, so a wallet
// that switched it to the bound form would compute a different DID and lose the
// bank it already had.
describe('seed bank', () => {

    it('keeps the legacy proof, where every other operation is bound', async () => {
        const keymaster = await newKeymaster();
        const did = await keymaster.createId('Alice', { registry: 'local' });
        const bank = await keymaster.resolveSeedBank();

        const [bankEvents] = await gatekeeper.exportDIDs([bank.didDocument!.id!]);
        const [agentEvents] = await gatekeeper.exportDIDs([did]);

        expect(bankEvents[0].operation.proof!.type).toBe('EcdsaSecp256k1Signature2019');
        expect(agentEvents[0].operation.proof!.type).toBe('DataIntegrityProof');
    });
});

// The seed bank is the one exception, and only its create operation. Its
// updates and the backup asset it points at are ordinary operations, and were
// each signing the legacy form from their own copy of the code until they
// shared the builder.
describe('seed bank updates and wallet backups', () => {

    it('bind their proof configuration like any other operation', async () => {
        const keymaster = await newKeymaster();
        await keymaster.createId('Alice', { registry: 'local' });

        const backup = await keymaster.backupWallet('local');
        const bank = await keymaster.resolveSeedBank();

        const [backupEvents] = await gatekeeper.exportDIDs([backup]);
        const [bankEvents] = await gatekeeper.exportDIDs([bank.didDocument!.id!]);

        expect(backupEvents[0].operation.proof!.type).toBe('DataIntegrityProof');

        // The create keeps the legacy proof; the update that records the
        // backup does not.
        expect(bankEvents[0].operation.proof!.type).toBe('EcdsaSecp256k1Signature2019');
        expect(bankEvents.length).toBeGreaterThan(1);
        expect(bankEvents[bankEvents.length - 1].operation.proof!.type).toBe('DataIntegrityProof');
    });
});

// The relationship an operation claims. `capabilityInvocation` is what DID Core
// names for exercising control over a document; `authentication` says the signer
// is proving they are the subject, which is a different claim and the one every
// operation anchored before this made.
describe('the purpose an operation claims', () => {

    it('is capabilityInvocation', async () => {
        const keymaster = await newKeymaster();
        const did = await keymaster.createId('Alice', { registry: 'local' });
        const [events] = await gatekeeper.exportDIDs([did]);

        expect(events[0].operation.proof!.proofPurpose).toBe('capabilityInvocation');
    });

    it('stays authentication on the seed bank, whose bytes fix its DID', async () => {
        const keymaster = await newKeymaster();
        await keymaster.createId('Alice', { registry: 'local' });

        const bank = await keymaster.resolveSeedBank();
        const [events] = await gatekeeper.exportDIDs([bank.didDocument!.id!]);

        expect(events[0].operation.proof!.proofPurpose).toBe('authentication');
    });
});
