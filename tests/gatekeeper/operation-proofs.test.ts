import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import { Operation } from '@didcid/clients/gatekeeper-types';
import proofVectors from './proof-vectors.json' with { type: 'json' };

const gatekeeper = new Gatekeeper({
    db: new DbJsonMemory('test'),
    ipfs: new MemoryClient(),
    registries: ['local', 'hyperswarm'],
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
// capabilityInvocation names. The other two stay accepted because every
// operation anchored before that was settled claims authentication, and
// assertionMethod was accepted alongside it.
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
