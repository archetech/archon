import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import HeliaClient from '@didcid/ipfs/helia';
import {
    packEncrypted,
    unpackEncrypted,
    didKeyToX25519,
    x25519JwkToDidKey,
} from '@didcid/cipher/didcomm';

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

    it('auto-discovers the endpoint from the gateway when none is given', async () => {
        const did = await keymaster.createId('Alice');
        // Simulate a Drawbridge gateway that advertises a public DIDComm endpoint.
        (gatekeeper as any).getDidCommEndpoint = async () => 'https://node.example/didcomm';

        const ok = await keymaster.publishDidComm();
        const doc = await keymaster.resolveDID(did);

        expect(ok).toBe(true);
        expect(doc.didDocument?.service).toContainEqual({
            id: `${did}#didcomm`,
            type: 'DIDCommMessaging',
            serviceEndpoint: 'https://node.example/didcomm',
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

describe('packDidComm / unpackDidComm (end-to-end between two identities)', () => {
    async function setup() {
        const aliceDid = await keymaster.createId('Alice');
        const bobDid = await keymaster.createId('Bob');
        await keymaster.publishDidComm(undefined, 'Alice');
        await keymaster.publishDidComm(undefined, 'Bob');
        return { aliceDid, bobDid };
    }

    const body = { text: 'hello over didcomm', n: 99 };

    it('authcrypt: Bob decrypts and sees Alice as the authenticated sender', async () => {
        const { aliceDid, bobDid } = await setup();

        const packed = await keymaster.packDidComm({ type: 'https://x/1/msg', body }, bobDid, { name: 'Alice' });
        const { message, metadata } = await keymaster.unpackDidComm(packed, { name: 'Bob' });

        expect(message.body).toEqual(body);
        expect(message.from).toBe(aliceDid);
        expect(message.to).toEqual([bobDid]);
        expect(metadata.encrypted).toBe(true);
        expect(metadata.authenticated).toBe(true);
        expect(metadata.nonRepudiation).toBe(false);
        expect(metadata.sender).toBe(`${aliceDid}#key-agreement-1`);
    });

    it('anoncrypt: Bob decrypts without an authenticated sender', async () => {
        const { bobDid } = await setup();

        const packed = await keymaster.packDidComm({ type: 'https://x/1/msg', body }, bobDid, { name: 'Alice', anoncrypt: true });
        const { message, metadata } = await keymaster.unpackDidComm(packed, { name: 'Bob' });

        expect(message.body).toEqual(body);
        expect(message.from).toBeUndefined();
        expect(metadata.authenticated).toBe(false);
        expect(metadata.sender).toBeUndefined();
    });

    it('sign-then-encrypt: Bob verifies Alice\'s ES256K signature (non-repudiation)', async () => {
        const { aliceDid, bobDid } = await setup();

        const packed = await keymaster.packDidComm({ type: 'https://x/1/msg', body }, bobDid, { name: 'Alice', sign: true });
        const { message, metadata } = await keymaster.unpackDidComm(packed, { name: 'Bob' });

        expect(message.body).toEqual(body);
        expect(metadata.authenticated).toBe(true);
        expect(metadata.nonRepudiation).toBe(true);
        expect(metadata.signer).toBe(`${aliceDid}#key-1`);
    });

    it('throws when packing to a recipient without a published keyAgreement key', async () => {
        await keymaster.createId('Alice');
        const carolDid = await keymaster.createId('Carol'); // no publishDidComm
        await keymaster.setCurrentId('Alice');

        await expect(keymaster.packDidComm({ type: 'https://x/1/msg', body }, carolDid, { name: 'Alice' }))
            .rejects.toThrow(/keyAgreement/);
    });

    it('throws when an identity that is not a recipient tries to unpack', async () => {
        const { bobDid } = await setup();
        await keymaster.createId('Mallory');
        await keymaster.publishDidComm(undefined, 'Mallory');

        const packed = await keymaster.packDidComm({ type: 'https://x/1/msg', body }, bobDid, { name: 'Alice' });

        await expect(keymaster.unpackDidComm(packed, { name: 'Mallory' }))
            .rejects.toThrow(/not addressed to this identity/);
    });
});

describe('packDidComm / unpackDidComm (cross-method: Archon did:cid <-> did:key)', () => {
    const body = { text: 'cross-method hello', n: 7 };

    // A non-Archon counterparty identified by a did:key, whose X25519 keypair we hold.
    function foreignDidKey(seedByte: number) {
        const kp = cipher.generateX25519Jwk(new Uint8Array(32).fill(seedByte));
        const did = x25519JwkToDidKey(kp.publicJwk);
        const { kid } = didKeyToX25519(did);
        return { did, kid, kp };
    }

    it('Archon -> did:key (anoncrypt): the did:key holder decrypts', async () => {
        const aliceDid = await keymaster.createId('Alice');
        await keymaster.publishDidComm(undefined, 'Alice');
        const bob = foreignDidKey(0x40);

        const packed = await keymaster.packDidComm({ type: 'https://x/1/msg', body }, bob.did, { name: 'Alice', anoncrypt: true });

        // The did:key holder unpacks with its own X25519 private key.
        const { plaintext } = unpackEncrypted(packed, { kid: bob.kid, privateJwk: bob.kp.privateJwk });
        const message = JSON.parse(new TextDecoder().decode(plaintext));
        expect(message.body).toEqual(body);
        expect(message.to).toEqual([bob.did]);
        expect(aliceDid).toMatch(/^did:/);
    });

    it('did:key -> Archon (authcrypt): Archon resolves the foreign sender and decrypts', async () => {
        await keymaster.createId('Alice');
        await keymaster.publishDidComm(undefined, 'Alice');

        const aliceDoc = await keymaster.resolveDID('Alice');
        const aliceKaId = aliceDoc.didDocument!.keyAgreement![0];
        const aliceKaVm = aliceDoc.didDocument!.verificationMethod!.find(v => v.id === aliceKaId)!;

        const bob = foreignDidKey(0x41);
        const message = { id: 'x1', typ: 'application/didcomm-plain+json', type: 'https://x/1/msg', from: bob.did, to: [aliceDoc.didDocument!.id], body };

        // Foreign agent (did:key Bob) authcrypts to Alice using cipher directly.
        const packed = packEncrypted(
            new TextEncoder().encode(JSON.stringify(message)),
            [{ kid: aliceKaId, publicJwk: aliceKaVm.publicKeyJwk as any }],
            { kid: bob.kid, privateJwk: bob.kp.privateJwk },
            'A256CBC-HS512',
        );

        const { message: out, metadata } = await keymaster.unpackDidComm(packed, { name: 'Alice' });
        expect(out.body).toEqual(body);
        expect(metadata.authenticated).toBe(true);
        expect(metadata.sender).toBe(bob.kid);
    });
});

describe('node capability gating', () => {
    // The capability manifest is fetched once and memoized in _nodeCapabilities;
    // preset it here so the gate resolves without a network call.
    it('blocks sendDidComm when the node does not offer DIDComm', async () => {
        await keymaster.createId('Alice');
        (gatekeeper as any).url = 'http://node.test';
        (keymaster as any)._nodeCapabilities = { didcomm: false, lightning: true };

        await expect(
            keymaster.sendDidComm({ type: 'x', body: {} } as any, 'did:cid:bob')
        ).rejects.toThrow(/does not offer DIDComm/);
    });

    it('blocks Lightning when the node does not offer it', async () => {
        await keymaster.createId('Alice');
        (gatekeeper as any).url = 'http://node.test';
        (gatekeeper as any).createLightningWallet = async () => ({}); // pass requireDrawbridge
        (keymaster as any)._nodeCapabilities = { didcomm: true, lightning: false };

        await expect(keymaster.getLightningBalance()).rejects.toThrow(/does not offer Lightning/);
    });

    it('proceeds lazily when the node exposes no manifest', async () => {
        const alice = await keymaster.createId('Alice');
        (gatekeeper as any).url = 'http://node.test';
        (keymaster as any)._nodeCapabilities = null; // no manifest -> permissive

        // Gets past the gate, then fails for a different reason (unresolvable recipient).
        const err = await keymaster.sendDidComm({ type: 'x', body: {} } as any, alice).catch(e => e);
        expect(String(err)).not.toMatch(/does not offer/);
    });
});
