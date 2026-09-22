import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import { generateCID } from '@didcid/ipfs/utils';
import type { Operation } from '@didcid/gatekeeper/types';

const scheme = readFileSync(new URL('../../docs/scheme.md', import.meta.url), 'utf8');
const currentExample = scheme.split('This create-agent operation uses the current suite.')[1]
    ?.split('Including the configuration in the signed payload')[0];

it('keeps the current-suite example signed and content-addressed', async () => {
    expect(currentExample).toBeDefined();
    const json = currentExample!.match(/```json\n([\s\S]*?)\n```/);
    const did = currentExample!.match(/Its DID is `([^`]+)`\./);
    expect(json).not.toBeNull();
    expect(did).not.toBeNull();

    const operation = JSON.parse(json![1]) as Operation;
    const { proof, ...unsecured } = operation;
    const { proofValue, ...config } = proof!;
    const cipher = new CipherNode();
    const key = cipher.generateJwk(new Uint8Array(32).fill(0x4a));

    expect(unsecured.publicJwk).toStrictEqual(key.publicJwk);
    expect(config).toMatchObject({
        type: 'DataIntegrityProof',
        cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026',
        verificationMethod: '#key-1',
        proofPurpose: 'capabilityInvocation',
    });

    // Recreate Keymaster's two-hash payload and compact ECDSA signature.
    const payload = Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(unsecured), 'hex');
    const digest = cipher.hashMessage(payload);
    const signature = Buffer.from(cipher.signHash(digest, key.privateJwk), 'hex').toString('base64url');
    expect(proofValue).toBe(signature);

    const gatekeeper = new Gatekeeper({
        db: new DbJsonMemory('test'),
        ipfs: new MemoryClient(),
        registries: ['hyperswarm'],
    });
    await expect(gatekeeper.verifyCreateOperation(operation)).resolves.toBe(true);
    expect(did![1]).toBe(`did:cid:${await generateCID(operation, { canonical: true })}`);
});
