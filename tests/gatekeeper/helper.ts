import CipherNode from '@didcid/cipher/node';
import { Operation, DidCidDocument } from '@didcid/gatekeeper/types';
import Gatekeeper from '@didcid/gatekeeper';
import type { EcdsaJwkPair } from '@didcid/cipher/types';
import { base64url } from 'multiformats/bases/base64';

function hexToBase64url(hex: string): string {
    const bytes = Buffer.from(hex, 'hex');
    return base64url.baseEncode(bytes);
}

export default class TestHelper {
    private gatekeeper: Gatekeeper;
    private cipher: CipherNode;

    constructor(gatekeeper: Gatekeeper, cipher: CipherNode) {
        this.gatekeeper = gatekeeper;
        this.cipher = cipher;
    }

    async createAgentOp(
        keypair: EcdsaJwkPair,
        options: {
            version?: number;
            registry?: string;
            prefix?: string;
        } = {}
    ): Promise<Operation> {
        const { version = 1, registry = 'local', prefix } = options;
        const operation: Operation = {
            type: "create",
            created: new Date().toISOString(),
            registration: {
                version: version,
                type: "agent",
                registry: registry,
            },
            publicJwk: keypair.publicJwk,
        };

        if (prefix) {
            operation.registration!.prefix = prefix;
        }

        const msgHash = this.cipher.hashJSON(operation);
        const signatureHex = this.cipher.signHash(msgHash, keypair.privateJwk);

        return {
            ...operation,
            proof: {
                type: "EcdsaSecp256k1Signature2019",
                created: new Date().toISOString(),
                verificationMethod: "#key-1",
                proofPurpose: "authentication",
                proofValue: hexToBase64url(signatureHex),
            }
        };
    }

    async createUpdateOp(
        keypair: EcdsaJwkPair,
        did: string,
        doc: DidCidDocument,
        options: {
            excludePrevid?: boolean;
            mockPrevid?: string;
            mockBlockid?: string;
        } = {}
    ): Promise<Operation> {
        const { excludePrevid = false, mockPrevid } = options;
        const current = await this.gatekeeper.resolveDID(did);
        const previd = excludePrevid ? undefined : mockPrevid ? mockPrevid : current.didDocumentMetadata?.versionId;
        const { mockBlockid } = options;

        const operation: Operation = {
            type: "update",
            did,
            previd,
            ...(mockBlockid !== undefined && { blockid: mockBlockid }),
            doc,
        };

        const msgHash = this.cipher.hashJSON(operation);
        const signatureHex = this.cipher.signHash(msgHash, keypair.privateJwk);

        return {
            ...operation,
            proof: {
                type: "EcdsaSecp256k1Signature2019",
                created: new Date().toISOString(),
                verificationMethod: `${did}#key-1`,
                proofPurpose: "authentication",
                proofValue: hexToBase64url(signatureHex),
            }
        };
    }

    async createDeleteOp(
        keypair: EcdsaJwkPair,
        did: string
    ): Promise<Operation> {
        const current = await this.gatekeeper.resolveDID(did);
        const previd = current.didDocumentMetadata?.versionId;

        const operation: Operation = {
            type: "delete",
            did,
            previd,
        };

        const msgHash = this.cipher.hashJSON(operation);
        const signatureHex = this.cipher.signHash(msgHash, keypair.privateJwk);

        return {
            ...operation,
            proof: {
                type: "EcdsaSecp256k1Signature2019",
                created: new Date().toISOString(),
                verificationMethod: `${did}#key-1`,
                proofPurpose: "authentication",
                proofValue: hexToBase64url(signatureHex),
            }
        };
    }

    async createAssetOp(
        agent: string,
        keypair: EcdsaJwkPair,
        options: {
            registry?: string;
            validUntil?: string | null;
            data?: unknown;
        } = {}
    ): Promise<Operation> {
        const { registry = 'local', validUntil = null, data = 'mockData' } = options;
        const dataAnchor: Operation = {
            type: "create",
            created: new Date().toISOString(),
            registration: {
                version: 1,
                type: "asset",
                registry,
                validUntil: validUntil || undefined
            },
            controller: agent,
            data,
        };

        const msgHash = this.cipher.hashJSON(dataAnchor);
        const signatureHex = this.cipher.signHash(msgHash, keypair.privateJwk);

        return {
            ...dataAnchor,
            proof: {
                type: "EcdsaSecp256k1Signature2019",
                created: new Date().toISOString(),
                verificationMethod: `${agent}#key-1`,
                proofPurpose: "authentication",
                proofValue: hexToBase64url(signatureHex),
            }
        };
    }
}
