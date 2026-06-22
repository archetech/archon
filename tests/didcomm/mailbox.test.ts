import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import HeliaClient from '@didcid/ipfs/helia';
import { packEncrypted } from '@didcid/cipher/didcomm';
import { MemoryMailboxStore, RedisMailboxStore } from '../../services/didcomm/server/src/store.ts';
import { recipientDidsFromEnvelope, verifyChallengeSignature } from '../../services/didcomm/server/src/mailbox.ts';

const enc = new TextEncoder();

describe('MemoryMailboxStore', () => {
    it('adds, lists, and removes messages per recipient', async () => {
        const store = new MemoryMailboxStore();
        await store.add('did:cid:bob', 'env-1', 'id-1');
        await store.add('did:cid:bob', 'env-2', 'id-2');
        await store.add('did:cid:carol', 'env-3', 'id-3');

        expect((await store.list('did:cid:bob')).map(m => m.id)).toEqual(['id-1', 'id-2']);
        expect(await store.list('did:cid:carol')).toHaveLength(1);

        expect(await store.remove('did:cid:bob', ['id-1'])).toBe(1);
        expect((await store.list('did:cid:bob')).map(m => m.id)).toEqual(['id-2']);
    });

    it('prunes messages past the TTL', async () => {
        let now = 1_000_000;
        const store = new MemoryMailboxStore(1000, 1000, () => now);
        await store.add('did:cid:bob', 'env', 'id-1');
        now += 1500; // past the 1000ms TTL
        expect(await store.list('did:cid:bob')).toHaveLength(0);
    });

    it('consumes a challenge once and rejects replays / expiry / unknowns', async () => {
        let now = 1_000_000;
        const store = new MemoryMailboxStore(1000, 1000, () => now);
        await store.issueChallenge('c1');
        expect(await store.consumeChallenge('c1')).toBe(true);
        expect(await store.consumeChallenge('c1')).toBe(false); // single-use
        expect(await store.consumeChallenge('unknown')).toBe(false);

        await store.issueChallenge('c2');
        now += 1500; // expired
        expect(await store.consumeChallenge('c2')).toBe(false);
    });
});

// Live-redis integration tests are opt-IN: they run only when ARCHON_REDIS_URL is
// set (pointing at a reachable redis). By default — and in the unit-test CI, which
// has no redis service — they are skipped. Running them against a dead redis would
// leave ioredis reconnecting forever, leaking a handle that hangs the jest process.
const describeRedis = process.env.ARCHON_REDIS_URL ? describe : describe.skip;

describeRedis('RedisMailboxStore (live redis)', () => {
    let store: RedisMailboxStore;

    beforeAll(async () => {
        store = new RedisMailboxStore(process.env.ARCHON_REDIS_URL!, `didcomm-test-${Date.now()}`);
        await store.connect();
    });

    afterAll(async () => {
        if (store) {
            await store.disconnect();
        }
    });

    it('adds, lists, and removes messages per recipient', async () => {
        await store.add('did:cid:bob', 'env-1', 'id-1');
        await store.add('did:cid:bob', 'env-2', 'id-2');
        await store.add('did:cid:carol', 'env-3', 'id-3');

        expect((await store.list('did:cid:bob')).map(m => m.id).sort()).toEqual(['id-1', 'id-2']);
        expect(await store.list('did:cid:carol')).toHaveLength(1);

        expect(await store.remove('did:cid:bob', ['id-1'])).toBe(1);
        expect((await store.list('did:cid:bob')).map(m => m.id)).toEqual(['id-2']);
    });

    it('consumes a challenge once (single-use) and rejects unknowns', async () => {
        await store.issueChallenge('rc1');
        expect(await store.consumeChallenge('rc1')).toBe(true);
        expect(await store.consumeChallenge('rc1')).toBe(false);
        expect(await store.consumeChallenge('never-issued')).toBe(false);
    });
});

describe('recipientDidsFromEnvelope', () => {
    it('extracts the recipient DIDs from the JWE recipient kids', () => {
        const cipher = new CipherNode();
        const bob = cipher.generateX25519Jwk(new Uint8Array(32).fill(9));
        const packed = packEncrypted(enc.encode('hi'), [{ kid: 'did:cid:bob#key-agreement-1', publicJwk: bob.publicJwk }], null, 'XC20P');
        expect(recipientDidsFromEnvelope(packed)).toEqual(['did:cid:bob']);
    });

    it('throws on a non-encrypted payload', () => {
        expect(() => recipientDidsFromEnvelope('{"not":"a jwe"}')).toThrow();
    });
});

describe('verifyChallengeSignature', () => {
    let ipfs: HeliaClient;
    let gatekeeper: Gatekeeper;
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
        gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm'] });
        cipher = new CipherNode();
        keymaster = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher, passphrase: 'pass' });
    });

    async function sign(name: string, challenge: string): Promise<string> {
        const keypair = await keymaster.fetchKeyPair(name);
        return cipher.signHash(cipher.hashMessage(challenge), keypair!.privateJwk);
    }

    it('accepts a valid signature over the challenge by the DID controller', async () => {
        const did = await keymaster.createId('Alice');
        const challenge = 'challenge-abc';
        const signature = await sign('Alice', challenge);

        const ok = await verifyChallengeSignature({ resolver: gatekeeper, cipher }, { did, challenge, signature });
        expect(ok).toBe(true);
    });

    it('rejects a signature over a different challenge', async () => {
        const did = await keymaster.createId('Alice');
        const signature = await sign('Alice', 'challenge-abc');

        const ok = await verifyChallengeSignature({ resolver: gatekeeper, cipher }, { did, challenge: 'different', signature });
        expect(ok).toBe(false);
    });

    it("rejects another identity's signature for the DID", async () => {
        const aliceDid = await keymaster.createId('Alice');
        await keymaster.createId('Mallory');
        const challenge = 'challenge-abc';
        const mallorySig = await sign('Mallory', challenge);

        const ok = await verifyChallengeSignature({ resolver: gatekeeper, cipher }, { did: aliceDid, challenge, signature: mallorySig });
        expect(ok).toBe(false);
    });
});
