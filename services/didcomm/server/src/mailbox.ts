// Express-free core logic for the DIDComm relay, so it is unit-testable
// without booting an HTTP server (matches the other services' test style).
import { getEnvelopeInfo } from '@didcid/cipher/didcomm';
import type { Cipher } from '@didcid/cipher/types';
import type { DidCidDocument } from '@didcid/gatekeeper/types';

export interface Resolver {
    resolveDID(did: string): Promise<DidCidDocument>;
}

// The recipient DIDs an encrypted envelope is addressed to, parsed from the
// JWE recipient key ids (the only routing info available without the keys).
export function recipientDidsFromEnvelope(packed: string): string[] {
    const info = getEnvelopeInfo(packed);
    if (info.type !== 'encrypted' || !info.kids || info.kids.length === 0) {
        throw new Error('Not a DIDComm encrypted message');
    }
    return [...new Set(info.kids.map(kid => kid.split('#')[0]))];
}

// A recipient proves control of its DID by signing a server-issued challenge
// with its DID signing key (secp256k1 / ES256K). We resolve the DID and verify
// against its first verification method.
export async function verifyChallengeSignature(
    deps: { resolver: Resolver; cipher: Cipher },
    params: { did: string; challenge: string; signature: string },
): Promise<boolean> {
    let doc: DidCidDocument;
    try {
        doc = await deps.resolver.resolveDID(params.did);
    }
    catch {
        return false;
    }
    const vm = doc.didDocument?.verificationMethod?.[0];
    if (!vm?.publicKeyJwk || vm.publicKeyJwk.kty !== 'EC') {
        return false;
    }
    try {
        const msgHash = deps.cipher.hashMessage(params.challenge);
        return deps.cipher.verifySig(msgHash, params.signature, vm.publicKeyJwk);
    }
    catch {
        return false;
    }
}
