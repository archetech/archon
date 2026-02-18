import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import { VerifiableCredential } from '@didcid/keymaster/types';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import { copyJSON } from '@didcid/common/utils';
import { InvalidDIDError, ExpectedExceptionError, UnknownIDError } from '@didcid/common/errors';
import HeliaClient from '@didcid/ipfs/helia';
import { TestHelper, mockJson, mockSchema } from './helper.ts';

let ipfs: HeliaClient;
let gatekeeper: Gatekeeper;
let wallet: WalletJsonMemory;
let cipher: CipherNode;
let keymaster: Keymaster;
let helper: TestHelper;

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
    helper = new TestHelper(keymaster);
});

describe('listCredentials', () => {
    it('return list of held credentials', async () => {
        const expectedCredentials = await helper.setupCredentials();
        const credentials = await keymaster.listCredentials('Carol');

        expect(credentials).toStrictEqual(expectedCredentials);
    });

    it('return empty list if specified ID holds no credentials', async () => {
        await helper.setupCredentials();
        const credentials = await keymaster.listCredentials('Bob');

        expect(credentials).toStrictEqual([]);
    });

    it('raises an exception if invalid ID specified', async () => {
        try {
            await keymaster.listCredentials('mock');
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.type).toBe(UnknownIDError.type);
        }
    });
});

describe('getCredential', () => {
    it('returns decrypted credential for valid DID', async () => {
        const credentials = await helper.setupCredentials();

        for (const did of credentials) {
            const credential = (await keymaster.getCredential(did))!;
            expect(credential.type[0]).toBe('VerifiableCredential');
        }
    });

    it('raises an exception if invalid DID specified', async () => {
        try {
            await keymaster.getCredential('mock');
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.type).toBe(UnknownIDError.type);
        }
    });

    it('raises an exception if DID specified that is not a credential', async () => {
        try {
            const agentDID = await keymaster.createId('Rando');
            await keymaster.getCredential(agentDID);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            // eslint-disable-next-line
            expect(error.message).toBe('Invalid parameter: did not encrypted');
        }
    });

    it('return null if not a verifiable credential', async () => {
        const bob = await keymaster.createId('Bob');
        const did = await keymaster.encryptJSON(mockJson, bob);
        const res = await keymaster.getCredential(did);

        expect(res).toBeNull();
    });
});

describe('removeCredential', () => {
    it('removes specified credential from held credentials list', async () => {
        const credentials = await helper.setupCredentials();

        const ok1 = await keymaster.removeCredential(credentials[1]);
        const ok2 = await keymaster.removeCredential(credentials[3]);

        expect(ok1).toBe(true);
        expect(ok2).toBe(true);

        const held = await keymaster.listCredentials('Carol');

        expect(held).toStrictEqual([credentials[0], credentials[2]]);
    });

    it('returns false if DID not previously held', async () => {
        const agentDID = await keymaster.createId('Rando');
        const ok = await keymaster.removeCredential(agentDID);

        expect(ok).toBe(false);
    });

    it('raises an exception if no DID specified', async () => {
        try {
            // @ts-expect-error Testing invalid usage, missing arg
            await keymaster.removeCredential();
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe(InvalidDIDError.type);
        }
    });

    it('raises an exception if invalid DID specified', async () => {
        try {
            await keymaster.removeCredential('mock');
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.type).toBe(UnknownIDError.type);
        }
    });
});

describe('publishCredential', () => {
    it('should reveal a valid credential', async () => {
        const bob = await keymaster.createId('Bob');
        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(bob, { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        await keymaster.publishCredential(did, { reveal: true });

        const doc = await keymaster.resolveDID(bob);
        const vc = await keymaster.decryptJSON(did);
        const manifest = (doc.didDocumentData as { manifest: Record<string, VerifiableCredential> }).manifest;

        expect(manifest[did]).toStrictEqual(vc);
    });

    it('should publish a valid credential without revealing', async () => {
        const bob = await keymaster.createId('Bob');
        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(bob, { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        await keymaster.publishCredential(did);

        const doc = await keymaster.resolveDID(bob);
        const vc = await keymaster.decryptJSON(did) as VerifiableCredential;
        const manifest = (doc.didDocumentData as { manifest: Record<string, VerifiableCredential> }).manifest;

        // When not revealing, only the subject id is kept (claims removed)
        vc.credentialSubject = { id: vc.credentialSubject!.id };

        expect(manifest[did]).toStrictEqual(vc);
    });

    it('should throw when did is not a verifiable credential', async () => {
        const bob = await keymaster.createId('Bob');
        const did = await keymaster.encryptJSON(mockJson, bob);

        try {
            await keymaster.publishCredential(did);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toContain('did is not a credential');
        }
    });
});

describe('unpublishCredential', () => {
    it('should unpublish a published credential', async () => {
        const bob = await keymaster.createId('Bob');
        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(bob, { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);
        await keymaster.publishCredential(did, { reveal: true });

        await keymaster.unpublishCredential(did);

        const doc = await keymaster.resolveDID(bob);
        const manifest = (doc.didDocumentData as { manifest: Record<string, VerifiableCredential> }).manifest;

        expect(manifest).toStrictEqual({});
    });

    it('should throw an exception when no current ID', async () => {
        try {
            await keymaster.unpublishCredential('mock');
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Keymaster: No current ID');
        }
    });

    it('should throw an exception when credential invalid', async () => {
        await keymaster.createId('Bob');

        try {
            await keymaster.unpublishCredential('did:cid:mock49');
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: did');
        }
    });

    it('should throw an exception when credential not found', async () => {
        const bob = await keymaster.createId('Bob');
        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(bob, { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        try {
            await keymaster.unpublishCredential(did);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: did');
        }
    });
});

describe('isVerifiableCredential', () => {
    it('should return false for non-object or null', async () => {
        // @ts-expect-error Testing invalid usage, calling private func
        const res1 = keymaster.isVerifiableCredential(null);

        // @ts-expect-error Testing invalid usage, calling private func
        const res2 = keymaster.isVerifiableCredential("");

        expect(res1).toBe(false);
        expect(res2).toBe(false);
    })
})

describe('bindCredential', () => {
    it('should create a bound credential', async () => {
        const userDid = await keymaster.createId('Bob');
        const credentialDid = await keymaster.createSchema(mockSchema);

        const vc = await keymaster.bindCredential(userDid, { schema: credentialDid });

        expect(vc.issuer).toBe(userDid);
        expect(vc.credentialSubject!.id).toBe(userDid);
        expect(vc.credentialSubject!.email).toEqual(expect.any(String));
    });

    it('should create a bound credential with provided default', async () => {
        const userDid = await keymaster.createId('Bob');
        const credentialDid = await keymaster.createSchema(mockSchema);

        const claims = { email: 'bob@mock.com' };
        const vc = await keymaster.bindCredential(userDid, { schema: credentialDid, claims });

        expect(vc.issuer).toBe(userDid);
        expect(vc.credentialSubject!.id).toBe(userDid);
        expect(vc.credentialSubject!.email).toEqual(claims.email);
    });

    it('should create a bound credential for a different user', async () => {
        const alice = await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');
        const credentialDid = await keymaster.createSchema(mockSchema);

        await keymaster.setCurrentId('Alice')
        const vc = await keymaster.bindCredential(bob, { schema: credentialDid });

        expect(vc.issuer).toBe(alice);
        expect(vc.credentialSubject!.id).toBe(bob);
        expect(vc.credentialSubject!.email).toEqual(expect.any(String));
    });

    it('should override credential types from schema $credentialType', async () => {
        const issuer = await keymaster.createId('ChessClub');
        const member = await keymaster.createId('Member');

        const membershipSchema = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "$credentialType": ["VerifiableCredential", "DTGCredential", "MembershipCredential"],
            "type": "object",
            "properties": {
                "memberSince": { "type": "string" }
            },
            "required": ["memberSince"]
        };

        await keymaster.setCurrentId('ChessClub');
        const schemaDid = await keymaster.createSchema(membershipSchema);
        const vc = await keymaster.bindCredential(member, { schema: schemaDid });

        expect(vc.type).toEqual(['VerifiableCredential', 'DTGCredential', 'MembershipCredential']);
        expect(vc.credentialSchema).toBeDefined();
        expect(vc.credentialSchema!.id).toBe(schemaDid);
        expect(vc.issuer).toBe(issuer);
    });

    it('should override credential context from schema $credentialContext', async () => {
        const issuer = await keymaster.createId('ContextOrg');
        const member = await keymaster.createId('ContextMember');

        const schemaWithContext = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "$credentialContext": [
                "https://example.org/credentials/v3",
                "https://example.org/credentials/membership/v1"
            ],
            "type": "object",
            "properties": {
                "role": { "type": "string" }
            }
        };

        await keymaster.setCurrentId('ContextOrg');
        const schemaDid = await keymaster.createSchema(schemaWithContext);
        const vc = await keymaster.bindCredential(member, { schema: schemaDid });

        expect(vc['@context']).toEqual(schemaWithContext.$credentialContext);
        expect(vc.credentialSchema).toBeDefined();
        expect(vc.credentialSchema!.id).toBe(schemaDid);
        expect(vc.issuer).toBe(issuer);
    });

    it('should use default types when schema has no $credentialType', async () => {
        await keymaster.createId('Issuer');
        const subject = await keymaster.createId('Subject');

        const schemaWithoutTypes = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "name": { "type": "string" }
            }
        };

        await keymaster.setCurrentId('Issuer');
        const schemaDid = await keymaster.createSchema(schemaWithoutTypes);
        const vc = await keymaster.bindCredential(subject, { schema: schemaDid });

        expect(vc.type).toEqual(['VerifiableCredential']);
    });
});

describe('issueCredential', () => {
    it('should issue a bound credential when user is issuer', async () => {
        const subject = await keymaster.createId('Bob');
        const schema = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(subject, { schema });

        const did = await keymaster.issueCredential(boundCredential);

        const vc = await keymaster.decryptJSON(did) as VerifiableCredential;
        expect(vc.issuer).toBe(subject);
        expect(vc.credentialSubject!.id).toBe(subject);
        expect(vc.credentialSubject!.email).toEqual(expect.any(String));

        const isValid = await keymaster.verifyProof(vc);
        expect(isValid).toBe(true);

        const wallet = await keymaster.loadWallet();
        expect(wallet.ids['Bob'].owned!.includes(did)).toEqual(true);
    });

    it('should bind and issue a credential', async () => {
        const subject = await keymaster.createId('Bob');
        const schema = await keymaster.createSchema(mockSchema);
        const unboundCredential = await keymaster.createTemplate(schema);

        const now = new Date();
        const validFrom = now.toISOString();
        now.setFullYear(now.getFullYear() + 1);
        const validUntil = now.toISOString();

        const did = await keymaster.issueCredential(unboundCredential, { subject, schema, validFrom, validUntil });

        const vc = await keymaster.decryptJSON(did) as VerifiableCredential;
        expect(vc.issuer).toBe(subject);
        expect(vc.credentialSubject!.id).toBe(subject);
        expect(vc.credentialSubject!.email).toEqual(expect.any(String));
        expect(vc.validFrom).toBe(validFrom);
        expect(vc.validUntil).toBe(validUntil);

        const isValid = await keymaster.verifyProof(vc);
        expect(isValid).toBe(true);
    });

    it('should throw an exception if user is not issuer', async () => {
        await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');

        await keymaster.setCurrentId('Alice');

        const schema = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(bob, { schema });

        await keymaster.setCurrentId('Bob');

        try {
            await keymaster.issueCredential(boundCredential);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: credential.issuer');
        }
    });

    it('should throw an exception on unbound credential without binding options', async () => {
        await keymaster.createId('Alice');

        const schema = await keymaster.createSchema(mockSchema);
        const unboundCredential = await keymaster.createTemplate(schema);

        try {
            await keymaster.issueCredential(unboundCredential);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: credential.issuer');
        }
    });
});

describe('sendCredential', () => {
    it('should create a notice for the credential', async () => {
        const subject = await keymaster.createId('Bob');
        const schema = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(subject, { schema });
        const credentialDID = await keymaster.issueCredential(boundCredential);
        const noticeDID = await keymaster.sendCredential(credentialDID);

        expect(noticeDID).toBeDefined();
        const { notice } = await keymaster.resolveAsset(noticeDID!);

        expect(notice).toBeDefined();
        expect(notice.to).toStrictEqual([subject]);
        expect(notice.dids).toStrictEqual([credentialDID]);
    });

    it('should throw an exception on invalid credential', async () => {
        const bob = await keymaster.createId('Bob');

        try {
            await keymaster.sendCredential(bob);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: did not encrypted');
        }
    });
});

describe('listIssued', () => {
    it('should return empty list for new ID', async () => {
        await keymaster.createId('Bob');
        const issued = await keymaster.listIssued();

        expect(issued).toStrictEqual([]);
    });

    it('should return list containing one issued credential', async () => {
        const userDid = await keymaster.createId('Bob');
        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(userDid, { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        const issued = await keymaster.listIssued();

        expect(issued).toStrictEqual([did]);
    });
});

describe('updateCredential', () => {
    it('should update a valid verifiable credential', async () => {
        const userDid = await keymaster.createId('Bob');
        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(userDid, { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);
        const vc = (await keymaster.getCredential(did))!;

        const validUntilDate = new Date();
        validUntilDate.setHours(validUntilDate.getHours() + 24);
        vc.validUntil = validUntilDate.toISOString();
        const ok = await keymaster.updateCredential(did, vc);
        expect(ok).toBe(true);

        const updated = (await keymaster.getCredential(did))!;
        expect(updated.validUntil).toBe(vc.validUntil);

        const doc = await keymaster.resolveDID(did);
        expect(doc.didDocumentMetadata!.versionSequence).toBe("2");
    });

    it('should throw exception on invalid parameters', async () => {
        const bob = await keymaster.createId('Bob');
        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(bob, { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);
        const vc = (await keymaster.getCredential(did))!;

        try {
            // @ts-expect-error Testing invalid usage, missing args
            await keymaster.updateCredential();
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe(InvalidDIDError.type);
        }

        try {
            // Pass agent DID instead of credential DID
            await keymaster.updateCredential(bob, vc);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {            // eslint-disable-next-line
            expect(error.message).toBe('Invalid parameter: did not encrypted');
        }

        try {
            // Pass cipher DID instead of credential DID
            const cipherDID = await keymaster.encryptMessage('mock', bob);
            await keymaster.updateCredential(cipherDID, vc);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: did not encrypted JSON');
        }

        try {            // Pass cipher DID instead of credential DID
            const cipherDID = await keymaster.encryptJSON({ bob }, bob);
            await keymaster.updateCredential(cipherDID, vc);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: did is not a credential');
        }

        try {
            // @ts-expect-error Testing invalid usage, missing args
            await keymaster.updateCredential(did);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {            // eslint-disable-next-line
            expect(error.message).toBe('Invalid parameter: credential');
        }

        try {
            // @ts-expect-error Testing invalid usage, invalid arg
            await keymaster.updateCredential(did, {});
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: credential');
        }

        try {
            const vc2 = copyJSON(vc);
            delete vc2.credentialSubject;
            await keymaster.updateCredential(did, vc2);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: credential');
        }

        try {
            const vc2 = copyJSON(vc);
            delete vc2.credentialSubject;
            await keymaster.updateCredential(did, vc2);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: credential');
        }
    });
});

describe('revokeCredential', () => {
    it('should revoke a valid verifiable credential', async () => {
        const userDid = await keymaster.createId('Bob');
        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(userDid, { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        const ok = await keymaster.revokeCredential(did);
        expect(ok).toBe(true);

        const revoked = await keymaster.resolveDID(did);
        expect(revoked.didDocument).toStrictEqual({ id: did });
        expect(revoked.didDocumentMetadata!.deactivated).toBe(true);
    });

    it('should throw exception if verifiable credential is already revoked', async () => {
        const userDid = await keymaster.createId('Bob');
        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(userDid, { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        const ok1 = await keymaster.revokeCredential(did);
        expect(ok1).toBe(true);

        const revoked = await keymaster.resolveDID(did);
        expect(revoked.didDocument).toStrictEqual({ id: did });
        expect(revoked.didDocumentMetadata!.deactivated).toBe(true);

        try {
            await keymaster.revokeCredential(did);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid operation: DID deactivated');
        }
    });

    it('should throw exception if user does not control verifiable credential', async () => {
        await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');

        await keymaster.setCurrentId('Alice');

        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(bob, { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        await keymaster.setCurrentId('Bob');
        await keymaster.removeId('Alice');

        try {
            await keymaster.revokeCredential(did);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.type).toBe(UnknownIDError.type);
        }

    });
});

describe('acceptCredential', () => {
    it('should add a valid verifiable credential to user wallet', async () => {
        await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');

        await keymaster.setCurrentId('Alice');

        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(bob, { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        await keymaster.setCurrentId('Bob');

        const ok = await keymaster.acceptCredential(did);
        expect(ok).toBe(true);

        const wallet = await keymaster.loadWallet();
        expect(wallet.ids['Alice'].owned!.includes(did));
        expect(wallet.ids['Bob'].held!.includes(did));
    });

    it('should return false if user cannot decrypt credential', async () => {
        await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');
        await keymaster.createId('Carol');

        await keymaster.setCurrentId('Alice');

        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(bob, { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        await keymaster.setCurrentId('Carol');

        const ok = await keymaster.acceptCredential(did);
        expect(ok).toBe(false);
    });

    it('should return false if user is not the credential subject', async () => {
        await keymaster.createId('Alice');
        const bob = await keymaster.createId('Bob');
        await keymaster.createId('Carol');

        await keymaster.setCurrentId('Alice');

        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential(bob, { schema: credentialDid });
        const vc1 = await keymaster.issueCredential(boundCredential);
        const credential = await keymaster.getCredential(vc1);
        const vc2 = await keymaster.encryptJSON(credential, 'Carol');

        await keymaster.setCurrentId('Carol');

        const ok = await keymaster.acceptCredential(vc2);
        expect(ok).toBe(false);
    });

    it('should return false if the verifiable credential is invalid', async () => {
        await keymaster.createId('Alice');
        await keymaster.createId('Bob');

        await keymaster.setCurrentId('Alice');

        const credentialDid = await keymaster.createSchema(mockSchema);

        await keymaster.setCurrentId('Bob');

        const ok = await keymaster.acceptCredential(credentialDid);
        expect(ok).toBe(false);
    });
});

describe('non-DID credentialSubject', () => {
    it('should bind credential with mailto: URI subject', async () => {
        await keymaster.createId('Alice');

        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential('mailto:bob@example.com', { schema: credentialDid });

        expect(boundCredential.credentialSubject.id).toBe('mailto:bob@example.com');
    });

    it('should bind credential with https: URI subject', async () => {
        await keymaster.createId('Alice');

        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential('https://example.com/users/bob', { schema: credentialDid });

        expect(boundCredential.credentialSubject.id).toBe('https://example.com/users/bob');
    });

    it('should issue credential with non-DID subject and issuer can decrypt', async () => {
        await keymaster.createId('Alice');

        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential('mailto:bob@example.com', { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        const credential = await keymaster.getCredential(did);
        expect(credential).not.toBeNull();
        expect(credential!.credentialSubject!.id).toBe('mailto:bob@example.com');
        expect(credential!.issuer).toContain('did:');
        expect(credential!.proof).toBeDefined();
    });

    it('should return null when sending credential with non-DID subject', async () => {
        await keymaster.createId('Alice');

        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential('mailto:bob@example.com', { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        const result = await keymaster.sendCredential(did);
        expect(result).toBeNull();
    });

    it('should update credential with non-DID subject', async () => {
        await keymaster.createId('Alice');

        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential('mailto:bob@example.com', { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        const credential = await keymaster.getCredential(did);
        credential!.credentialSubject!.email = 'updated@example.com';

        const ok = await keymaster.updateCredential(did, credential!);
        expect(ok).toBe(true);

        const updated = await keymaster.getCredential(did);
        expect(updated!.credentialSubject!.email).toBe('updated@example.com');
        expect(updated!.credentialSubject!.id).toBe('mailto:bob@example.com');
    });

    it('should revoke credential with non-DID subject', async () => {
        await keymaster.createId('Alice');

        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential('mailto:bob@example.com', { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        const ok = await keymaster.revokeCredential(did);
        expect(ok).toBe(true);

        const revoked = await keymaster.resolveDID(did);
        expect(revoked.didDocumentMetadata!.deactivated).toBe(true);
    });

    it('should return false when accepting credential with non-DID subject', async () => {
        await keymaster.createId('Alice');

        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential('mailto:bob@example.com', { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        const ok = await keymaster.acceptCredential(did);
        expect(ok).toBe(false);
    });

    it('should include non-DID subject credentials in listIssued', async () => {
        await keymaster.createId('Alice');

        const credentialDid = await keymaster.createSchema(mockSchema);
        const boundCredential = await keymaster.bindCredential('mailto:bob@example.com', { schema: credentialDid });
        const did = await keymaster.issueCredential(boundCredential);

        const issued = await keymaster.listIssued();
        expect(issued).toContain(did);
    });
});
