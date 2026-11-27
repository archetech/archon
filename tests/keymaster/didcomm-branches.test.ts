import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { jest } from '@jest/globals';
import { packDidCommMessage, packEncrypted } from '@didcid/cipher/didcomm';

let ipfs: MemoryClient;
let gatekeeper: Gatekeeper;
let keymaster: Keymaster;
let aliceDid: string;
let bobDid: string;

const endpoint = 'https://relay.example/didcomm';
const body = { text: 'hello' };

beforeAll(async () => {
    ipfs = new MemoryClient();
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
    // Key rotation needs a confirmed document, which the local registry gives at once.
    aliceDid = await keymaster.createId('Alice', { registry: 'local' });
    bobDid = await keymaster.createId('Bob', { registry: 'local' });
    await keymaster.publishDidComm(undefined, 'Alice');
    await keymaster.publishDidComm(undefined, 'Bob');
});

afterEach(() => {
    jest.restoreAllMocks();
});

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

// A relay that hands out a challenge and answers everything else with the
// given body, as a relay running an older or partial API might.
function relayAnswering(payload: unknown) {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        if (String(input).endsWith('/api/v1/challenge')) {
            return jsonResponse({ challenge: 'challenge-1' });
        }
        return jsonResponse(payload);
    });
}

describe('packDidComm', () => {
    it.each(['A256GCM', 'XC20P'] as const)('encrypts with the content encryption asked for (%s)', async (encryption) => {
        const packed = await keymaster.packDidComm({ type: 'https://x/1/msg', body }, bobDid, {
            name: 'Alice',
            encryption,
        });
        const header = JSON.parse(Buffer.from(JSON.parse(packed).protected, 'base64url').toString());

        expect(header.enc).toBe(encryption);
        const { message } = await keymaster.unpackDidComm(packed, { name: 'Bob' });
        expect(message.body).toEqual(body);
    });
});

describe('unpackDidComm', () => {
    it('refuses an authcrypt message whose sender has since unpublished its key-agreement key', async () => {
        const packed = await keymaster.packDidComm({ type: 'https://x/1/msg', body }, bobDid, { name: 'Alice' });
        await keymaster.unpublishDidComm('Alice');

        await expect(keymaster.unpackDidComm(packed, { name: 'Bob' }))
            .rejects.toThrow('Sender keyAgreement key not found');
    });

    it('refuses a signed message whose signing key the signer has since rotated away', async () => {
        const packed = await keymaster.packDidComm({ type: 'https://x/1/msg', body }, bobDid, {
            name: 'Alice',
            sign: true,
            anoncrypt: true,
        });
        await keymaster.setCurrentId('Alice');
        await keymaster.rotateKeys();

        await expect(keymaster.unpackDidComm(packed, { name: 'Bob' }))
            .rejects.toThrow('Signer key not found or not secp256k1');
    });
});

// Envelopes another implementation could send: the wallet only ever packs
// messages that name their sender and signer.
describe('unpackDidComm with envelopes packed elsewhere', () => {
    async function bobKey() {
        return { kid: `${bobDid}#key-agreement-1`, publicJwk: (await keymaster.fetchDidCommKeyPair('Bob')).publicJwk };
    }

    it('accepts an authenticated message that does not name its sender in the plaintext', async () => {
        const alice = await keymaster.fetchDidCommKeyPair('Alice');
        const packed = packDidCommMessage({ type: 'https://x/1/msg', body }, [await bobKey()], {
            sender: { kid: `${aliceDid}#key-agreement-1`, privateJwk: alice.privateJwk },
        });

        const { message, metadata } = await keymaster.unpackDidComm(packed, { name: 'Bob' });

        expect(message.from).toBeUndefined();
        expect(message.body).toEqual(body);
        expect(metadata.authenticated).toBe(true);
        expect(metadata.sender).toBe(`${aliceDid}#key-agreement-1`);
    });

    it('refuses a signed message whose signature names no key', async () => {
        const jws = { payload: 'e30', signatures: [{ protected: 'e30', signature: 'AA' }] };
        const packed = packEncrypted(new TextEncoder().encode(JSON.stringify(jws)), [await bobKey()], null, 'XC20P');

        await expect(keymaster.unpackDidComm(packed, { name: 'Bob' }))
            .rejects.toThrow('Signed message missing signer key id');
    });
});

describe('a relay that leaves fields out of its answers', () => {
    it('receives nothing when the fetch answer has no messages', async () => {
        relayAnswering({});

        expect(await keymaster.receiveDidComm({ name: 'Bob', endpoint })).toStrictEqual([]);
    });

    it('counts nothing removed when the remove answer has no count', async () => {
        relayAnswering({});

        expect(await keymaster.ackDidComm(['m1'], { name: 'Bob', endpoint })).toBe(0);
    });

    it('relays nothing when the mediator fetch answer has no messages', async () => {
        relayAnswering({});

        expect(await keymaster.mediateDidComm({ name: 'Bob', endpoint })).toStrictEqual({ relayed: 0, skipped: 0 });
    });
});

describe('ackDidComm', () => {
    it('acknowledges nothing without asking the relay when given no ids', async () => {
        const fetcher = jest.spyOn(globalThis, 'fetch');

        expect(await keymaster.ackDidComm([])).toBe(0);
        expect(fetcher).not.toHaveBeenCalled();
    });
});

// A backup holds the key index it was taken at; recovered after a rotation,
// the identity holds none of the keys its document publishes.
describe('an identity recovered from a backup older than its key', () => {
    beforeEach(async () => {
        await keymaster.backupId('Alice');
        await keymaster.setCurrentId('Alice');
        await keymaster.rotateKeys();
        await keymaster.removeId('Alice');
        await keymaster.recoverId(aliceDid);
    });

    it('cannot sign a DIDComm message', async () => {
        await expect(keymaster.packDidComm({ type: 'https://x/1/msg', body }, bobDid, {
            name: 'Alice',
            sign: true,
            anoncrypt: true,
        })).rejects.toThrow('Unable to resolve signing key');
    });

    it('cannot authenticate to its relay', async () => {
        const fetcher = relayAnswering({});

        await expect(keymaster.receiveDidComm({ name: 'Alice', endpoint })).rejects.toThrow('unable to resolve signing key');
        await expect(keymaster.ackDidComm(['m1'], { name: 'Alice', endpoint })).rejects.toThrow('unable to resolve signing key');
        await expect(keymaster.mediateDidComm({ name: 'Alice', endpoint })).rejects.toThrow('unable to resolve signing key');
        expect(fetcher).not.toHaveBeenCalled();
    });
});

// A node that offers DIDComm but publishes no endpoint of its own, as a node
// without a public relay address does. The stand-in gateway is the in-process
// Gatekeeper plus the two things a Drawbridge client adds: its URL and the
// endpoint lookup.
describe('sending through a node with no public DIDComm endpoint', () => {
    const nodeUrl = 'https://node.example';
    const gatewayBase = `${nodeUrl}/didcomm`;
    let sender: Keymaster;
    let deliveries: any[];

    beforeEach(async () => {
        const gateway = Object.create(gatekeeper);
        gateway.url = nodeUrl;
        gateway.getDidCommEndpoint = async () => null;
        sender = new Keymaster({
            gatekeeper: gateway,
            wallet: new WalletJsonMemory(),
            cipher: new CipherNode(),
            passphrase: 'passphrase',
        });
        await sender.loadOrCreateWallet();
        await sender.createId('Carol');

        deliveries = [];
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = String(input);
            if (url === `${nodeUrl}/api/v1/capabilities`) {
                return jsonResponse({ didcomm: true });
            }
            if (url === `${gatewayBase}/api/v1/challenge`) {
                return jsonResponse({ challenge: 'challenge-1' });
            }
            if (url === `${gatewayBase}/api/v1/deliver`) {
                deliveries.push(JSON.parse(String(init?.body)));
                // An answer with no ids: the relay took the message and said nothing more.
                return jsonResponse({});
            }
            throw new Error(`unexpected fetch ${url}`);
        });
    });

    it('publishes the key-agreement key alone when no endpoint is given', async () => {
        const carol = (await sender.fetchIdInfo('Carol')).did;

        expect(await sender.publishDidComm()).toBe(true);

        const doc = await sender.resolveDID(carol);
        expect(doc.didDocument!.keyAgreement).toEqual([`${carol}#key-agreement-1`]);
        expect(doc.didDocument!.service).toBeUndefined();
    });

    it('delivers to each recipient in a list through the gateway', async () => {
        await keymaster.publishDidComm('https://bob.example/didcomm', 'Bob');
        await sender.publishDidComm();

        const ids = await sender.sendDidComm({ type: 'https://x/1/msg', body }, [bobDid], { anoncrypt: true });

        expect(ids).toStrictEqual([]);
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0].endpoint).toBe('https://bob.example/didcomm');
        const { message } = await keymaster.unpackDidComm(deliveries[0].message, { name: 'Bob' });
        expect(message.body).toEqual(body);
    });

    it('deposits a message for a recipient on this node straight into the local relay', async () => {
        const local: string[] = [];
        const gateway = Object.create(gatekeeper);
        gateway.url = nodeUrl;
        gateway.getDidCommEndpoint = async () => `${gatewayBase}/`;
        const onNode = new Keymaster({
            gatekeeper: gateway,
            wallet: new WalletJsonMemory(),
            cipher: new CipherNode(),
            passphrase: 'passphrase',
        });
        await onNode.loadOrCreateWallet();
        await onNode.createId('Dave');
        await keymaster.publishDidComm(gatewayBase, 'Bob');
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = String(input);
            if (url === `${nodeUrl}/api/v1/capabilities`) {
                return jsonResponse({ didcomm: true });
            }
            if (url === `${gatewayBase}/api/v1/messages`) {
                local.push(String(init?.body));
                return jsonResponse({});
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        const ids = await onNode.sendDidComm({ type: 'https://x/1/msg', body }, bobDid, { anoncrypt: true });

        expect(ids).toStrictEqual([]);
        expect(local).toHaveLength(1);
        const { message } = await keymaster.unpackDidComm(local[0], { name: 'Bob' });
        expect(message.body).toEqual(body);
    });

    it('sends nothing for an identity that holds none of its published keys', async () => {
        await keymaster.publishDidComm('https://bob.example/didcomm', 'Bob');
        const carol = await sender.createId('Stale', { registry: 'local' });
        await sender.backupId('Stale');
        await sender.rotateKeys();
        await sender.removeId('Stale');
        await sender.recoverId(carol);

        await expect(sender.sendDidComm({ type: 'https://x/1/msg', body }, bobDid, { name: 'Stale', anoncrypt: true }))
            .rejects.toThrow('unable to resolve signing key');
        expect(deliveries).toHaveLength(0);
    });

    it('carries a comment with a credential it delivers', async () => {
        await keymaster.publishDidComm('https://bob.example/didcomm', 'Bob');
        await sender.publishDidComm();
        const bound = await sender.bindCredential(bobDid);
        const credential = await sender.issueCredential(bound);

        await sender.sendCredentialDidComm(credential, bobDid, { comment: 'as promised', anoncrypt: true });

        const { message } = await keymaster.unpackDidComm(deliveries[0].message, { name: 'Bob' });
        expect(message.body).toMatchObject({ comment: 'as promised', credential_did: credential });
    });
});
