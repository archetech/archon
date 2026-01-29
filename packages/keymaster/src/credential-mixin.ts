import {
    InvalidParameterError,
    KeymasterError,
} from '@didcid/common/errors';
import {
    DidCidDocument,
    Proof,
    ProofPurpose,
    ResolveDIDOptions,
} from '@didcid/gatekeeper/types';
import {
    Challenge,
    ChallengeResponse,
    CreateAssetOptions,
    CreateResponseOptions,
    EncryptedMessage,
    EncryptOptions,
    IDInfo,
    IssueCredentialsOptions,
    NoticeMessage,
    VerifiableCredential,
} from '@didcid/keymaster/types';
import {
    Cipher,
    EcdsaJwkPair,
} from '@didcid/cipher/types';

// Type for constructors
type Constructor<T = {}> = new (...args: any[]) => T;

// Interface describing the base class requirements for CredentialMixin
export interface CredentialMixinRequirements {
    // Properties
    cipher: Cipher;
    ephemeralRegistry: string;

    // Base methods
    fetchIdInfo(id?: string): Promise<IDInfo>;
    fetchKeyPair(name?: string): Promise<EcdsaJwkPair | null>;
    lookupDID(name: string): Promise<string>;
    resolveDID(did: string, options?: ResolveDIDOptions): Promise<DidCidDocument>;
    resolveAsset(did: string, options?: ResolveDIDOptions): Promise<any>;
    createAsset(data: unknown, options?: CreateAssetOptions): Promise<string>;
    updateDID(id: string, doc: Partial<DidCidDocument>): Promise<boolean>;
    revokeDID(id: string): Promise<boolean>;
    addToHeld(did: string): Promise<boolean>;
    removeFromHeld(did: string): Promise<boolean>;
    getPublicKeyJwk(doc: DidCidDocument): any;

    // Encryption methods
    encryptMessage(msg: string, receiver: string, options?: EncryptOptions): Promise<string>;
    decryptMessage(did: string): Promise<string>;
    encryptJSON(json: unknown, did: string, options?: EncryptOptions): Promise<string>;
    decryptJSON(did: string): Promise<unknown>;

    // Proof methods
    addProof<T extends object>(obj: T, controller?: string, proofPurpose?: ProofPurpose): Promise<T & { proof: Proof }>;
    verifyProof<T extends { proof?: Proof }>(obj: T): Promise<boolean>;

    // Schema methods (from SchemaMixin)
    getSchema(id: string): Promise<unknown | null>;
    _generateSchema(schema: unknown): Record<string, unknown>;

    // Notice methods
    createNotice(message: NoticeMessage, options?: CreateAssetOptions): Promise<string | null>;
}

export function CredentialMixin<TBase extends Constructor<CredentialMixinRequirements>>(Base: TBase) {
    return class CredentialImpl extends Base {
        _isVerifiableCredential(obj: unknown): obj is VerifiableCredential {
            if (typeof obj !== 'object' || !obj) {
                return false;
            }

            const vc = obj as Partial<VerifiableCredential>;

            return !(!Array.isArray(vc["@context"]) || !Array.isArray(vc.type) || !vc.issuer || !vc.credentialSubject);
        }

        async bindCredential(
            subjectId: string,
            options: {
                schema?: string;
                validFrom?: string;
                validUntil?: string;
                claims?: Record<string, unknown>;
                types?: string[];
            } = {}
        ): Promise<VerifiableCredential> {
            let { schema, validFrom, validUntil, claims, types } = options;

            if (!validFrom) {
                validFrom = new Date().toISOString();
            }

            const id = await this.fetchIdInfo();
            const subjectDID = await this.lookupDID(subjectId);

            const vc: VerifiableCredential = {
                "@context": [
                    "https://www.w3.org/ns/credentials/v2",
                    "https://www.w3.org/ns/credentials/examples/v2"
                ],
                type: ["VerifiableCredential", ...(types || [])],
                issuer: id.did,
                validFrom,
                validUntil,
                credentialSubject: {
                    id: subjectDID,
                },
            };

            // If schema provided, add credentialSchema and generate claims from schema
            if (schema) {
                const schemaDID = await this.lookupDID(schema);
                const schemaDoc = await this.getSchema(schemaDID) as { $credentialTypes?: string[]; properties?: Record<string, unknown> } | null;

                if (!claims && schemaDoc) {
                    claims = this._generateSchema(schemaDoc);
                }

                // If schema has $credentialTypes, add them to credential types
                if (schemaDoc?.$credentialTypes) {
                    vc.type.push(...schemaDoc.$credentialTypes);
                }

                vc.credentialSchema = {
                    id: schemaDID,
                    type: "JsonSchema",
                };
            }

            if (claims) {
                vc.credentialSubject = {
                    id: subjectDID,
                    ...claims,
                };
            }

            return vc;
        }

        async issueCredential(
            credential: Partial<VerifiableCredential>,
            options: IssueCredentialsOptions = {}
        ): Promise<string> {
            const id = await this.fetchIdInfo();

            if (options.schema && options.subject) {
                credential = await this.bindCredential(options.subject, { schema: options.schema, claims: options.claims, ...options });
            }

            if (credential.issuer !== id.did) {
                throw new InvalidParameterError('credential.issuer');
            }

            const signed = await this.addProof(credential);
            return this.encryptJSON(signed, credential.credentialSubject!.id, { ...options, includeHash: true });
        }

        async sendCredential(
            did: string,
            options: CreateAssetOptions = {}
        ): Promise<string | null> {
            const vc = await this.getCredential(did);

            if (!vc) {
                return null;
            }

            const registry = this.ephemeralRegistry;
            const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // Default to 7 days

            const message: NoticeMessage = {
                to: [vc.credentialSubject!.id],
                dids: [did],
            };

            return this.createNotice(message, { registry, validUntil, ...options });
        }

        async updateCredential(
            did: string,
            credential: VerifiableCredential
        ): Promise<boolean> {
            did = await this.lookupDID(did);
            const originalVC = await this.decryptJSON(did);

            if (!this._isVerifiableCredential(originalVC)) {
                throw new InvalidParameterError("did is not a credential");
            }

            if (!credential ||
                !credential.credentialSubject ||
                !credential.credentialSubject.id) {
                throw new InvalidParameterError('credential');
            }

            delete credential.proof;
            const signed = await this.addProof(credential);
            const msg = JSON.stringify(signed);

            const id = await this.fetchIdInfo();
            const senderKeypair = await this.fetchKeyPair();
            if (!senderKeypair) {
                throw new KeymasterError('No valid sender keypair');
            }

            const holder = credential.credentialSubject.id;
            const holderDoc = await this.resolveDID(holder, { confirm: true });
            const receivePublicJwk = this.getPublicKeyJwk(holderDoc);
            const cipher_sender = this.cipher.encryptMessage(senderKeypair.publicJwk, senderKeypair.privateJwk, msg);
            const cipher_receiver = this.cipher.encryptMessage(receivePublicJwk, senderKeypair.privateJwk, msg);
            const msgHash = this.cipher.hashMessage(msg);

            const encrypted: EncryptedMessage = {
                sender: id.did,
                created: new Date().toISOString(),
                cipher_hash: msgHash,
                cipher_sender: cipher_sender,
                cipher_receiver: cipher_receiver,
            };
            return this.updateDID(did, { didDocumentData: { encrypted } });
        }

        async revokeCredential(credential: string): Promise<boolean> {
            const did = await this.lookupDID(credential);
            return this.revokeDID(did);
        }

        async listIssued(issuer?: string): Promise<string[]> {
            const id = await this.fetchIdInfo(issuer);
            const issued = [];

            if (id.owned) {
                for (const did of id.owned) {
                    try {
                        const credential = await this.decryptJSON(did);

                        if (this._isVerifiableCredential(credential) &&
                            credential.issuer === id.did) {
                            issued.push(did);
                        }
                    }
                    catch (error) { }
                }
            }

            return issued;
        }

        async acceptCredential(did: string): Promise<boolean> {
            try {
                const id = await this.fetchIdInfo();
                const credential = await this.lookupDID(did);
                const vc = await this.decryptJSON(credential);

                if (this._isVerifiableCredential(vc) &&
                    vc.credentialSubject?.id !== id.did) {
                    return false;
                }

                return this.addToHeld(credential);
            }
            catch (error) {
                return false;
            }
        }

        async getCredential(id: string): Promise<VerifiableCredential | null> {
            const did = await this.lookupDID(id);

            const vc = await this.decryptJSON(did);

            if (!this._isVerifiableCredential(vc)) {
                return null;
            }

            return vc;
        }

        async removeCredential(id: string): Promise<boolean> {
            const did = await this.lookupDID(id);
            return this.removeFromHeld(did);
        }

        async listCredentials(id?: string): Promise<string[]> {
            const idInfo = await this.fetchIdInfo(id);
            return idInfo.held || [];
        }

        async publishCredential(
            did: string,
            options: { reveal?: boolean } = {}
        ): Promise<VerifiableCredential> {
            const { reveal = false } = options;

            const id = await this.fetchIdInfo();
            const credential = await this.lookupDID(did);
            const vc = await this.decryptJSON(credential);
            if (!this._isVerifiableCredential(vc)) {
                throw new InvalidParameterError("did is not a credential");
            }

            if (vc.credentialSubject?.id !== id.did) {
                throw new InvalidParameterError('only subject can publish a credential');
            }

            const doc = await this.resolveDID(id.did);

            if (!doc.didDocumentData) {
                doc.didDocumentData = {};
            }

            const data = doc.didDocumentData as { manifest?: Record<string, unknown> };

            if (!data.manifest) {
                data.manifest = {};
            }

            if (!reveal) {
                // Remove the claim values, keep only the subject id
                vc.credentialSubject = { id: vc.credentialSubject!.id };
            }

            data.manifest[credential] = vc;

            const ok = await this.updateDID(id.did, { didDocumentData: doc.didDocumentData });
            if (ok) {
                return vc;
            }

            throw new KeymasterError('update DID failed');
        }

        async unpublishCredential(did: string): Promise<string> {
            const id = await this.fetchIdInfo();
            const doc = await this.resolveDID(id.did);
            const credential = await this.lookupDID(did);
            const data = doc.didDocumentData as { manifest?: Record<string, unknown> };

            if (credential && data.manifest && credential in data.manifest) {
                delete data.manifest[credential];
                await this.updateDID(id.did, { didDocumentData: doc.didDocumentData });

                return `OK credential ${did} removed from manifest`;
            }

            throw new InvalidParameterError('did');
        }

        // ==================== Challenge Methods ====================

        async createChallenge(
            challenge: Challenge = {},
            options: CreateAssetOptions = {}
        ): Promise<string> {

            if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)) {
                throw new InvalidParameterError('challenge');
            }

            if (challenge.credentials && !Array.isArray(challenge.credentials)) {
                throw new InvalidParameterError('challenge.credentials');

                // TBD validate each credential spec
            }

            if (!options.registry) {
                options.registry = this.ephemeralRegistry;
            }

            if (!options.validUntil) {
                const expires = new Date();
                expires.setHours(expires.getHours() + 1); // Add 1 hour
                options.validUntil = expires.toISOString();
            }

            return this.createAsset({ challenge }, options);
        }

        async _credential_findMatchingCredential(
            credential: {
                schema: string;
                issuers?: string[]
            }
        ): Promise<string | undefined> {
            const id = await this.fetchIdInfo();

            if (!id.held) {
                return;
            }

            for (let did of id.held) {
                try {
                    const doc = await this.decryptJSON(did);

                    if (!this._isVerifiableCredential(doc)) {
                        continue;
                    }

                    if (doc.credentialSubject?.id !== id.did) {
                        // This VC is issued by the ID, not held
                        continue;
                    }

                    if (credential.issuers && !credential.issuers.includes(doc.issuer)) {
                        // Attestor not trusted by Verifier
                        continue;
                    }

                    if (doc.credentialSchema?.id !== credential.schema) {
                        // Wrong schema
                        continue;
                    }

                    // TBD test for VC expiry too
                    return did;
                }
                catch (error) {
                    // Not encrypted, so can't be a VC
                }
            }
        }

        async createResponse(
            challengeDID: string,
            options: CreateResponseOptions = {}
        ): Promise<string> {
            let { retries = 0, delay = 1000 } = options;

            if (!options.registry) {
                options.registry = this.ephemeralRegistry;
            }

            if (!options.validUntil) {
                const expires = new Date();
                expires.setHours(expires.getHours() + 1); // Add 1 hour
                options.validUntil = expires.toISOString();
            }

            let doc;

            while (retries >= 0) {
                try {
                    doc = await this.resolveDID(challengeDID);
                    break;
                } catch (error) {
                    if (retries === 0) throw error; // If no retries left, throw the error
                    retries--; // Decrease the retry count
                    await new Promise(resolve => setTimeout(resolve, delay)); // Wait for delay milleseconds
                }
            }
            if (!doc!) {
                throw new InvalidParameterError('challengeDID does not resolve');
            }

            const result = await this.resolveAsset(challengeDID);
            if (!result) {
                throw new InvalidParameterError('challengeDID');
            }

            const challenge = (result as { challenge?: Challenge }).challenge;
            if (!challenge) {
                throw new InvalidParameterError('challengeDID');
            }

            const requestor = doc.didDocument?.controller;
            if (!requestor) {
                throw new InvalidParameterError('requestor undefined');
            }

            // TBD check challenge isValid for expired?

            const matches = [];

            if (challenge.credentials) {
                for (let credential of challenge.credentials) {
                    const vc = await this._credential_findMatchingCredential(credential);

                    if (vc) {
                        matches.push(vc);
                    }
                }
            }

            const pairs = [];

            for (let vcDid of matches) {
                const plaintext = await this.decryptMessage(vcDid);
                const vpDid = await this.encryptMessage(plaintext, requestor, { ...options, includeHash: true });
                pairs.push({ vc: vcDid, vp: vpDid });
            }

            const requested = challenge.credentials?.length ?? 0;
            const fulfilled = matches.length;
            const match = (requested === fulfilled);

            const response = {
                challenge: challengeDID,
                credentials: pairs,
                requested: requested,
                fulfilled: fulfilled,
                match: match
            };

            return await this.encryptJSON({ response }, requestor!, options);
        }

        async verifyResponse(
            responseDID: string,
            options: { retries?: number; delay?: number } = {}
        ): Promise<ChallengeResponse> {
            let { retries = 0, delay = 1000 } = options;

            let responseDoc;

            while (retries >= 0) {
                try {
                    responseDoc = await this.resolveDID(responseDID);
                    break;
                } catch (error) {
                    if (retries === 0) throw error; // If no retries left, throw the error
                    retries--; // Decrease the retry count
                    await new Promise(resolve => setTimeout(resolve, delay)); // Wait for delay milliseconds
                }
            }
            if (!responseDoc!) {
                throw new InvalidParameterError('responseDID does not resolve');
            }

            const wrapper = await this.decryptJSON(responseDID);
            if (typeof wrapper !== 'object' || !wrapper || !('response' in wrapper)) {
                throw new InvalidParameterError('responseDID not a valid challenge response');
            }
            const { response } = wrapper as { response: ChallengeResponse };

            const result = await this.resolveAsset(response.challenge);
            if (!result) {
                throw new InvalidParameterError('challenge not found');
            }

            const challenge = (result as { challenge?: Challenge }).challenge;
            if (!challenge) {
                throw new InvalidParameterError('challengeDID');
            }

            const vps: unknown[] = [];

            for (let credential of response.credentials) {
                const vcData = await this.resolveAsset(credential.vc);
                const vpData = await this.resolveAsset(credential.vp);

                const castVCData = vcData as { encrypted?: EncryptedMessage };
                const castVPData = vpData as { encrypted?: EncryptedMessage };

                if (!vcData || !vpData || !castVCData.encrypted || !castVPData.encrypted) {
                    // VC revoked
                    continue;
                }

                const vcHash = castVCData.encrypted;
                const vpHash = castVPData.encrypted;

                if (vcHash.cipher_hash !== vpHash.cipher_hash) {
                    // can't verify that the contents of VP match the VC
                    continue;
                }

                const vp = await this.decryptJSON(credential.vp) as VerifiableCredential;
                const isValid = await this.verifyProof(vp);

                if (!isValid) {
                    continue;
                }

                if (!vp.type || !Array.isArray(vp.type)) {
                    continue;
                }

                // Check VP against VCs specified in challenge
                if (vp.credentialSchema?.id) {
                    const schema = vp.credentialSchema.id;
                    const credential = challenge.credentials?.find(item => item.schema === schema);

                    if (!credential) {
                        continue;
                    }

                    // Check if issuer of VP is in the trusted issuer list
                    if (credential.issuers && credential.issuers.length > 0 && !credential.issuers.includes(vp.issuer)) {
                        continue;
                    }
                }

                vps.push(vp);
            }

            response.vps = vps;
            response.match = vps.length === (challenge.credentials?.length ?? 0);
            response.responder = responseDoc.didDocument?.controller;

            return response;
        }
    };
}
