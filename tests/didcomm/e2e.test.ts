import type { Server } from 'http';
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from 'undici';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import HeliaClient from '@didcid/ipfs/helia';
import { createApp } from '../../services/didcomm/server/src/didcomm-api.ts';
import { MemoryMailboxStore } from '../../services/didcomm/server/src/store.ts';
import {
    basicMessage,
    trustPing,
    trustPingResponse,
    issueCredentialMessage,
    requestPresentation,
    presentationMessage,
    attachedJson,
    BASIC_MESSAGE_TYPE,
    TRUST_PING_TYPE,
    TRUST_PING_RESPONSE_TYPE,
    ISSUE_CREDENTIAL_TYPE,
    PRESENT_PROOF_REQUEST_TYPE,
    mediateRequest,
    mediateGrant,
    keylistUpdate,
    keylistUpdateResponse,
    MEDIATE_REQUEST_TYPE,
    MEDIATE_GRANT_TYPE,
    KEYLIST_UPDATE_TYPE,
    KEYLIST_UPDATE_RESPONSE_TYPE,
} from '../../packages/keymaster/src/didcomm-protocols.ts';
import { mockSchema } from '../keymaster/helper.ts';

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
    // Close client-side keep-alive sockets (the keymaster's fetches and the
    // relay's own outbound /deliver fetch both use the global undici dispatcher).
    // Otherwise undici lazy-imports during socket cleanup after Jest tears the
    // environment down → "import after teardown". Swap in a fresh dispatcher so
    // later suites in the same --runInBand process keep working.
    const previousDispatcher = getGlobalDispatcher();
    setGlobalDispatcher(new Agent());
    await previousDispatcher.close().catch(() => undefined);

    if (ipfs) {
        await ipfs.stop();
    }
});

beforeEach(async () => {
    const db = new DbJsonMemory('test');
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm'] });
    cipher = new CipherNode();

    // allowPrivateEgress: the relay both stores mail and (Phase 8) performs
    // outbound delivery; tests deliver to the same localhost relay.
    const app = createApp({ store: new MemoryMailboxStore(), resolver: gatekeeper, cipher, allowPrivateEgress: true });
    await new Promise<void>(resolve => { server = app.listen(0, resolve); });
    const port = (server.address() as any).port;
    endpoint = `http://localhost:${port}`;

    // The keymaster sends through the DIDComm service (here, the same relay).
    keymaster = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher, passphrase: 'pass', didcommServiceURL: endpoint });
});

afterEach(async () => {
    // Phase 8 sends fan out extra round-trips (challenge + deliver + the relay's
    // own outbound delivery), leaving keep-alive sockets that can fire after the
    // Jest env tears down ("import after teardown"). Force them closed.
    await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections?.();
    });
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

    it('delivers Alice -> mediator -> Bob via the Forward protocol', async () => {
        const aliceDid = await keymaster.createId('Alice');
        await keymaster.createId('Mediator');
        const bobDid = await keymaster.createId('Bob');

        await keymaster.publishDidComm(endpoint, 'Alice');
        await keymaster.publishDidComm(endpoint, 'Mediator');
        // Bob is reachable via the mediator: advertise its routing key.
        const medDoc = await keymaster.resolveDID('Mediator');
        const medKid = medDoc.didDocument!.keyAgreement![0];
        await keymaster.publishDidComm(endpoint, 'Bob', [medKid]);

        const body = { text: 'routed hello', n: 8 };
        const ids = await keymaster.sendDidComm({ type: 'https://x/1/msg', body }, bobDid, { name: 'Alice' });
        expect(ids.length).toBe(1);

        // The Forward is queued under the mediator, not Bob — Bob's box is empty.
        expect(await keymaster.receiveDidComm({ name: 'Bob' })).toHaveLength(0);

        // Mediator relays the inner envelope to Bob.
        const relay = await keymaster.mediateDidComm({ name: 'Mediator' });
        expect(relay.relayed).toBe(1);

        // Now Bob receives the original message.
        const received = await keymaster.receiveDidComm({ name: 'Bob' });
        expect(received).toHaveLength(1);
        expect(received[0].message.body).toEqual(body);
        expect(received[0].message.from).toBe(aliceDid);
        expect(received[0].metadata.authenticated).toBe(true);
    });

    it('exchanges a Basic Message and a Trust Ping (with response) over the relay', async () => {
        const aliceDid = await keymaster.createId('Alice');
        const bobDid = await keymaster.createId('Bob');
        await keymaster.publishDidComm(endpoint, 'Alice');
        await keymaster.publishDidComm(endpoint, 'Bob');

        // Alice -> Bob: a basic message and a trust ping
        await keymaster.sendDidComm(basicMessage('gm bob'), bobDid, { name: 'Alice' });
        await keymaster.sendDidComm(trustPing(), bobDid, { name: 'Alice' });

        const bobInbox = await keymaster.receiveDidComm({ name: 'Bob' });
        expect(bobInbox).toHaveLength(2);
        const message = bobInbox.find(m => m.message.type === BASIC_MESSAGE_TYPE)!;
        expect(message.message.body.content).toBe('gm bob');
        const ping = bobInbox.find(m => m.message.type === TRUST_PING_TYPE)!;
        expect(ping.message.body.response_requested).toBe(true);
        expect(ping.message.from).toBe(aliceDid);

        // Bob responds to the ping, correlated by thid
        await keymaster.sendDidComm(trustPingResponse(ping.message.id), aliceDid, { name: 'Bob' });

        const aliceInbox = await keymaster.receiveDidComm({ name: 'Alice' });
        expect(aliceInbox).toHaveLength(1);
        expect(aliceInbox[0].message.type).toBe(TRUST_PING_RESPONSE_TYPE);
        expect(aliceInbox[0].message.thid).toBe(ping.message.id);
    });

    it('issues a credential and verifies a presentation over DIDComm', async () => {
        const aliceDid = await keymaster.createId('Alice'); // issuer
        const bobDid = await keymaster.createId('Bob');     // holder
        const carolDid = await keymaster.createId('Carol'); // verifier
        await keymaster.publishDidComm(endpoint, 'Alice');
        await keymaster.publishDidComm(endpoint, 'Bob');
        await keymaster.publishDidComm(endpoint, 'Carol');

        // Alice issues a signed VC to Bob over DIDComm (issue-credential/3.0).
        await keymaster.setCurrentId('Alice');
        const schema = await keymaster.createSchema(mockSchema);
        const bound = await keymaster.bindCredential(bobDid, { schema });
        const signedVc = await keymaster.addProof(bound, 'Alice');
        await keymaster.sendDidComm(issueCredentialMessage(signedVc, { comment: 'your credential' }), bobDid, { name: 'Alice' });

        const issued = await keymaster.receiveDidComm({ name: 'Bob' });
        expect(issued).toHaveLength(1);
        expect(issued[0].message.type).toBe(ISSUE_CREDENTIAL_TYPE);
        const receivedVc = attachedJson(issued[0].message);
        expect(receivedVc.issuer).toBe(aliceDid);
        expect(await keymaster.verifyProof(receivedVc)).toBe(true);

        // Carol requests a presentation; Bob presents the VC in a VP (present-proof/3.0).
        await keymaster.sendDidComm(requestPresentation('prove your credential'), bobDid, { name: 'Carol' });
        const request = (await keymaster.receiveDidComm({ name: 'Bob' }))[0];
        expect(request.message.type).toBe(PRESENT_PROOF_REQUEST_TYPE);

        const vp = await keymaster.addProof({
            '@context': ['https://www.w3.org/ns/credentials/v2'],
            type: ['VerifiablePresentation'],
            holder: bobDid,
            verifiableCredential: [receivedVc],
        }, 'Bob', 'authentication');
        await keymaster.sendDidComm(presentationMessage(vp, { thid: request.message.id }), carolDid, { name: 'Bob' });

        const presented = await keymaster.receiveDidComm({ name: 'Carol' });
        expect(presented).toHaveLength(1);
        const receivedVp = attachedJson(presented[0].message);
        expect(receivedVp.holder).toBe(bobDid);
        // Bob's holder signature and Alice's issuer signature both verify.
        expect(await keymaster.verifyProof(receivedVp)).toBe(true);
        expect(await keymaster.verifyProof(receivedVp.verifiableCredential[0])).toBe(true);
    });

    it('enrolls with a mediator via Coordinate-Mediation, then routes through it', async () => {
        const aliceDid = await keymaster.createId('Alice');
        const mediatorDid = await keymaster.createId('Mediator');
        const bobDid = await keymaster.createId('Bob');
        await keymaster.publishDidComm(endpoint, 'Alice');
        await keymaster.publishDidComm(endpoint, 'Mediator');
        // Bob starts with a plain endpoint (no mediator yet).
        await keymaster.publishDidComm(endpoint, 'Bob');

        // 1. Bob requests mediation from the mediator.
        await keymaster.sendDidComm(mediateRequest(), mediatorDid, { name: 'Bob' });

        // 2. Mediator grants, returning its routing_did.
        const reqInbox = await keymaster.receiveDidComm({ name: 'Mediator' });
        expect(reqInbox[0].message.type).toBe(MEDIATE_REQUEST_TYPE);
        await keymaster.sendDidComm(mediateGrant(mediatorDid, reqInbox[0].message.id), bobDid, { name: 'Mediator' });

        // 3. Bob receives the grant and registers his recipient DID (keylist-update).
        const grantInbox = await keymaster.receiveDidComm({ name: 'Bob' });
        expect(grantInbox[0].message.type).toBe(MEDIATE_GRANT_TYPE);
        const routingDid = grantInbox[0].message.body.routing_did;
        expect(routingDid).toBe(mediatorDid);
        await keymaster.sendDidComm(keylistUpdate([bobDid], 'add'), mediatorDid, { name: 'Bob' });

        // 4. Mediator acknowledges the keylist update.
        const kuInbox = await keymaster.receiveDidComm({ name: 'Mediator' });
        expect(kuInbox[0].message.type).toBe(KEYLIST_UPDATE_TYPE);
        await keymaster.sendDidComm(
            keylistUpdateResponse([{ recipient_did: bobDid, action: 'add', result: 'success' }], kuInbox[0].message.id),
            bobDid, { name: 'Mediator' },
        );
        const kurInbox = await keymaster.receiveDidComm({ name: 'Bob' });
        expect(kurInbox[0].message.type).toBe(KEYLIST_UPDATE_RESPONSE_TYPE);
        expect(kurInbox[0].message.body.updated[0].result).toBe('success');

        // 5. Bob re-publishes advertising the granted routing_did (now behind the mediator).
        await keymaster.publishDidComm(endpoint, 'Bob', [routingDid]);

        // 6. Alice sends to Bob -> wrapped in a Forward to the mediator; mediator relays.
        await keymaster.sendDidComm(basicMessage('routed via coordinate-mediation'), bobDid, { name: 'Alice' });
        expect((await keymaster.mediateDidComm({ name: 'Mediator' })).relayed).toBe(1);

        const received = await keymaster.receiveDidComm({ name: 'Bob' });
        expect(received).toHaveLength(1);
        expect(received[0].message.body.content).toBe('routed via coordinate-mediation');
        expect(aliceDid).toMatch(/^did:/);
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
