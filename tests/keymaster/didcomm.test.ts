import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import HeliaClient from '@didcid/ipfs/helia';

let ipfs: HeliaClient;
let gatekeeper: Gatekeeper;
let wallet: WalletJsonMemory;
let cipher: CipherNode;
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

beforeEach(() => {
    const db = new DbJsonMemory('test');
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm', 'BTC:signet'] });
    wallet = new WalletJsonMemory();
    cipher = new CipherNode();
    keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase: 'passphrase' });
});

describe('fetchDidCommKeyPair', () => {
    it('derives a deterministic X25519 keypair for an identity', async () => {
        await keymaster.createId('Alice');

        const a = await keymaster.fetchDidCommKeyPair();
        const b = await keymaster.fetchDidCommKeyPair();

        expect(a.publicJwk.kty).toBe('OKP');
        expect(a.publicJwk.crv).toBe('X25519');
        expect(a.publicJwk.x).toBeDefined();
        expect(a.privateJwk.d).toBeDefined();
        expect(a).toStrictEqual(b);
    });

    it('derives a distinct key-agreement key from the identity signing key', async () => {
        await keymaster.createId('Alice');

        const ka = await keymaster.fetchDidCommKeyPair();
        const sign = await keymaster.fetchKeyPair();

        expect(sign).not.toBeNull();
        // signing key is secp256k1 (EC), key agreement is X25519 (OKP)
        expect(sign!.publicJwk.kty).toBe('EC');
        expect(ka.publicJwk.kty).toBe('OKP');
        expect(ka.publicJwk.x).not.toBe(sign!.publicJwk.x);
    });

    it('derives distinct key-agreement keys for distinct identities', async () => {
        await keymaster.createId('Alice');
        const alice = await keymaster.fetchDidCommKeyPair('Alice');
        await keymaster.createId('Bob');
        const bob = await keymaster.fetchDidCommKeyPair('Bob');

        expect(alice.publicJwk.x).not.toBe(bob.publicJwk.x);
    });
});

describe('publishDidComm', () => {
    it('writes an X25519 keyAgreement verification method into the DID document', async () => {
        const did = await keymaster.createId('Alice');

        const ok = await keymaster.publishDidComm();
        const doc = await keymaster.resolveDID(did);
        const keypair = await keymaster.fetchDidCommKeyPair();

        const vmId = `${did}#key-agreement-1`;

        expect(ok).toBe(true);
        expect(doc.didDocument?.keyAgreement).toEqual([vmId]);

        const vm = doc.didDocument?.verificationMethod?.find(v => v.id === vmId);
        expect(vm).toBeDefined();
        expect(vm?.controller).toBe(did);
        expect(vm?.type).toBe('JsonWebKey2020');
        expect(vm?.publicKeyJwk).toStrictEqual(keypair.publicJwk);

        // original secp256k1 signing key is preserved
        const signKey = doc.didDocument?.verificationMethod?.find(v => v.id === '#key-1');
        expect(signKey?.publicKeyJwk?.kty).toBe('EC');

        // no service endpoint when none is provided
        expect(doc.didDocument?.service).toBeUndefined();
    });

    it('publishes a DIDCommMessaging service endpoint when an endpoint is provided', async () => {
        const did = await keymaster.createId('Alice');
        const endpoint = 'https://relay.example/didcomm';

        const ok = await keymaster.publishDidComm(endpoint);
        const doc = await keymaster.resolveDID(did);

        expect(ok).toBe(true);
        expect(doc.didDocument?.service).toContainEqual({
            id: `${did}#didcomm`,
            type: 'DIDCommMessaging',
            serviceEndpoint: endpoint,
        });
    });

    it('is idempotent — re-publishing keeps a single key-agreement method', async () => {
        const did = await keymaster.createId('Alice');

        await keymaster.publishDidComm();
        await keymaster.publishDidComm();
        const doc = await keymaster.resolveDID(did);

        const vmId = `${did}#key-agreement-1`;
        const matches = (doc.didDocument?.verificationMethod || []).filter(v => v.id === vmId);
        expect(matches).toHaveLength(1);
        expect(doc.didDocument?.keyAgreement).toEqual([vmId]);
    });
});

describe('unpublishDidComm', () => {
    it('removes the key-agreement method and DIDComm service but keeps the signing key', async () => {
        const did = await keymaster.createId('Alice');
        await keymaster.publishDidComm('https://relay.example/didcomm');

        const ok = await keymaster.unpublishDidComm();
        const doc = await keymaster.resolveDID(did);

        const vmId = `${did}#key-agreement-1`;

        expect(ok).toBe(true);
        expect(doc.didDocument?.keyAgreement).toBeUndefined();
        expect((doc.didDocument?.verificationMethod || []).find(v => v.id === vmId)).toBeUndefined();
        expect(doc.didDocument?.service).toBeUndefined();
        // signing key still present
        expect((doc.didDocument?.verificationMethod || []).find(v => v.id === '#key-1')).toBeDefined();
    });
});
