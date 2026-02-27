import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import { UnknownIDError } from '@didcid/common/errors';
import HeliaClient from '@didcid/ipfs/helia';
import { bech32 } from 'bech32';
import { schnorr } from '@noble/curves/secp256k1';

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

describe('addNostr', () => {
    it('should derive and store nostr keys for current ID', async () => {
        await keymaster.createId('Bob');

        const nostr = await keymaster.addNostr();

        expect(nostr).toHaveProperty('npub');
        expect(nostr).toHaveProperty('pubkey');
        expect(nostr.npub.startsWith('npub1')).toBe(true);
        expect(nostr.pubkey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should store nostr keys in DID document data', async () => {
        const did = await keymaster.createId('Bob');

        const nostr = await keymaster.addNostr();

        const doc = await keymaster.resolveDID(did);
        const data = doc.didDocumentData as Record<string, unknown>;
        expect(data.nostr).toStrictEqual(nostr);
    });

    it('should derive nostr keys for a named ID', async () => {
        await keymaster.createId('Alice');
        await keymaster.createId('Bob');

        const nostr = await keymaster.addNostr('Alice');

        expect(nostr.npub.startsWith('npub1')).toBe(true);
        expect(nostr.pubkey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce consistent keys for the same ID', async () => {
        await keymaster.createId('Bob');

        const nostr1 = await keymaster.addNostr();
        const nostr2 = await keymaster.addNostr();

        expect(nostr1).toStrictEqual(nostr2);
    });

    it('should produce different keys for different IDs', async () => {
        await keymaster.createId('Alice');
        const nostrAlice = await keymaster.addNostr();

        await keymaster.createId('Bob');
        const nostrBob = await keymaster.addNostr();

        expect(nostrAlice.pubkey).not.toBe(nostrBob.pubkey);
        expect(nostrAlice.npub).not.toBe(nostrBob.npub);
    });

    it('should produce npub that decodes back to pubkey', async () => {
        await keymaster.createId('Bob');

        const nostr = await keymaster.addNostr();

        const decoded = bech32.decode(nostr.npub, 1000);
        expect(decoded.prefix).toBe('npub');
        const pubkeyBytes = Buffer.from(bech32.fromWords(decoded.words));
        expect(pubkeyBytes.toString('hex')).toBe(nostr.pubkey);
    });

    it('should throw for unknown ID name', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.addNostr('Unknown');
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(UnknownIDError.type);
        }
    });

    it('should throw when no ID exists', async () => {
        try {
            await keymaster.addNostr();
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error).toBeDefined();
        }
    });
});

describe('removeNostr', () => {
    it('should remove nostr keys from DID document data', async () => {
        const did = await keymaster.createId('Bob');
        await keymaster.addNostr();

        // Verify keys exist
        let doc = await keymaster.resolveDID(did);
        let data = doc.didDocumentData as Record<string, unknown>;
        expect(data.nostr).toBeDefined();

        // Remove
        const ok = await keymaster.removeNostr();
        expect(ok).toBe(true);

        // Verify keys removed
        doc = await keymaster.resolveDID(did);
        data = doc.didDocumentData as Record<string, unknown>;
        expect(data.nostr).toBeUndefined();
    });

    it('should remove nostr keys for a named ID', async () => {
        const aliceDid = await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        await keymaster.addNostr('Alice');

        const ok = await keymaster.removeNostr('Alice');
        expect(ok).toBe(true);

        const doc = await keymaster.resolveDID(aliceDid);
        const data = doc.didDocumentData as Record<string, unknown>;
        expect(data.nostr).toBeUndefined();
    });

    it('should succeed even if nostr keys were not added', async () => {
        await keymaster.createId('Bob');

        const ok = await keymaster.removeNostr();
        expect(ok).toBe(true);
    });

    it('should throw for unknown ID name', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.removeNostr('Unknown');
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(UnknownIDError.type);
        }
    });
});

describe('jwkToNostr', () => {
    it('should return valid nostr keys from a JWK', () => {
        const keypair = cipher.generateRandomJwk();
        const nostr = cipher.jwkToNostr(keypair.publicJwk);

        expect(nostr).toHaveProperty('npub');
        expect(nostr).toHaveProperty('pubkey');
        expect(nostr.npub.startsWith('npub1')).toBe(true);
        expect(nostr.pubkey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce deterministic output for same key', () => {
        const keypair = cipher.generateRandomJwk();
        const nostr1 = cipher.jwkToNostr(keypair.publicJwk);
        const nostr2 = cipher.jwkToNostr(keypair.publicJwk);

        expect(nostr1).toStrictEqual(nostr2);
    });

    it('should produce different output for different keys', () => {
        const keypair1 = cipher.generateRandomJwk();
        const keypair2 = cipher.generateRandomJwk();
        const nostr1 = cipher.jwkToNostr(keypair1.publicJwk);
        const nostr2 = cipher.jwkToNostr(keypair2.publicJwk);

        expect(nostr1.pubkey).not.toBe(nostr2.pubkey);
        expect(nostr1.npub).not.toBe(nostr2.npub);
    });

    it('should produce npub that round-trips back to pubkey', () => {
        const keypair = cipher.generateRandomJwk();
        const nostr = cipher.jwkToNostr(keypair.publicJwk);

        const decoded = bech32.decode(nostr.npub, 1000);
        expect(decoded.prefix).toBe('npub');
        const pubkeyHex = Buffer.from(bech32.fromWords(decoded.words)).toString('hex');
        expect(pubkeyHex).toBe(nostr.pubkey);
    });

    it('should produce a 32-byte (64 hex char) pubkey', () => {
        const keypair = cipher.generateRandomJwk();
        const nostr = cipher.jwkToNostr(keypair.publicJwk);

        expect(nostr.pubkey.length).toBe(64);
    });
});

describe('signSchnorr', () => {
    it('should produce a valid Schnorr signature', () => {
        const keypair = cipher.generateRandomJwk();
        const msgHash = cipher.hashMessage('test message');

        const sig = cipher.signSchnorr(msgHash, keypair.privateJwk);

        expect(sig).toMatch(/^[0-9a-f]{128}$/);
    });

    it('should produce a signature verifiable with @noble/curves', () => {
        const keypair = cipher.generateRandomJwk();
        const nostr = cipher.jwkToNostr(keypair.publicJwk);
        const msgHash = cipher.hashMessage('test message');

        const sig = cipher.signSchnorr(msgHash, keypair.privateJwk);

        const sigBytes = Uint8Array.from(Buffer.from(sig, 'hex'));
        const msgBytes = Uint8Array.from(Buffer.from(msgHash, 'hex'));
        const pubBytes = Uint8Array.from(Buffer.from(nostr.pubkey, 'hex'));
        const valid = schnorr.verify(sigBytes, msgBytes, pubBytes);
        expect(valid).toBe(true);
    });

    it('should produce different signatures for different messages', () => {
        const keypair = cipher.generateRandomJwk();
        const hash1 = cipher.hashMessage('message one');
        const hash2 = cipher.hashMessage('message two');

        const sig1 = cipher.signSchnorr(hash1, keypair.privateJwk);
        const sig2 = cipher.signSchnorr(hash2, keypair.privateJwk);

        expect(sig1).not.toBe(sig2);
    });
});

describe('jwkToNsec', () => {
    it('should return a valid nsec string', () => {
        const keypair = cipher.generateRandomJwk();

        const nsec = cipher.jwkToNsec(keypair.privateJwk);

        expect(nsec.startsWith('nsec1')).toBe(true);
    });

    it('should produce deterministic output for the same key', () => {
        const keypair = cipher.generateRandomJwk();

        const nsec1 = cipher.jwkToNsec(keypair.privateJwk);
        const nsec2 = cipher.jwkToNsec(keypair.privateJwk);

        expect(nsec1).toBe(nsec2);
    });

    it('should produce different output for different keys', () => {
        const keypair1 = cipher.generateRandomJwk();
        const keypair2 = cipher.generateRandomJwk();

        const nsec1 = cipher.jwkToNsec(keypair1.privateJwk);
        const nsec2 = cipher.jwkToNsec(keypair2.privateJwk);

        expect(nsec1).not.toBe(nsec2);
    });

    it('should round-trip back to private key bytes', () => {
        const keypair = cipher.generateRandomJwk();

        const nsec = cipher.jwkToNsec(keypair.privateJwk);

        const decoded = bech32.decode(nsec, 1000);
        expect(decoded.prefix).toBe('nsec');
        const privKeyBytes = Buffer.from(bech32.fromWords(decoded.words));
        expect(privKeyBytes.length).toBe(32);
    });

    it('should produce nsec that derives the same nostr pubkey', () => {
        const keypair = cipher.generateRandomJwk();
        const nostr = cipher.jwkToNostr(keypair.publicJwk);

        const nsec = cipher.jwkToNsec(keypair.privateJwk);

        // Decode the nsec back to raw private key bytes
        const decoded = bech32.decode(nsec, 1000);
        const privKeyBytes = Buffer.from(bech32.fromWords(decoded.words));

        // Derive a new keypair from those bytes and check it matches
        const derivedKeypair = cipher.generateJwk(privKeyBytes);
        const derivedNostr = cipher.jwkToNostr(derivedKeypair.publicJwk);
        expect(derivedNostr.pubkey).toBe(nostr.pubkey);
    });
});

describe('exportNsec', () => {
    it('should return a valid nsec for the current ID', async () => {
        await keymaster.createId('Bob');
        await keymaster.addNostr();

        const nsec = await keymaster.exportNsec();

        expect(nsec.startsWith('nsec1')).toBe(true);
    });

    it('should return a valid nsec for a named ID', async () => {
        await keymaster.createId('Alice');
        await keymaster.createId('Bob');
        await keymaster.addNostr('Alice');

        const nsec = await keymaster.exportNsec('Alice');

        expect(nsec.startsWith('nsec1')).toBe(true);
    });

    it('should produce consistent nsec for the same ID', async () => {
        await keymaster.createId('Bob');

        const nsec1 = await keymaster.exportNsec();
        const nsec2 = await keymaster.exportNsec();

        expect(nsec1).toBe(nsec2);
    });

    it('should produce different nsec for different IDs', async () => {
        await keymaster.createId('Alice');
        const nsecAlice = await keymaster.exportNsec();

        await keymaster.createId('Bob');
        const nsecBob = await keymaster.exportNsec();

        expect(nsecAlice).not.toBe(nsecBob);
    });

    it('should work without addNostr being called first', async () => {
        await keymaster.createId('Bob');

        const nsec = await keymaster.exportNsec();

        expect(nsec.startsWith('nsec1')).toBe(true);
    });

    it('should throw for unknown ID name', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.exportNsec('Unknown');
            throw new Error('Expected exception');
        }
        catch (error: any) {
            expect(error.type).toBe(UnknownIDError.type);
        }
    });
});

describe('signNostrEvent', () => {
    it('should sign a Nostr event with id, pubkey, and sig', async () => {
        await keymaster.createId('Bob');
        await keymaster.addNostr();

        const event = {
            created_at: Math.floor(Date.now() / 1000),
            kind: 1,
            tags: [],
            content: 'Hello Nostr!',
        };

        const signed = await keymaster.signNostrEvent(event);

        expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
        expect(signed.pubkey).toMatch(/^[0-9a-f]{64}$/);
        expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
        expect(signed.content).toBe('Hello Nostr!');
        expect(signed.kind).toBe(1);
    });

    it('should set pubkey matching the nostr public key', async () => {
        await keymaster.createId('Bob');
        const nostr = await keymaster.addNostr();

        const event = {
            created_at: Math.floor(Date.now() / 1000),
            kind: 1,
            tags: [],
            content: 'test',
        };

        const signed = await keymaster.signNostrEvent(event);

        expect(signed.pubkey).toBe(nostr.pubkey);
    });

    it('should produce a verifiable Schnorr signature', async () => {
        await keymaster.createId('Bob');
        await keymaster.addNostr();

        const event = {
            created_at: Math.floor(Date.now() / 1000),
            kind: 1,
            tags: [],
            content: 'verify me',
        };

        const signed = await keymaster.signNostrEvent(event);

        const sigBytes = Uint8Array.from(Buffer.from(signed.sig!, 'hex'));
        const idBytes = Uint8Array.from(Buffer.from(signed.id!, 'hex'));
        const pubBytes = Uint8Array.from(Buffer.from(signed.pubkey!, 'hex'));
        const valid = schnorr.verify(sigBytes, idBytes, pubBytes);
        expect(valid).toBe(true);
    });

    it('should compute id as SHA-256 of NIP-01 serialization', async () => {
        await keymaster.createId('Bob');
        await keymaster.addNostr();

        const event = {
            created_at: 1234567890,
            kind: 1,
            tags: [['p', 'abc123']],
            content: 'NIP-01 test',
        };

        const signed = await keymaster.signNostrEvent(event);

        const serialized = JSON.stringify([
            0,
            signed.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content,
        ]);
        const expectedId = cipher.hashMessage(serialized);

        expect(signed.id).toBe(expectedId);
    });

    it('should preserve all original event fields', async () => {
        await keymaster.createId('Bob');

        const event = {
            created_at: 1700000000,
            kind: 0,
            tags: [['e', 'abc'], ['p', 'def']],
            content: '{"name":"Bob"}',
        };

        const signed = await keymaster.signNostrEvent(event);

        expect(signed.created_at).toBe(event.created_at);
        expect(signed.kind).toBe(event.kind);
        expect(signed.tags).toStrictEqual(event.tags);
        expect(signed.content).toBe(event.content);
    });

    it('should produce different signatures for different events', async () => {
        await keymaster.createId('Bob');

        const event1 = {
            created_at: Math.floor(Date.now() / 1000),
            kind: 1,
            tags: [],
            content: 'message one',
        };

        const event2 = {
            created_at: Math.floor(Date.now() / 1000),
            kind: 1,
            tags: [],
            content: 'message two',
        };

        const signed1 = await keymaster.signNostrEvent(event1);
        const signed2 = await keymaster.signNostrEvent(event2);

        expect(signed1.sig).not.toBe(signed2.sig);
        expect(signed1.id).not.toBe(signed2.id);
    });
});
