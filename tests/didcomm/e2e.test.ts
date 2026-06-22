import type { Server } from 'http';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import HeliaClient from '@didcid/ipfs/helia';
import { createApp } from '../../services/didcomm/server/src/didcomm-api.ts';
import { MemoryMailboxStore } from '../../services/didcomm/server/src/store.ts';

// End-to-end: two Archon identities exchange a DIDComm message through the live
// mailbox relay (real express routes + signed-challenge auth + keymaster
// send/receive client), over HTTP.
let ipfs: HeliaClient;
let gatekeeper: Gatekeeper;
let cipher: CipherNode;
let keymaster: Keymaster;
let server: Server;
let endpoint: string;

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
    cipher = new CipherNode();
    keymaster = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher, passphrase: 'pass' });

    const app = createApp({ store: new MemoryMailboxStore(), resolver: gatekeeper, cipher });
    await new Promise<void>(resolve => { server = app.listen(0, resolve); });
    const port = (server.address() as any).port;
    endpoint = `http://localhost:${port}`;
});

afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('DIDComm relay end-to-end', () => {
    it('delivers an authcrypt message from Alice to Bob through the mailbox', async () => {
        const aliceDid = await keymaster.createId('Alice');
        const bobDid = await keymaster.createId('Bob');
        await keymaster.publishDidComm(endpoint, 'Alice');
        await keymaster.publishDidComm(endpoint, 'Bob');

        const body = { text: 'hello over the relay', n: 5 };
        const ids = await keymaster.sendDidComm({ type: 'https://x/1/msg', body }, bobDid, { name: 'Alice' });
        expect(ids.length).toBe(1);

        const received = await keymaster.receiveDidComm({ name: 'Bob' });
        expect(received).toHaveLength(1);
        expect(received[0].message.body).toEqual(body);
        expect(received[0].message.from).toBe(aliceDid);
        expect(received[0].metadata.authenticated).toBe(true);

        // acked: a second fetch returns nothing
        const again = await keymaster.receiveDidComm({ name: 'Bob' });
        expect(again).toHaveLength(0);
    });

    it('delivers a signed (non-repudiable) message', async () => {
        const aliceDid = await keymaster.createId('Alice');
        const bobDid = await keymaster.createId('Bob');
        await keymaster.publishDidComm(endpoint, 'Alice');
        await keymaster.publishDidComm(endpoint, 'Bob');

        await keymaster.sendDidComm({ type: 'https://x/1/msg', body: { hi: 1 } }, bobDid, { name: 'Alice', sign: true });

        const received = await keymaster.receiveDidComm({ name: 'Bob' });
        expect(received).toHaveLength(1);
        expect(received[0].metadata.nonRepudiation).toBe(true);
        expect(received[0].metadata.signer).toBe(`${aliceDid}#key-1`);
    });

    it('rejects a forged fetch (wrong key for the DID)', async () => {
        await keymaster.createId('Alice');
        await keymaster.publishDidComm(endpoint, 'Alice');
        const bobDid = await keymaster.createId('Bob');
        await keymaster.publishDidComm(endpoint, 'Bob');

        // Mallory tries to read Bob's mailbox by pointing her receive at Bob's endpoint
        // but signing with her own key — the relay must reject it.
        await keymaster.createId('Mallory');
        await keymaster.publishDidComm(endpoint, 'Mallory');
        await keymaster.sendDidComm({ type: 'https://x/1/msg', body: { secret: true } }, bobDid, { name: 'Alice' });

        // forge: fetch Bob's messages with Mallory's challenge signature
        const { challenge } = await (await fetch(`${endpoint}/api/v1/challenge`)).json();
        const malloryKp = await keymaster.fetchKeyPair('Mallory');
        const signature = cipher.signHash(cipher.hashMessage(challenge), malloryKp!.privateJwk);
        const res = await fetch(`${endpoint}/api/v1/messages/fetch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ did: bobDid, challenge, signature }),
        });
        expect(res.status).toBe(401);
    });
});
