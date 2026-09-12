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

// The emitted form has to be one the gatekeeper accepts, which is what makes
// the ordering in #1125 load-bearing: a node that has not upgraded refuses the
// bound form outright, so nothing may emit it until every node accepts it.
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

    // The other emission site: an asset's operations are signed by its
    // controller, where a create-agent operation signs with its own new key.
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
