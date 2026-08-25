import Gatekeeper from '@didcid/gatekeeper';
import { jest } from '@jest/globals';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import HeliaClient from '@didcid/ipfs/helia';
import {
    packDidCommMessage,
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

afterEach(() => {
    jest.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function useDidCommGateway(nodeURL = 'https://gateway.example'): string {
    (gatekeeper as any).url = nodeURL;
    (keymaster as any)._nodeCapabilities = { didcomm: true };
    return `${nodeURL}/didcomm`;
}

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

describe('authenticated sender binding', () => {
    // packDidComm already strips a caller-supplied `from` and sets it itself, so
    // the threat is a foreign agent: anyone may send us DIDComm, and an envelope
    // authenticated as Mallory can carry `from: alice` in its plaintext.
    async function forgeEnvelope(senderName: string, recipientDid: string, claimedFrom: string) {
        const senderKa = await keymaster.fetchDidCommKeyPair(senderName);
        const senderDid = (await keymaster.fetchIdInfo(senderName)).did;
        const recipientDoc = await keymaster.resolveDID(recipientDid);
        const recipientKa = (keymaster as any).resolveKeyAgreement(recipientDoc);

        return packDidCommMessage(
            {
                id: 'forged-1',
                typ: 'application/didcomm-plain+json',
                type: 'https://didcomm.org/basicmessage/2.0/message',
                to: [recipientDid],
                from: claimedFrom,
                body: { content: 'trust me' },
            },
            [recipientKa],
            { sender: { kid: `${senderDid}#key-agreement-1`, privateJwk: senderKa.privateJwk } },
        );
    }

    it('rejects a message whose from does not match the authenticated sender', async () => {
        const aliceDid = await keymaster.createId('Alice');
        await keymaster.createId('Mallory');
        const bobDid = await keymaster.createId('Bob');
        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');
        await keymaster.publishDidComm('https://mallory.example/didcomm', 'Mallory');
        await keymaster.publishDidComm('https://bob.example/didcomm', 'Bob');

        const packed = await forgeEnvelope('Mallory', aliceDid, bobDid);

        await expect(keymaster.unpackDidComm(packed, { name: 'Alice' }))
            .rejects.toThrow(/sender mismatch/);
    });

    it('accepts a message whose from matches the authenticated sender', async () => {
        const aliceDid = await keymaster.createId('Alice');
        const malloryDid = await keymaster.createId('Mallory');
        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');
        await keymaster.publishDidComm('https://mallory.example/didcomm', 'Mallory');

        const packed = await forgeEnvelope('Mallory', aliceDid, malloryDid);
        const { message, metadata } = await keymaster.unpackDidComm(packed, { name: 'Alice' });

        expect(metadata.authenticated).toBe(true);
        expect(message.from).toBe(malloryDid);
    });

    it('leaves an anoncrypt from alone, since nothing authenticates it', async () => {
        // No skid means no authenticated sender to contradict; the claim is simply
        // unverified, and callers must present it that way rather than reject it.
        const aliceDid = await keymaster.createId('Alice');
        const bobDid = await keymaster.createId('Bob');
        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');
        await keymaster.publishDidComm('https://bob.example/didcomm', 'Bob');

        const recipientDoc = await keymaster.resolveDID(aliceDid);
        const recipientKa = (keymaster as any).resolveKeyAgreement(recipientDoc);
        const packed = packDidCommMessage(
            {
                id: 'anon-1',
                typ: 'application/didcomm-plain+json',
                type: 'https://didcomm.org/basicmessage/2.0/message',
                to: [aliceDid],
                from: bobDid,
                body: { content: 'anonymous' },
            },
            [recipientKa],
            {},
        );

        const { metadata } = await keymaster.unpackDidComm(packed, { name: 'Alice' });
        expect(metadata.authenticated).toBe(false);
    });
});

describe('DIDComm gateway transport helpers', () => {
    it('delivers routed messages as Forward envelopes and mediates the valid ones', async () => {
        const base = useDidCommGateway();
        await keymaster.createId('Alice');
        const mediatorDid = await keymaster.createId('Mediator');
        const bobDid = await keymaster.createId('Bob');

        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');
        await keymaster.publishDidComm('https://mediator.example/didcomm', 'Mediator');
        await keymaster.publishDidComm('https://bob.example/didcomm', 'Bob', [mediatorDid]);

        const deliveries: any[] = [];
        let challengeCount = 0;
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = String(input);
            if (url === `${base}/api/v1/challenge`) {
                challengeCount += 1;
                return jsonResponse({ challenge: `challenge-${challengeCount}` });
            }
            if (url === `${base}/api/v1/deliver`) {
                deliveries.push(JSON.parse(String(init?.body)));
                return jsonResponse({ ids: ['queued-forward'] });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        const ids = await keymaster.sendDidComm(
            { type: 'https://x/1/msg', body: { text: 'routed' } },
            bobDid,
            { name: 'Alice' }
        );

        expect(ids).toEqual(['queued-forward']);
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0].endpoint).toBe('https://bob.example/didcomm');
        expect(deliveries[0].did).toMatch(/^did:/);
        expect(deliveries[0].message).toContain('protected');

        const removeBodies: any[] = [];
        fetchMock.mockImplementation(async (input, init) => {
            const url = String(input);
            if (url === `${base}/api/v1/challenge`) {
                challengeCount += 1;
                return jsonResponse({ challenge: `challenge-${challengeCount}` });
            }
            if (url === `${base}/api/v1/messages/fetch`) {
                return jsonResponse({
                    messages: [
                        { id: 'forward-1', message: deliveries[0].message },
                        { id: 'not-forward', message: 'not json' },
                    ],
                });
            }
            if (url === `${base}/api/v1/messages`) {
                expect(init?.headers).toEqual({ 'Content-Type': 'application/didcomm-encrypted+json' });
                expect(String(init?.body)).toContain('protected');
                return jsonResponse({ id: 'relayed' });
            }
            if (url === `${base}/api/v1/messages/remove`) {
                removeBodies.push(JSON.parse(String(init?.body)));
                return jsonResponse({ ok: true });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        const result = await keymaster.mediateDidComm({ name: 'Mediator' });

        expect(result).toEqual({ relayed: 1, skipped: 1 });
        expect(removeBodies).toHaveLength(1);
        expect(removeBodies[0].ids).toEqual(['forward-1']);
    });

    it('receives only decryptable mailbox messages and acknowledges handled ids', async () => {
        const base = useDidCommGateway();
        const aliceDid = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');
        await keymaster.publishDidComm('https://bob.example/didcomm', 'Bob');

        const packed = await keymaster.packDidComm(
            { type: 'https://x/1/msg', body: { text: 'hello alice' } },
            aliceDid,
            { name: 'Bob' }
        );

        const requests: any[] = [];
        let challengeCount = 0;
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = String(input);
            requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            if (url === `${base}/api/v1/challenge`) {
                challengeCount += 1;
                return jsonResponse({ challenge: `mailbox-${challengeCount}` });
            }
            if (url === `${base}/api/v1/messages/fetch`) {
                return jsonResponse({
                    messages: [
                        { id: 'msg-ok', message: packed },
                        { id: 'msg-bad', message: 'not an encrypted envelope' },
                    ],
                });
            }
            if (url === `${base}/api/v1/messages/remove`) {
                return jsonResponse({ ok: true });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        const received = await keymaster.receiveDidComm({ name: 'Alice' });

        expect(received).toHaveLength(1);
        expect(received[0].message.body).toEqual({ text: 'hello alice' });
        expect(received[0].metadata.authenticated).toBe(true);

        const fetchBody = requests.find(r => r.url.endsWith('/messages/fetch'))?.body;
        const removeBody = requests.find(r => r.url.endsWith('/messages/remove'))?.body;
        expect(fetchBody.did).toBe(aliceDid);
        expect(removeBody.ids).toEqual(['msg-ok']);
    });

    it('leaves messages on the server and returns their ids when ack is false', async () => {
        const base = useDidCommGateway();
        const aliceDid = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');
        await keymaster.publishDidComm('https://bob.example/didcomm', 'Bob');

        const packed = await keymaster.packDidComm(
            { type: 'https://x/1/msg', body: { text: 'keep me' } },
            aliceDid,
            { name: 'Bob' }
        );

        const requests: string[] = [];
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            requests.push(url);
            if (url === `${base}/api/v1/challenge`) {
                return jsonResponse({ challenge: 'mailbox-1' });
            }
            if (url === `${base}/api/v1/messages/fetch`) {
                return jsonResponse({ messages: [{ id: 'msg-ok', message: packed }] });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        const received = await keymaster.receiveDidComm({ name: 'Alice', ack: false });

        expect(received).toHaveLength(1);
        expect(received[0].id).toBe('msg-ok');
        expect(received[0].message.body).toEqual({ text: 'keep me' });
        expect(requests.some(url => url.endsWith('/messages/remove'))).toBe(false);
    });

    it('ackDidComm removes the given ids with a freshly signed challenge', async () => {
        const base = useDidCommGateway();
        const aliceDid = await keymaster.createId('Alice');
        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');

        const requests: any[] = [];
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = String(input);
            requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            if (url === `${base}/api/v1/challenge`) {
                return jsonResponse({ challenge: 'mailbox-ack' });
            }
            if (url === `${base}/api/v1/messages/remove`) {
                return jsonResponse({ removed: 2 });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        const acknowledged = await keymaster.ackDidComm(['msg-1', 'msg-2'], { name: 'Alice' });

        expect(acknowledged).toBe(2);
        const removeBody = requests.find(r => r.url.endsWith('/messages/remove'))?.body;
        expect(removeBody.did).toBe(aliceDid);
        expect(removeBody.ids).toEqual(['msg-1', 'msg-2']);
        expect(removeBody.challenge).toBe('mailbox-ack');
        expect(removeBody.signature).toBeDefined();
    });

    it('ackDidComm reports the count the relay removed, not the count requested', async () => {
        const base = useDidCommGateway();
        await keymaster.createId('Alice');
        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');

        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url === `${base}/api/v1/challenge`) {
                return jsonResponse({ challenge: 'mailbox-ack' });
            }
            if (url === `${base}/api/v1/messages/remove`) {
                // Two ids asked for, but the relay only had one left to remove
                // (the other was already acknowledged or has expired).
                return jsonResponse({ removed: 1 });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        expect(await keymaster.ackDidComm(['msg-1', 'msg-gone'], { name: 'Alice' })).toBe(1);
    });

    it('ackDidComm reports zero when the relay removed nothing', async () => {
        const base = useDidCommGateway();
        await keymaster.createId('Alice');
        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');

        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url === `${base}/api/v1/challenge`) {
                return jsonResponse({ challenge: 'mailbox-ack' });
            }
            if (url === `${base}/api/v1/messages/remove`) {
                return jsonResponse({ removed: 0 });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        // A repeated ack must not report the ids it asked about as removed.
        expect(await keymaster.ackDidComm(['msg-1'], { name: 'Alice' })).toBe(0);
    });

    it('acknowledges when ack is left undefined, and only skips on an explicit false', async () => {
        const base = useDidCommGateway();
        const aliceDid = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');
        await keymaster.publishDidComm('https://bob.example/didcomm', 'Bob');

        const packed = await keymaster.packDidComm(
            { type: 'https://x/1/msg', body: { text: 'hi' } },
            aliceDid,
            { name: 'Bob' }
        );

        const removeCalls: string[] = [];
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url === `${base}/api/v1/challenge`) {
                return jsonResponse({ challenge: 'mailbox-1' });
            }
            if (url === `${base}/api/v1/messages/fetch`) {
                return jsonResponse({ messages: [{ id: 'msg-ok', message: packed }] });
            }
            if (url === `${base}/api/v1/messages/remove`) {
                removeCalls.push(url);
                return jsonResponse({ removed: 1 });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        // undefined and null must both behave as "ack", so a JSON null arriving
        // through the API boundary cannot silently retain messages.
        await keymaster.receiveDidComm({ name: 'Alice', ack: undefined });
        expect(removeCalls).toHaveLength(1);

        await keymaster.receiveDidComm({ name: 'Alice', ack: null as any });
        expect(removeCalls).toHaveLength(2);

        await keymaster.receiveDidComm({ name: 'Alice', ack: false });
        expect(removeCalls).toHaveLength(2);
    });

    it('ackDidComm does not call the gateway for an empty id list', async () => {
        useDidCommGateway();
        await keymaster.createId('Alice');

        const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            throw new Error(`unexpected fetch ${String(input)}`);
        });

        expect(await keymaster.ackDidComm([], { name: 'Alice' })).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ackDidComm rejects a non-array id list', async () => {
        useDidCommGateway();
        await keymaster.createId('Alice');

        await expect(keymaster.ackDidComm('msg-1' as any, { name: 'Alice' }))
            .rejects.toThrow('Invalid parameter: ids');
    });

    it('ackDidComm surfaces a failed remove call', async () => {
        const base = useDidCommGateway();
        await keymaster.createId('Alice');

        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url === `${base}/api/v1/challenge`) {
                return jsonResponse({ challenge: 'mailbox-ack' });
            }
            if (url === `${base}/api/v1/messages/remove`) {
                return jsonResponse({ error: 'nope' }, 500);
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        await expect(keymaster.ackDidComm(['msg-1'], { name: 'Alice' }))
            .rejects.toThrow('DIDComm ack failed: 500');
    });

    it('deposits locally when the recipient mailbox lives on this node', async () => {
        // Sending to your own identity must not leave the node. With an
        // auto-discovered .onion endpoint, egress would mean a full Tor round trip
        // out and back -- and no delivery at all on a node running no Tor.
        const base = useDidCommGateway();
        const onion = 'http://abcdefghijklmnop.onion:4222/didcomm';
        (gatekeeper as any).getDidCommEndpoint = async () => onion;

        const aliceDid = await keymaster.createId('Alice');
        await keymaster.publishDidComm(onion, 'Alice');

        const posted: string[] = [];
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = String(input);
            posted.push(url);
            if (url === `${base}/api/v1/messages`) {
                expect(String(init?.body)).toContain('protected');
                return jsonResponse({ ids: ['local-1'] });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        await expect(
            keymaster.sendDidComm({ type: 'https://x/1/msg', body: {} }, aliceDid, { name: 'Alice' })
        ).resolves.toEqual(['local-1']);

        expect(posted).toEqual([`${base}/api/v1/messages`]);
        expect(posted).not.toContain(`${base}/api/v1/deliver`);
        expect(posted).not.toContain(`${base}/api/v1/challenge`);
    });

    it('still goes through the service when the recipient is on another node', async () => {
        const base = useDidCommGateway();
        (gatekeeper as any).getDidCommEndpoint = async () => 'https://mynode.example/didcomm';

        await keymaster.createId('Alice');
        const bobDid = await keymaster.createId('Bob');
        await keymaster.publishDidComm('https://mynode.example/didcomm', 'Alice');
        await keymaster.publishDidComm('https://othernode.example/didcomm', 'Bob');

        const posted: string[] = [];
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            posted.push(url);
            if (url === `${base}/api/v1/challenge`) {
                return jsonResponse({ challenge: 'remote-challenge' });
            }
            if (url === `${base}/api/v1/deliver`) {
                return jsonResponse({ ids: ['remote-1'] });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        await expect(
            keymaster.sendDidComm({ type: 'https://x/1/msg', body: {} }, bobDid, { name: 'Alice' })
        ).resolves.toEqual(['remote-1']);

        expect(posted).toContain(`${base}/api/v1/deliver`);
        expect(posted).not.toContain(`${base}/api/v1/messages`);
    });

    it('sends through the service when a mediator is in the path, even on this node', async () => {
        // The Forward envelope is addressed to the mediator, not to us; depositing
        // it here would put an envelope this node cannot unpack in a local mailbox.
        const base = useDidCommGateway();
        const nodeEndpoint = 'https://mynode.example/didcomm';
        (gatekeeper as any).getDidCommEndpoint = async () => nodeEndpoint;

        await keymaster.createId('Alice');
        const mediatorDid = await keymaster.createId('Mediator');
        const bobDid = await keymaster.createId('Bob');
        await keymaster.publishDidComm(nodeEndpoint, 'Alice');
        await keymaster.publishDidComm(nodeEndpoint, 'Mediator');
        await keymaster.publishDidComm(nodeEndpoint, 'Bob', [mediatorDid]);

        const posted: string[] = [];
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            posted.push(url);
            if (url === `${base}/api/v1/challenge`) {
                return jsonResponse({ challenge: 'mediated-challenge' });
            }
            if (url === `${base}/api/v1/deliver`) {
                return jsonResponse({ ids: ['mediated-1'] });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        await expect(
            keymaster.sendDidComm({ type: 'https://x/1/msg', body: {} }, bobDid, { name: 'Alice' })
        ).resolves.toEqual(['mediated-1']);

        expect(posted).toContain(`${base}/api/v1/deliver`);
        expect(posted).not.toContain(`${base}/api/v1/messages`);
    });

    it('carries the service error body into a failed delivery', async () => {
        // 502 alone cannot tell a missing Tor proxy from a recipient that rejected
        // the envelope; the reason lives in the body.
        const base = useDidCommGateway();
        await keymaster.createId('Alice');
        const bobDid = await keymaster.createId('Bob');
        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');
        await keymaster.publishDidComm('https://bob.example/didcomm', 'Bob');

        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url === `${base}/api/v1/challenge`) {
                return jsonResponse({ challenge: 'delivery-challenge' });
            }
            if (url === `${base}/api/v1/deliver`) {
                return jsonResponse({ error: 'onion endpoint requires a Tor proxy (set ARCHON_DIDCOMM_TOR_PROXY)' }, 502);
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        await expect(
            keymaster.sendDidComm({ type: 'https://x/1/msg', body: {} }, bobDid, { name: 'Alice' })
        ).rejects.toThrow(/502 \(onion endpoint requires a Tor proxy/);
    });

    it('still reports a failed delivery when the service sends no error body', async () => {
        const base = useDidCommGateway();
        await keymaster.createId('Alice');
        const bobDid = await keymaster.createId('Bob');
        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');
        await keymaster.publishDidComm('https://bob.example/didcomm', 'Bob');

        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url === `${base}/api/v1/challenge`) {
                return jsonResponse({ challenge: 'delivery-challenge' });
            }
            if (url === `${base}/api/v1/deliver`) {
                return new Response('gateway timeout', { status: 504 });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        await expect(
            keymaster.sendDidComm({ type: 'https://x/1/msg', body: {} }, bobDid, { name: 'Alice' })
        ).rejects.toThrow(/failed: 504$/);
    });

    it('surfaces DIDComm gateway challenge failures clearly', async () => {
        const base = useDidCommGateway();
        await keymaster.createId('Alice');
        const bobDid = await keymaster.createId('Bob');
        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');
        await keymaster.publishDidComm('https://bob.example/didcomm', 'Bob');

        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            if (String(input) === `${base}/api/v1/challenge`) {
                throw new TypeError('fetch failed');
            }
            throw new Error(`unexpected fetch ${String(input)}`);
        });

        await expect(
            keymaster.sendDidComm({ type: 'https://x/1/msg', body: {} }, bobDid, { name: 'Alice' })
        ).rejects.toThrow(/could not reach the DIDComm gateway/);
    });

    it('derives DIDComm gateway from the Gatekeeper client URL', async () => {
        const gatekeeperURL = 'https://drawbridge.example';
        (gatekeeper as any).url = gatekeeperURL;
        await keymaster.createId('Alice');
        const bobDid = await keymaster.createId('Bob');
        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');
        await keymaster.publishDidComm('https://bob.example/didcomm', 'Bob');

        const requests: string[] = [];
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = String(input);
            requests.push(url);
            if (url === `${gatekeeperURL}/api/v1/capabilities`) {
                return jsonResponse({ didcomm: true });
            }
            if (url === `${gatekeeperURL}/didcomm/api/v1/challenge`) {
                return jsonResponse({ challenge: 'gatekeeper-url-challenge' });
            }
            if (url === `${gatekeeperURL}/didcomm/api/v1/deliver`) {
                expect(JSON.parse(String(init?.body)).endpoint).toBe('https://bob.example/didcomm');
                return jsonResponse({ ids: ['gatekeeper-url-msg'] });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        await expect(
            keymaster.sendDidComm({ type: 'https://x/1/msg', body: {} }, bobDid, { name: 'Alice' })
        ).resolves.toEqual(['gatekeeper-url-msg']);
        expect(requests).toContain(`${gatekeeperURL}/api/v1/capabilities`);
        expect(requests).toContain(`${gatekeeperURL}/didcomm/api/v1/challenge`);
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

    // The same signal the gates use, exposed so a wallet can hide a surface instead
    // of offering it and failing.
    it('reports the manifest and fetches it only once', async () => {
        const nodeURL = 'https://node.example';
        (gatekeeper as any).url = nodeURL;

        const requests: string[] = [];
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            requests.push(String(input));
            return jsonResponse({ didcomm: true, lightning: false, names: true });
        });

        await expect(keymaster.getNodeCapabilities()).resolves.toEqual({
            didcomm: true,
            lightning: false,
            names: true,
        });
        await keymaster.getNodeCapabilities();

        expect(requests).toEqual([`${nodeURL}/api/v1/capabilities`]);
    });

    it('reports null when the node serves no manifest', async () => {
        (gatekeeper as any).url = 'https://node.example';
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ error: 'not found' }, 404));

        await expect(keymaster.getNodeCapabilities()).resolves.toBeNull();
    });

    it('reports null when no node URL is configured', async () => {
        (gatekeeper as any).url = undefined;
        await expect(keymaster.getNodeCapabilities()).resolves.toBeNull();
    });
});

describe('credential exchange over DIDComm', () => {
    // #905: sendCredential posts a Notice carrying the credential's DID, which
    // only works for a did:cid subject -- issueCredential encrypts to the ISSUER
    // when the subject is foreign, so such a holder can neither resolve that DID
    // nor decrypt what it points at. DIDComm carries the credential itself, which
    // is the only way to reach them.
    const mockSchema = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { email: { type: 'string' } },
        required: ['email'],
    };

    async function issueTo(subject: string) {
        const schemaDid = await keymaster.createSchema(mockSchema);
        const bound = await keymaster.bindCredential(subject, { schema: schemaDid });
        return keymaster.issueCredential(bound);
    }

    it('sends the credential itself, not a reference to it', async () => {
        const base = useDidCommGateway();
        await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');
        await keymaster.publishDidComm('https://alice.example/didcomm', 'Alice');
        await keymaster.publishDidComm('https://bob.example/didcomm', 'Bob');
        await keymaster.setCurrentId('Alice');

        const credentialDid = await issueTo(bob);

        let packed = '';
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = String(input);
            if (url === `${base}/api/v1/challenge`) {
                return jsonResponse({ challenge: 'credential-challenge' });
            }
            if (url === `${base}/api/v1/deliver`) {
                packed = JSON.parse(String(init?.body)).message;
                return jsonResponse({ ids: ['credential-1'] });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        await expect(keymaster.sendCredentialDidComm(credentialDid, bob, { name: 'Alice' }))
            .resolves.toEqual(['credential-1']);

        // Bob can read it because it was addressed to him, and what he gets is a
        // credential rather than a pointer.
        const { message } = await keymaster.unpackDidComm(packed, { name: 'Bob' });
        expect(message.type).toBe('https://didcomm.org/issue-credential/3.0/issue-credential');

        // The DID is named in the body, where the issue-credential protocol puts
        // it, and again inside the credential as its `id`. Those used to be
        // alternatives: an `id` written after signing would have broken the
        // proof, which covers every field but `proof` itself. issueCredential
        // now sets it before signing -- it re-signs once the asset exists and
        // its DID is known -- so the credential carries its own identifier and
        // still verifies (#108). The assertion below proves the second half.
        expect(message.body.credential_did).toBe(credentialDid);

        const attached = message.attachments[0].data.json;
        // Self-describing on the wire: a recipient holding only the attachment
        // knows which asset it came from, without trusting whoever handed it
        // over to have named it honestly.
        expect(attached.id).toBe(credentialDid);
        expect(attached.credentialSubject.id).toBe(bob);
        expect(attached.issuer).toBeDefined();
        // The signature travels with it, so a foreign holder can verify against
        // the issuer's DID without holding anything of ours. Asserting that a
        // proof is merely PRESENT would pass even if the transmitted credential
        // no longer matched what was signed, which is the whole point of sending
        // the credential rather than a reference.
        expect(attached.proof).toBeDefined();
        await expect(keymaster.verifyProof(attached)).resolves.toBe(true);
    });

    it('accepts a credential that arrived over DIDComm', async () => {
        await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');
        await keymaster.setCurrentId('Alice');
        const credentialDid = await issueTo(bob);
        const vc = await keymaster.getCredential(credentialDid);

        await keymaster.setCurrentId('Bob');
        const message = {
            type: 'https://didcomm.org/issue-credential/3.0/issue-credential',
            body: { credential_did: credentialDid },
            attachments: [{ data: { json: vc } }],
        };

        await expect(keymaster.acceptCredentialDidComm(message)).resolves.toBe(true);
        await expect(keymaster.listCredentials()).resolves.toContain(credentialDid);
    });

    it('refuses a credential that is not the one it showed', async () => {
        // A sender can name one credential in the body and attach another. Both
        // must be genuinely issued to this holder for acceptCredential to take
        // them, so this is not forgery -- but storing something other than what
        // the user was shown is still wrong.
        //
        // The credential now names its own asset under the issuer's signature
        // (#108), so the two would disagree on a mismatch. Comparing the full
        // content catches strictly more: an attachment naming the right DID but
        // differing from what that DID holds is also refused.
        await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');
        await keymaster.setCurrentId('Alice');
        const shown = await issueTo(bob);
        const named = await issueTo(bob);
        const shownVc = await keymaster.getCredential(shown);

        await keymaster.setCurrentId('Bob');
        const message = {
            type: 'https://didcomm.org/issue-credential/3.0/issue-credential',
            body: { credential_did: named },
            attachments: [{ data: { json: shownVc } }],
        };

        await expect(keymaster.acceptCredentialDidComm(message)).resolves.toBe(false);
        await expect(keymaster.listCredentials()).resolves.not.toContain(named);
    });

    it('declines a credential with no did:cid to resolve', async () => {
        // A credential from a foreign issuer carries no DID this wallet can look
        // up, so there is nothing to hold. Saying so is better than reporting a
        // success that stored nothing.
        await keymaster.createId('Alice');

        const foreign = {
            type: 'https://didcomm.org/issue-credential/3.0/issue-credential',
            body: { credential_did: 'https://university.example/credentials/1872' },
            attachments: [{ data: { json: {
                id: 'https://university.example/credentials/1872',
                issuer: 'did:web:university.example',
                credentialSubject: { id: 'did:key:z6Mk' },
            } } }],
        };

        await expect(keymaster.acceptCredentialDidComm(foreign)).resolves.toBe(false);
        await expect(keymaster.acceptCredentialDidComm({ body: {} })).resolves.toBe(false);
    });
});
