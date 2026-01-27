import {
    InvalidParameterError,
} from '@didcid/common/errors';
import {
    DidCidDocument,
    ResolveDIDOptions,
} from '@didcid/gatekeeper/types';
import {
    DmailItem,
    DmailMessage,
    IDInfo,
    NoticeMessage,
    VaultOptions,
    WalletFile,
} from '@didcid/keymaster/types';

// Type for constructors
type Constructor<T = {}> = new (...args: any[]) => T;

export enum DmailTags {
    DMAIL = 'dmail',
    INBOX = 'inbox',
    DRAFT = 'draft',
    SENT = 'sent',
    ARCHIVED = 'archived',
    DELETED = 'deleted',
    UNREAD = 'unread',
}

// Interface describing the base class requirements for DmailMixin
// Note: This extends what VaultMixin provides
export interface DmailMixinRequirements {
    // Core methods
    loadWallet(): Promise<WalletFile>;
    fetchIdInfo(id?: string, wallet?: WalletFile): Promise<IDInfo>;
    resolveDID(did: string, options?: ResolveDIDOptions): Promise<DidCidDocument>;
    listNames(options?: { includeIDs?: boolean }): Promise<Record<string, string>>;
    validateName(name: string, wallet?: WalletFile): string;
    testAgent(did: string): Promise<boolean>;
    mutateWallet(mutator: (wallet: WalletFile) => void | Promise<void>): Promise<void>;
    createNotice(message: NoticeMessage, options?: any): Promise<string | null>;
    ephemeralRegistry: string;
    verifyRecipientList(list: string[]): Promise<string[]>;
    verifyTagList(tags: string[]): string[];

    // Vault methods (provided by VaultMixin)
    createVault(options?: VaultOptions): Promise<string>;
    addVaultMember(vaultId: string, memberId: string): Promise<boolean>;
    addVaultItem(vaultId: string, name: string, buffer: Buffer): Promise<boolean>;
    removeVaultItem(vaultId: string, name: string): Promise<boolean>;
    listVaultItems(vaultId: string, options?: ResolveDIDOptions): Promise<Record<string, any>>;
    getVaultItem(vaultId: string, name: string, options?: ResolveDIDOptions): Promise<Buffer | null>;
    testVault(id: string, options?: ResolveDIDOptions): Promise<boolean>;
}

export function DmailMixin<TBase extends Constructor<DmailMixinRequirements>>(Base: TBase) {
    return class DmailImpl extends Base {
        // ==================== Public Dmail Methods ====================

        async listDmail(): Promise<Record<string, DmailItem>> {
            const wallet = await this.loadWallet();
            const id = await this.fetchIdInfo(undefined, wallet);
            const list = id.dmail || {};
            const dmailList: Record<string, DmailItem> = {};
            const nameList = await this.listNames({ includeIDs: true });
            const didToName: Record<string, string> = Object.entries(nameList).reduce((acc, [name, did]) => {
                acc[did] = name;
                return acc;
            }, {} as Record<string, string>);

            for (const did of Object.keys(list)) {
                const message = await this.getDmailMessage(did);

                if (!message) {
                    continue;
                }

                const tags = list[did].tags ?? [];
                const docs = await this.resolveDID(did);
                const controller = docs.didDocument?.controller ?? '';
                const sender = didToName[controller] ?? controller;
                const date = docs.didDocumentMetadata?.updated ?? '';
                const to = message.to.map(did => didToName[did] ?? did);
                const cc = message.cc.map(did => didToName[did] ?? did);
                const attachments = await this.listDmailAttachments(did);

                dmailList[did] = {
                    message,
                    to,
                    cc,
                    tags,
                    sender,
                    date,
                    attachments,
                    docs,
                };
            }

            return dmailList;
        }

        async fileDmail(did: string, tags: string[]): Promise<boolean> {
            const verifiedTags = this.verifyTagList(tags);
            await this.mutateWallet(async (wallet) => {
                const id = await this.fetchIdInfo(undefined, wallet);
                if (!id.dmail) {
                    id.dmail = {};
                }
                id.dmail[did] = { tags: verifiedTags };
            });
            return true;
        }

        async removeDmail(did: string): Promise<boolean> {
            await this.mutateWallet(async (wallet) => {
                const id = await this.fetchIdInfo(undefined, wallet);
                if (!id.dmail || !id.dmail[did]) {
                    return;
                }
                delete id.dmail[did];
            });
            return true;
        }

        async verifyDmail(message: DmailMessage): Promise<DmailMessage> {
            const to = await this.verifyRecipientList(message.to);
            const cc = await this.verifyRecipientList(message.cc);

            if (to.length === 0) {
                throw new InvalidParameterError('dmail.to');
            }

            if (!message.subject || typeof message.subject !== 'string' || message.subject.trim() === '') {
                throw new InvalidParameterError('dmail.subject');
            }

            if (!message.body || typeof message.body !== 'string' || message.body.trim() === '') {
                throw new InvalidParameterError('dmail.body');
            }

            return {
                ...message,
                to,
                cc,
            };
        }

        async createDmail(message: DmailMessage, options: VaultOptions = {}): Promise<string> {
            const dmail = await this.verifyDmail(message);
            // Vault methods come from VaultMixin - they're on 'this' via mixin composition
            const did = await this.createVault(options);

            for (const toDID of dmail.to) {
                await this.addVaultMember(did, toDID);
            }

            for (const ccDID of dmail.cc) {
                await this.addVaultMember(did, ccDID);
            }

            const buffer = Buffer.from(JSON.stringify({ dmail }), 'utf-8');
            await this.addVaultItem(did, DmailTags.DMAIL, buffer);
            await this.fileDmail(did, [DmailTags.DRAFT]);

            return did;
        }

        async updateDmail(did: string, message: DmailMessage): Promise<boolean> {
            const dmail = await this.verifyDmail(message);

            for (const toDID of dmail.to) {
                await this.addVaultMember(did, toDID);
            }

            for (const ccDID of dmail.cc) {
                await this.addVaultMember(did, ccDID);
            }

            const buffer = Buffer.from(JSON.stringify({ dmail }), 'utf-8');
            return this.addVaultItem(did, DmailTags.DMAIL, buffer);
        }

        async sendDmail(did: string): Promise<string | null> {
            const dmail = await this.getDmailMessage(did);

            if (!dmail) {
                return null;
            }

            const registry = this.ephemeralRegistry;
            const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
            const message: NoticeMessage = {
                to: [...dmail.to, ...dmail.cc],
                dids: [did],
            };

            const notice = await this.createNotice(message, { registry, validUntil });

            if (notice) {
                await this.fileDmail(did, [DmailTags.SENT]);
            }

            return notice;
        }

        async getDmailMessage(did: string, options?: ResolveDIDOptions): Promise<DmailMessage | null> {
            const isVault = await this.testVault(did, options);

            if (!isVault) {
                return null;
            }

            const buffer = await this.getVaultItem(did, DmailTags.DMAIL, options);

            if (!buffer) {
                return null;
            }

            try {
                const data = JSON.parse(buffer.toString('utf-8'));
                return data.dmail as DmailMessage;
            }
            catch (error) {
                return null;
            }
        }

        async listDmailAttachments(did: string, options?: ResolveDIDOptions): Promise<Record<string, any>> {
            let items = await this.listVaultItems(did, options);
            delete items[DmailTags.DMAIL];
            return items;
        }

        async addDmailAttachment(did: string, name: string, buffer: Buffer): Promise<boolean> {
            if (name === DmailTags.DMAIL) {
                throw new InvalidParameterError('Cannot add attachment with reserved name "dmail"');
            }
            return this.addVaultItem(did, name, buffer);
        }

        async removeDmailAttachment(did: string, name: string): Promise<boolean> {
            if (name === DmailTags.DMAIL) {
                throw new InvalidParameterError('Cannot remove attachment with reserved name "dmail"');
            }
            return this.removeVaultItem(did, name);
        }

        async getDmailAttachment(did: string, name: string): Promise<Buffer | null> {
            return this.getVaultItem(did, name);
        }

        async importDmail(did: string): Promise<boolean> {
            const dmail = await this.getDmailMessage(did);

            if (!dmail) {
                return false;
            }

            return this.fileDmail(did, [DmailTags.INBOX, DmailTags.UNREAD]);
        }
    };
}
