import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import { UnknownIDError } from '@didcid/common/errors';
import HeliaClient from '@didcid/ipfs/helia';
import { bech32 } from 'bech32';

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
