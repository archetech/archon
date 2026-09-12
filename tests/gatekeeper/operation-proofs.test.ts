import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import { Operation } from '@didcid/clients/gatekeeper-types';
import CipherNode from '@didcid/cipher/node';
import TestHelper from './helper.ts';
import proofVectors from './proof-vectors.json' with { type: 'json' };

const ipfs = new MemoryClient();
const cipher = new CipherNode();
const gatekeeper = new Gatekeeper({
    db: new DbJsonMemory('test'),
    ipfs,
    registries: ['local', 'hyperswarm'],
});
const helper = new TestHelper(gatekeeper, cipher);

beforeAll(async () => {
    await ipfs.start();
});

afterAll(async () => {
    await ipfs.stop();
});

// The Rust port checks the same vector, so a change here has to be made in both
// ports or one of the two suites fails.
// Refusal reaches a caller as either verdict: the format rules throw, the
// signature check returns false.
async function verifies(operation: Operation): Promise<boolean> {
    try {
        return await gatekeeper.verifyCreateOperation(operation);
    }
    catch {
        return false;
    }
}

function vector(): Operation {
    return JSON.parse(JSON.stringify(proofVectors.agentCreateValidDataIntegrity.operation)) as Operation;
}

describe('operation proofs', () => {

    it('accepts the legacy proof, which every anchored operation carries', async () => {
        const legacy = JSON.parse(JSON.stringify(proofVectors.agentCreateValid.operation)) as Operation;

        expect(gatekeeper.verifyProofFormat(legacy.proof)).toBe(true);
        await expect(gatekeeper.verifyCreateOperation(legacy)).resolves.toBe(true);
    });

    it('accepts a proof that signs its own configuration', async () => {
        expect(gatekeeper.verifyProofFormat(vector().proof)).toBe(true);
        await expect(gatekeeper.verifyCreateOperation(vector())).resolves.toBe(true);
    });

    it('refuses a cryptosuite it does not implement', () => {
        const operation = vector();
        (operation.proof! as unknown as Record<string, string>).cryptosuite = 'ecdsa-jcs-2019';

        expect(gatekeeper.verifyProofFormat(operation.proof)).toBe(false);
    });

    // The whole point of the suite: these members are inside the signature, so
    // a third party cannot rewrite them on an operation in flight. `created`
    // selects the controller document version that authorizes an asset
    // operation, which is why it matters (#1087).
    it.each([
        ['created', '2026-04-12T12:00:00Z'],
        ['proofPurpose', 'assertionMethod'],
        ['verificationMethod', '#key-2'],
    ])('binds %s', async (member, value) => {
        const operation = vector();
        (operation.proof! as unknown as Record<string, string>)[member] = value;

        // Refused either way: an agent create additionally requires the
        // relative #key-1, which throws before the signature is checked.
        expect(await verifies(operation)).toBe(false);
    });

    // Unchanged for the legacy type, which signs the document alone. This is
    // the defect the suite exists to fix, and it stays true for operations
    // already anchored under that label.
    it('does not bind created on the legacy proof', async () => {
        const legacy = JSON.parse(JSON.stringify(proofVectors.agentCreateValid.operation)) as Operation;
        legacy.proof!.created = '2026-04-12T12:00:00Z';

        await expect(gatekeeper.verifyCreateOperation(legacy)).resolves.toBe(true);
    });

    it('still rejects a tampered operation body', async () => {
        const operation = vector();
        operation.registration!.registry = 'hyperswarm';

        await expect(gatekeeper.verifyCreateOperation(operation)).resolves.toBe(false);
    });
});

// An operation exercises control over a DID document, which is what
// capabilityInvocation names and what a wallet emits. The other two are what
// this accepted before: the BTC-mainnet node's 43,020 anchored operations all
// claim authentication, but one store is not the network's history, and
// refusing a purpose that was once accepted freezes any DID that used it.
describe('operation proof purposes', () => {

    it.each(['capabilityInvocation', 'authentication', 'assertionMethod'])('accepts %s', (proofPurpose) => {
        const proof = { ...vector().proof, proofPurpose } as never;

        expect(gatekeeper.verifyProofFormat(proof)).toBe(true);
    });

    it.each(['keyAgreement', 'capabilityDelegation', ''])('refuses %p', (proofPurpose) => {
        const proof = { ...vector().proof, proofPurpose } as never;

        expect(gatekeeper.verifyProofFormat(proof)).toBe(false);
    });
});

// Selection is by the key the proof names, not by position. Rotation replaces
// the identity key in place, so index 0 has been right for every operation
// anchored so far -- but that is a property of how rotation works, not a rule,
// and a DID that publishes a second key could not sign with it (#1130).
describe('which key authorizes an operation', () => {

    async function agent() {
        const keypair = cipher.generateRandomJwk();
        const did = await gatekeeper.createDID(await helper.createAgentOp(keypair));

        return { keypair, did, doc: await gatekeeper.resolveDID(did) };
    }

    it('accepts a proof naming a key the document lists', async () => {
        const { keypair, did, doc } = await agent();

        await expect(gatekeeper.verifyUpdateOperation(
            await helper.createUpdateOp(keypair, did, doc), doc)).resolves.toBe(true);
    });

    it('refuses a proof naming a key the document does not list', async () => {
        const { keypair, did, doc } = await agent();
        const operation = await helper.createUpdateOp(keypair, did, doc);
        operation.proof!.verificationMethod = `${did}#key-9`;

        expect(await gatekeeper.verifyUpdateOperation(operation, doc)).toBe(false);
    });

    // The proof may name its key absolutely and the document relatively, so the
    // two are compared as DID URLs rather than as strings.
    it('matches a relative reference against an absolute one', async () => {
        const { keypair, did, doc } = await agent();
        const operation = await helper.createUpdateOp(keypair, did, doc);
        operation.proof!.verificationMethod = '#key-1';

        expect(await gatekeeper.verifyUpdateOperation(operation, doc)).toBe(true);
    });

    // Absent and empty are different verdicts, and the ports have to agree on
    // both. Absent means the controller has not been imported yet, so the
    // import state machine must defer; empty is a document with no keys, which
    // can never verify and must be refused rather than retried.
    it('defers on an absent verificationMethod and refuses an empty one', async () => {
        const { keypair, did, doc } = await agent();
        const operation = await helper.createUpdateOp(keypair, did, doc);

        const empty = JSON.parse(JSON.stringify(doc));
        empty.didDocument.verificationMethod = [];
        expect(await gatekeeper.verifyUpdateOperation(operation, empty)).toBe(false);

        const absent = JSON.parse(JSON.stringify(doc));
        delete absent.didDocument.verificationMethod;
        await expect(gatekeeper.verifyUpdateOperation(operation, absent))
            .rejects.toThrow('Invalid operation');
    });

    // A second key is unusable while selection is positional, which is what
    // this changes.
    it('accepts a second key the document lists', async () => {
        const { did, doc } = await agent();
        const second = cipher.generateRandomJwk();

        doc.didDocument!.verificationMethod!.push({
            id: '#key-2',
            controller: did,
            type: 'EcdsaSecp256k1VerificationKey2019',
            publicKeyJwk: second.publicJwk,
        });

        const operation = await helper.createUpdateOp(second, did, doc);
        operation.proof!.verificationMethod = `${did}#key-2`;

        expect(await gatekeeper.verifyUpdateOperation(operation, doc)).toBe(true);
    });
});
