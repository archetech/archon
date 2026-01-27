import { fileTypeFromBuffer } from 'file-type';
import {
    KeymasterError,
    InvalidParameterError,
} from '@didcid/common/errors';
import {
    DidCidDocument,
    GatekeeperInterface,
    ResolveDIDOptions,
} from '@didcid/gatekeeper/types';
import {
    Vault,
    VaultOptions,
    IDInfo,
    WalletFile,
} from '@didcid/keymaster/types';
import {
    Cipher,
    EcdsaJwkPrivate,
    EcdsaJwkPublic,
} from '@didcid/cipher/types';

// Type for constructors
type Constructor<T = {}> = new (...args: any[]) => T;

// Interface describing the base class requirements for VaultMixin
export interface VaultMixinRequirements {
    // Properties
    cipher: Cipher;
    gatekeeper: GatekeeperInterface;
    maxDataLength: number;
    maxNameLength: number;

    // Methods the mixin depends on
    loadWallet(): Promise<WalletFile>;
    fetchIdInfo(id?: string, wallet?: WalletFile): Promise<IDInfo>;
    fetchKeyPair(name?: string): Promise<{ publicJwk: EcdsaJwkPublic; privateJwk: EcdsaJwkPrivate } | null>;
    resolveDID(did: string, options?: ResolveDIDOptions): Promise<DidCidDocument>;
    resolveAsset(did: string, options?: ResolveDIDOptions): Promise<any>;
    createAsset(data: unknown, options?: any): Promise<string>;
    updateAsset(did: string, data: Record<string, unknown>): Promise<boolean>;
    getPublicKeyJwk(doc: DidCidDocument): EcdsaJwkPublic;
    decryptWithDerivedKeys(wallet: WalletFile, id: IDInfo, senderPublicJwk: EcdsaJwkPublic, ciphertext: string): Promise<string>;
    validateName(name: string, wallet?: WalletFile): string;
}

export function VaultMixin<TBase extends Constructor<VaultMixinRequirements>>(Base: TBase) {
    return class VaultImpl extends Base {
        // ==================== Public Vault Methods ====================

        async createVault(options: VaultOptions = {}): Promise<string> {
            const id = await this.fetchIdInfo();
            const idKeypair = await this.fetchKeyPair();
            // version defaults to 1. To make version undefined (unit testing), set options.version to 0
            const version = typeof options.version === 'undefined'
                ? 1
                : (typeof options.version === 'number' && options.version === 1 ? options.version : undefined);
            const salt = this.cipher.generateRandomSalt();
            const vaultKeypair = this.cipher.generateRandomJwk();
            const keys = {};
            const config = this.cipher.encryptMessage(idKeypair!.publicJwk, vaultKeypair.privateJwk, JSON.stringify(options));
            const publicJwk = options.secretMembers ? idKeypair!.publicJwk : vaultKeypair.publicJwk; // If secret, encrypt for the owner only
            const members = this.cipher.encryptMessage(publicJwk, vaultKeypair.privateJwk, JSON.stringify({}));
            const items = this.cipher.encryptMessage(vaultKeypair.publicJwk, vaultKeypair.privateJwk, JSON.stringify({}));
            const sha256 = this.cipher.hashJSON({});
            const vault = {
                version,
                publicJwk: vaultKeypair.publicJwk,
                salt,
                config,
                members,
                keys,
                items,
                sha256,
            };

            await this._vault_addMemberKey(vault, id.did, vaultKeypair.privateJwk);
            return this.createAsset({ vault }, options);
        }

        async getVault(vaultId: string, options?: ResolveDIDOptions): Promise<Vault> {
            const asset = await this.resolveAsset(vaultId, options) as { vault?: Vault };

            if (!asset.vault) {
                throw new InvalidParameterError('vaultId');
            }

            return asset.vault;
        }

        async testVault(id: string, options?: ResolveDIDOptions): Promise<boolean> {
            try {
                const vault = await this.getVault(id, options);
                return vault !== null;
            }
            catch (error) {
                return false;
            }
        }

        getAgentDID(doc: DidCidDocument): string {
            if (doc.didDocumentRegistration?.type !== 'agent') {
                throw new KeymasterError('Document is not an agent');
            }

            const did = doc.didDocument?.id;

            if (!did) {
                throw new KeymasterError('Agent document does not have a DID');
            }

            return did;
        }

        async addVaultMember(vaultId: string, memberId: string): Promise<boolean> {
            const owner = await this._vault_checkVaultOwner(vaultId);

            const idKeypair = await this.fetchKeyPair();
            const vault = await this.getVault(vaultId);
            const { privateJwk, config, members } = await this._vault_decryptVault(vault);
            const memberDoc = await this.resolveDID(memberId, { confirm: true });
            const memberDID = this.getAgentDID(memberDoc);

            // Don't allow adding the vault owner
            if (owner === memberDID) {
                return false;
            }

            members[memberDID] = { added: new Date().toISOString() };
            const publicJwk = config.secretMembers ? idKeypair!.publicJwk : vault.publicJwk;
            vault.members = this.cipher.encryptMessage(publicJwk, privateJwk, JSON.stringify(members));

            await this._vault_addMemberKey(vault, memberDID, privateJwk);
            return this.updateAsset(vaultId, { vault });
        }

        async removeVaultMember(vaultId: string, memberId: string): Promise<boolean> {
            const owner = await this._vault_checkVaultOwner(vaultId);

            const idKeypair = await this.fetchKeyPair();
            const vault = await this.getVault(vaultId);
            const { privateJwk, config, members } = await this._vault_decryptVault(vault);
            const memberDoc = await this.resolveDID(memberId, { confirm: true });
            const memberDID = this.getAgentDID(memberDoc);

            // Don't allow removing the vault owner
            if (owner === memberDID) {
                return false;
            }

            delete members[memberDID];
            const publicJwk = config.secretMembers ? idKeypair!.publicJwk : vault.publicJwk;
            vault.members = this.cipher.encryptMessage(publicJwk, privateJwk, JSON.stringify(members));

            const memberKeyId = this._vault_generateSaltedId(vault, memberDID);
            delete vault.keys[memberKeyId];

            return this.updateAsset(vaultId, { vault });
        }

        async listVaultMembers(vaultId: string): Promise<Record<string, any>> {
            const vault = await this.getVault(vaultId);
            const { members, isOwner } = await this._vault_decryptVault(vault);

            if (isOwner) {
                await this._vault_checkVaultVersion(vaultId, vault);
            }

            return members;
        }

        async addVaultItem(vaultId: string, name: string, buffer: Buffer): Promise<boolean> {
            await this._vault_checkVaultOwner(vaultId);

            const vault = await this.getVault(vaultId);
            const { privateJwk, items } = await this._vault_decryptVault(vault);
            const validName = this.validateName(name);
            const encryptedData = this.cipher.encryptBytes(vault.publicJwk, privateJwk, buffer);
            const cid = await this.gatekeeper.addText(encryptedData);
            const sha256 = this.cipher.hashMessage(buffer);
            const type = await this._vault_getMimeType(buffer);
            const data = encryptedData.length < this.maxDataLength ? encryptedData : undefined;

            items[validName] = {
                cid,
                sha256,
                bytes: buffer.length,
                type,
                added: new Date().toISOString(),
                data,
            };

            vault.items = this.cipher.encryptMessage(vault.publicJwk, privateJwk, JSON.stringify(items));
            vault.sha256 = this.cipher.hashJSON(items);

            return this.updateAsset(vaultId, { vault });
        }

        async removeVaultItem(vaultId: string, name: string): Promise<boolean> {
            await this._vault_checkVaultOwner(vaultId);

            const vault = await this.getVault(vaultId);
            const { privateJwk, items } = await this._vault_decryptVault(vault);

            delete items[name];

            vault.items = this.cipher.encryptMessage(vault.publicJwk, privateJwk, JSON.stringify(items));
            vault.sha256 = this.cipher.hashJSON(items);
            return this.updateAsset(vaultId, { vault });
        }

        async listVaultItems(vaultId: string, options?: ResolveDIDOptions): Promise<Record<string, any>> {
            const vault = await this.getVault(vaultId, options);
            const { items } = await this._vault_decryptVault(vault);

            return items;
        }

        async getVaultItem(vaultId: string, name: string, options?: ResolveDIDOptions): Promise<Buffer | null> {
            try {
                const vault = await this.getVault(vaultId, options);
                const { privateJwk, items } = await this._vault_decryptVault(vault);

                if (items[name]) {
                    const encryptedData = items[name].data || await this.gatekeeper.getText(items[name].cid);

                    if (encryptedData) {
                        const bytes = this.cipher.decryptBytes(vault.publicJwk, privateJwk, encryptedData);
                        return Buffer.from(bytes);
                    }
                }

                return null;
            }
            catch (error) {
                return null;
            }
        }

        // ==================== Vault Helpers (internal use) ====================

        _vault_generateSaltedId(vault: Vault, memberDID: string): string {
            if (!vault.version) {
                return this.cipher.hashMessage(vault.salt + memberDID);
            }

            const suffix = memberDID.split(':').pop() as string;
            return this.cipher.hashMessage(vault.salt + suffix);
        }

        async _vault_decryptVault(vault: Vault) {
            const wallet = await this.loadWallet();
            const id = await this.fetchIdInfo();
            const myMemberId = this._vault_generateSaltedId(vault, id.did);
            const myVaultKey = vault.keys[myMemberId];

            if (!myVaultKey) {
                throw new KeymasterError('No access to vault');
            }

            const privKeyJSON = await this.decryptWithDerivedKeys(wallet, id, vault.publicJwk, myVaultKey);
            const privateJwk = JSON.parse(privKeyJSON) as EcdsaJwkPrivate;

            let config: VaultOptions = {};
            let isOwner = false;
            try {
                const configJSON = await this.decryptWithDerivedKeys(wallet, id, vault.publicJwk, vault.config);
                config = JSON.parse(configJSON);
                isOwner = true;
            }
            catch (error) {
                // Can't decrypt config if not the owner
            }

            let members: Record<string, any> = {};

            if (config.secretMembers) {
                try {
                    const membersJSON = await this.decryptWithDerivedKeys(wallet, id, vault.publicJwk, vault.members);
                    members = JSON.parse(membersJSON);
                }
                catch (error) {
                }
            }
            else {
                try {
                    const membersJSON = this.cipher.decryptMessage(vault.publicJwk, privateJwk, vault.members);
                    members = JSON.parse(membersJSON);
                }
                catch (error) {
                }
            }

            const itemsJSON = this.cipher.decryptMessage(vault.publicJwk, privateJwk, vault.items);
            const items = JSON.parse(itemsJSON);

            return {
                isOwner,
                privateJwk,
                config,
                members,
                items,
            };
        }

        async _vault_checkVaultOwner(vaultId: string): Promise<string> {
            const id = await this.fetchIdInfo();
            const vaultDoc = await this.resolveDID(vaultId);
            const controller = vaultDoc.didDocument?.controller;

            if (controller !== id.did) {
                throw new KeymasterError('Only vault owner can modify the vault');
            }

            return controller
        }

        async _vault_addMemberKey(vault: Vault, memberDID: string, privateJwk: EcdsaJwkPrivate): Promise<void> {
            const memberDoc = await this.resolveDID(memberDID, { confirm: true });
            const memberPublicJwk = this.getPublicKeyJwk(memberDoc);
            const memberKey = this.cipher.encryptMessage(memberPublicJwk, privateJwk, JSON.stringify(privateJwk));
            const memberKeyId = this._vault_generateSaltedId(vault, memberDID);
            vault.keys[memberKeyId] = memberKey;
        }

        async _vault_checkVaultVersion(vaultId: string, vault: Vault): Promise<void> {
            if (vault.version === 1) {
                return;
            }

            if (!vault.version) {
                const id = await this.fetchIdInfo();
                const { privateJwk, members } = await this._vault_decryptVault(vault);

                vault.version = 1;
                vault.keys = {};

                await this._vault_addMemberKey(vault, id.did, privateJwk);

                for (const memberDID of Object.keys(members)) {
                    await this._vault_addMemberKey(vault, memberDID, privateJwk);
                }

                await this.updateAsset(vaultId, { vault });
                return;
            }

            throw new KeymasterError('Unsupported vault version');
        }

        async _vault_getMimeType(buffer: Buffer): Promise<string> {
            // Try magic number detection
            const result = await fileTypeFromBuffer(buffer);
            if (result) return result.mime;

            // Convert to UTF-8 string if decodable
            const text = buffer.toString('utf8');

            // Check for JSON
            try {
                JSON.parse(text);
                return 'application/json';
            } catch { }

            // Default to plain text if printable ASCII
            // eslint-disable-next-line
            if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(text.replace(/\n/g, ''))) {
                return 'text/plain';
            }

            // Fallback
            return 'application/octet-stream';
        }
    };
}
