import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import HeliaClient from '@didcid/ipfs/helia';
import { jest } from '@jest/globals';

// The main suites drive these methods along their happy paths, which leaves the
// validation guards and "already in the desired state" branches untaken. These
// cover that side — the rejections and short-circuits.

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

beforeEach(async () => {
    const db = new DbJsonMemory('test');
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm'] });
    wallet = new WalletJsonMemory();
    cipher = new CipherNode();
    keymaster = new Keymaster({ createWalletIfMissing: true, gatekeeper, wallet, cipher, passphrase: 'passphrase' });
    await keymaster.newWallet();
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('address domain validation', () => {
    // normalizeAddressDomain guards every address method that takes a domain.
    const invalid = [
        ['empty string', ''],
        ['whitespace only', '   '],
        ['not a string', 12345 as unknown as string],
        ['null', null as unknown as string],
        ['undefined', undefined as unknown as string],
        ['scheme with no host', 'https://'],
        ['bare scheme', '://'],
    ] as const;

    it.each(invalid)('rejects a %s domain on importAddress', async (_label, domain) => {
        await expect(keymaster.importAddress(domain)).rejects.toThrow(/domain/i);
    });

    it('accepts a domain with or without a scheme, normalising to the host', async () => {
        // An ID must exist first: importAddress calls fetchIdInfo before fetch, so
        // without one it would throw early and the fetch assertions below would
        // pass vacuously against an empty call list.
        await keymaster.createId('alice');
        const fetchSpy = jest.spyOn(global, 'fetch' as any)
            .mockResolvedValue({ ok: false, status: 500, text: async () => 'nope' } as any);

        await expect(keymaster.importAddress('EXAMPLE.test')).rejects.toThrow();
        await expect(keymaster.importAddress('https://EXAMPLE.test')).rejects.toThrow();

        expect(fetchSpy.mock.calls.length).toBe(2);
        for (const call of fetchSpy.mock.calls) {
            // Uppercase input is lowercased, and the scheme is stripped to the host.
            expect(String(call[0])).toBe('https://example.test/.well-known/names');
        }
    });

    it('keeps a non-default port as part of the host', async () => {
        await keymaster.createId('alice');
        const fetchSpy = jest.spyOn(global, 'fetch' as any)
            .mockResolvedValue({ ok: false, status: 500, text: async () => 'nope' } as any);

        await expect(keymaster.importAddress('example.test:8443')).rejects.toThrow();

        expect(String(fetchSpy.mock.calls[0][0])).toContain('example.test:8443');
    });
});

describe('address removal guards', () => {
    it('rejects removing an address that was never stored', async () => {
        await keymaster.createId('alice');

        await expect(keymaster.removeAddress('bob@example.test')).rejects.toThrow(/address/i);
    });

    it('rejects removing an address whose name does not match the stored one', async () => {
        await keymaster.createId('alice');
        // Store an address for the domain under a different local name.
        const stored: any = await keymaster.loadWallet();
        stored.ids[stored.current!].addresses = {
            'example.test': { name: 'someone-else', added: new Date().toISOString() },
        };
        await keymaster.saveWallet(stored, true);

        await expect(keymaster.removeAddress('alice@example.test')).rejects.toThrow(/address/i);
    });
});

describe('checkAddress network failure', () => {
    it('reports an unreachable domain rather than throwing', async () => {
        jest.spyOn(global, 'fetch' as any).mockRejectedValue(new Error('ECONNREFUSED'));

        const result = await keymaster.checkAddress('alice@example.test');

        expect(result).toMatchObject({
            address: 'alice@example.test',
            status: 'unreachable',
            available: false,
            did: null,
        });
    });
});

describe('listAliases', () => {
    it('returns only aliases by default and merges IDs when asked', async () => {
        const aliceDid = await keymaster.createId('alice');
        await keymaster.addAlias('friend', aliceDid);

        const aliasesOnly = await keymaster.listAliases();
        expect(aliasesOnly).toHaveProperty('friend', aliceDid);
        expect(aliasesOnly).not.toHaveProperty('alice');

        const withIds = await keymaster.listAliases({ includeIDs: true });
        expect(withIds).toHaveProperty('friend', aliceDid);
        expect(withIds).toHaveProperty('alice', aliceDid);
    });

    it('returns an empty map for a wallet with neither aliases nor IDs', async () => {
        await expect(keymaster.listAliases()).resolves.toEqual({});
        await expect(keymaster.listAliases({ includeIDs: true })).resolves.toEqual({});
    });
});

describe('verifyResponse guards', () => {
    beforeEach(async () => {
        await keymaster.createId('alice');
    });

    it('rejects a DID that does not resolve to a response document', async () => {
        // An asset that exists but carries no challenge-response wrapper.
        const assetDid = await keymaster.createAsset({ notAResponse: true });

        // decryptJSON rejects it before the wrapper shape is even examined.
        await expect(keymaster.verifyResponse(assetDid)).rejects.toThrow();
    });

    it('rejects a wrapper whose response references an unknown challenge', async () => {
        const bogusChallenge = 'did:cid:bagaaieranonexistentchallenge';
        const responseDid = await keymaster.encryptJSON(
            { response: { challenge: bogusChallenge, credentials: [] } },
            (await keymaster.fetchIdInfo()).did,
        );

        await expect(keymaster.verifyResponse(responseDid)).rejects.toThrow();
    });

    it('rejects an asset that resolves but holds no challenge', async () => {
        const notAChallenge = await keymaster.createAsset({ something: 'else' });
        const responseDid = await keymaster.encryptJSON(
            { response: { challenge: notAChallenge, credentials: [] } },
            (await keymaster.fetchIdInfo()).did,
        );

        await expect(keymaster.verifyResponse(responseDid)).rejects.toThrow(/challenge/i);
    });
});

describe('encrypted wallet export', () => {
    it('exports a wallet whose seed carries an encrypted mnemonic', async () => {
        await keymaster.createId('alice');

        const exported: any = await keymaster.exportEncryptedWallet();

        expect(exported.seed?.mnemonicEnc).toBeDefined();
    });

    // hdkeyCacheKey's `enc ? ... : undefined` false branch is not reachable through
    // the public API: a wallet whose seed lacks mnemonicEnc fails isWalletFile on
    // load, so decryptWallet rejects it before any cache key is derived. Left
    // uncovered rather than reached by writing an invalid wallet straight to disk.
});

// --- DIDComm guards ---------------------------------------------------------
// The didcomm suite exercises the successful pack/unpack/send round trips. These
// cover the rejection paths: missing keys, wrong envelope shapes, absent
// endpoints, and unsuccessful gateway responses.

describe('packDidComm guards', () => {
    beforeEach(async () => {
        await keymaster.createId('alice');
        await keymaster.publishDidComm();
    });

    it('requires at least one recipient', async () => {
        await expect(keymaster.packDidComm({ hello: 'world' }, []))
            .rejects.toThrow(/at least one recipient/i);
    });

    it('rejects a recipient with no key agreement key', async () => {
        // A plain asset has no keyAgreement verification method.
        const assetDid = await keymaster.createAsset({ not: 'an agent' });

        await expect(keymaster.packDidComm({ hello: 'world' }, assetDid)).rejects.toThrow();
    });

    it('accepts a single recipient as well as an array', async () => {
        const selfDid = (await keymaster.fetchIdInfo()).did;

        const single = await keymaster.packDidComm({ hello: 'world' }, selfDid);
        const asArray = await keymaster.packDidComm({ hello: 'world' }, [selfDid]);

        for (const packed of [single, asArray]) {
            const { message } = await keymaster.unpackDidComm(packed);
            expect(message).toMatchObject({ hello: 'world' });
        }
    });

    it('strips a caller-supplied from header on an anoncrypt envelope', async () => {
        const selfDid = (await keymaster.fetchIdInfo()).did;

        const packed = await keymaster.packDidComm(
            { hello: 'world', from: 'did:cid:impersonated' },
            selfDid,
            { anoncrypt: true },
        );

        const { message, metadata } = await keymaster.unpackDidComm(packed);
        expect(message.from).toBeUndefined();
        expect(metadata.authenticated).toBe(false);
    });

    it('signs with the identity key when asked', async () => {
        const selfDid = (await keymaster.fetchIdInfo()).did;

        const packed = await keymaster.packDidComm({ hello: 'world' }, selfDid, { sign: true });

        const { metadata } = await keymaster.unpackDidComm(packed);
        expect(metadata.nonRepudiation).toBe(true);
        expect(metadata.signer).toContain(selfDid);
    });
});

describe('unpackDidComm guards', () => {
    beforeEach(async () => {
        await keymaster.createId('alice');
        await keymaster.publishDidComm();
    });

    it('rejects an envelope that is not DIDComm encrypted', async () => {
        await expect(keymaster.unpackDidComm('not-an-envelope')).rejects.toThrow();
        await expect(keymaster.unpackDidComm(JSON.stringify({ hello: 'world' })))
            .rejects.toThrow(/not a didcomm encrypted message/i);
    });

    it('rejects an envelope addressed to a different identity', async () => {
        const aliceDid = (await keymaster.fetchIdInfo()).did;
        const packed = await keymaster.packDidComm({ hello: 'world' }, aliceDid);

        // Switch to a second identity that is not a recipient.
        await keymaster.createId('bob');
        await keymaster.publishDidComm();

        await expect(keymaster.unpackDidComm(packed))
            .rejects.toThrow(/not addressed to this identity/i);
    });
});

describe('sendDidComm and receiveDidComm guards', () => {
    beforeEach(async () => {
        await keymaster.createId('alice');
        await keymaster.publishDidComm();
    });

    it('rejects a recipient with no DIDCommMessaging endpoint', async () => {
        // A second identity that published keys but no service endpoint.
        const aliceDid = (await keymaster.fetchIdInfo()).did;
        jest.spyOn(global, 'fetch' as any).mockResolvedValue(
            new Response(JSON.stringify({ didcomm: true }), { status: 200 }) as any,
        );

        // The recipient resolves, but resolveDidCommEndpoint finds no service.
        await expect(keymaster.sendDidComm({ hello: 'world' }, aliceDid)).rejects.toThrow();
    });

    it('surfaces a gateway delivery failure', async () => {
        const aliceDid = (await keymaster.fetchIdInfo()).did;
        await keymaster.publishDidComm('https://relay.test/didcomm');

        jest.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
            const href = String(url);
            if (href.includes('/capabilities')) {
                return new Response(JSON.stringify({ didcomm: true }), { status: 200 }) as any;
            }
            if (href.includes('/challenge')) {
                return new Response(JSON.stringify({ challenge: 'abc' }), { status: 200 }) as any;
            }
            return new Response('upstream down', { status: 502 }) as any;
        });

        await expect(keymaster.sendDidComm({ hello: 'world' }, aliceDid)).rejects.toThrow();
    });

    it('surfaces a mailbox fetch failure on receive', async () => {
        jest.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
            const href = String(url);
            if (href.includes('/challenge')) {
                return new Response(JSON.stringify({ challenge: 'abc' }), { status: 200 }) as any;
            }
            return new Response('nope', { status: 500 }) as any;
        });

        await expect(keymaster.receiveDidComm()).rejects.toThrow();
    });
});

describe('publishDidComm and unpublishDidComm', () => {
    beforeEach(async () => {
        await keymaster.createId('alice');
    });

    it('is idempotent when nothing has been published', async () => {
        // unpublish with no key agreement key or service present must not throw.
        await expect(keymaster.unpublishDidComm()).resolves.toBeDefined();
    });

    it('removes the key agreement key and service it published', async () => {
        await keymaster.publishDidComm('https://relay.test/didcomm');

        const did = (await keymaster.fetchIdInfo()).did;

        // The key-agreement key is a JsonWebKey2020 identified by #key-agreement-1,
        // and the service by #didcomm — not by a type naming the curve.
        const before = await keymaster.resolveDID(did);
        expect(before.didDocument?.keyAgreement).toContain(`${did}#key-agreement-1`);
        expect(before.didDocument?.service?.some(s => s.id === `${did}#didcomm`)).toBe(true);

        await keymaster.unpublishDidComm();

        const after = await keymaster.resolveDID(did);
        expect(after.didDocument?.verificationMethod?.some(vm => vm.id === `${did}#key-agreement-1`))
            .not.toBe(true);
        expect(after.didDocument?.service?.some(s => s.id === `${did}#didcomm`)).not.toBe(true);
    });
});
