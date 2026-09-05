import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import HeliaClient from '@didcid/ipfs/helia';

// §6.5 of the whitepaper tells controllers that revoking a DID does not erase
// what was published under it, and that anything written to didDocumentData
// should be treated as permanently published. That is a claim someone may rely
// on when deciding what is safe to store, so it is pinned here rather than left
// to the prose.
//
// It used to read that revocation "clears didDocumentData, ensuring data
// lifecycle management", one bullet below a promise that full version history
// is preserved -- an invitation to read revocation as deletion (#772).

let ipfs: HeliaClient;
let gatekeeper: Gatekeeper;
let keymaster: Keymaster;

beforeAll(async () => {
    ipfs = new HeliaClient();
    await ipfs.start();
});

afterAll(async () => {
    if (ipfs) {
        await ipfs.stop();
    }
});

beforeEach(async () => {
    const db = new DbJsonMemory('test');
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm'] });
    keymaster = new Keymaster({
        gatekeeper,
        wallet: new WalletJsonMemory(),
        cipher: new CipherNode(),
        passphrase: 'passphrase',
    });
    await keymaster.loadOrCreateWallet();
});

describe('revocation and immutability', () => {
    it('empties the current document and marks it deactivated', async () => {
        await keymaster.createId('Alice', { registry: 'local' });
        const did = await keymaster.createAsset({ secret: 'sensitive' }, { registry: 'local' } as any);

        await keymaster.revokeDID(did);
        const doc = await keymaster.resolveDID(did);

        expect(doc.didDocumentData).toStrictEqual({});
        expect(doc.didDocumentMetadata!.deactivated).toBe(true);
    });

    it('leaves earlier versions readable, so revocation is not erasure', async () => {
        await keymaster.createId('Alice', { registry: 'local' });
        const data = { secret: 'sensitive' };
        const did = await keymaster.createAsset(data, { registry: 'local' } as any);

        const before = await keymaster.resolveDID(did);
        const versionSequence = Number(before.didDocumentMetadata!.versionSequence!);

        await keymaster.revokeDID(did);

        // The whole point: the operation chain is append-only, so resolving the
        // version that existed before the revocation still returns the data.
        const travelled = await keymaster.resolveDID(did, { versionSequence } as any);

        expect(travelled.didDocumentData).toStrictEqual(data);
    });

    it('adds a version rather than replacing the history', async () => {
        await keymaster.createId('Alice', { registry: 'local' });
        const did = await keymaster.createAsset({ secret: 'sensitive' }, { registry: 'local' } as any);

        const before = await keymaster.resolveDID(did);
        await keymaster.revokeDID(did);
        const after = await keymaster.resolveDID(did);

        expect(Number(after.didDocumentMetadata!.versionSequence!))
            .toBe(Number(before.didDocumentMetadata!.versionSequence!) + 1);
    });
});
