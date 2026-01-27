import {
    KeymasterError,
} from '@didcid/common/errors';
import {
    GatekeeperInterface,
    ResolveDIDOptions,
} from '@didcid/gatekeeper/types';
import {
    DmailMessage,
    IDInfo,
    NoticeMessage,
    Poll,
    WalletFile,
} from '@didcid/keymaster/types';

// Type for constructors
type Constructor<T = {}> = new (...args: any[]) => T;

export enum NoticeTags {
    DMAIL = 'dmail',
    BALLOT = "ballot",
    POLL = "poll",
    CREDENTIAL = "credential",
}

// Interface describing the base class requirements for NoticeMixin
export interface NoticeMixinRequirements {
    // Properties
    gatekeeper: GatekeeperInterface;

    // Base methods
    loadWallet(): Promise<WalletFile>;
    fetchIdInfo(id?: string, wallet?: WalletFile): Promise<IDInfo>;
    mutateWallet(mutator: (wallet: WalletFile) => void | Promise<void>): Promise<void>;
    resolveAsset(did: string, options?: ResolveDIDOptions): Promise<any>;
    verifyTagList(tags: string[]): string[];
    listNames(options?: { includeIDs?: boolean }): Promise<Record<string, string>>;
    addName(name: string, did: string): Promise<boolean>;
    addToNotices(did: string, tags: string[]): Promise<boolean>;

    // Encryption methods
    decryptJSON(did: string): Promise<unknown>;

    // Dmail methods (from DmailMixin)
    getDmailMessage(did: string, options?: ResolveDIDOptions): Promise<DmailMessage | null>;
    importDmail(did: string): Promise<boolean>;

    // Poll methods (from PollMixin)
    getPoll(id: string): Promise<Poll | null>;
    updatePoll(ballot: string): Promise<boolean>;

    // Credential methods (from CredentialMixin)
    acceptCredential(did: string): Promise<boolean>;
}

export function NoticeMixin<TBase extends Constructor<NoticeMixinRequirements>>(Base: TBase) {
    return class NoticeImpl extends Base {
        // Basic notice methods (verifyDIDList, verifyNotice, createNotice, updateNotice, addToNotices)
        // are provided by KeymasterBase

        async _notice_isBallot(ballotDid: string): Promise<boolean> {
            let payload: any;
            try {
                payload = await this.decryptJSON(ballotDid);
            } catch {
                return false;
            }

            return payload && typeof payload.poll === "string" && typeof payload.vote === "number";
        }

        async _notice_addUnnamedPoll(did: string): Promise<void> {
            const fallbackName = did.slice(-32);
            try {
                await this.addName(fallbackName, did);
            } catch { }
        }

        async importNotice(did: string): Promise<boolean> {
            const wallet = await this.loadWallet();
            const id = await this.fetchIdInfo(undefined, wallet);

            if (id.notices && id.notices[did]) {
                return true; // Already imported
            }

            const asset = await this.resolveAsset(did) as { notice?: NoticeMessage };

            if (!asset || !asset.notice) {
                return false; // Not a notice
            }

            if (!asset.notice.to.includes(id.did)) {
                return false; // Not for this user
            }

            for (const noticeDID of asset.notice.dids) {
                const dmail = await this.getDmailMessage(noticeDID);

                if (dmail) {
                    const imported = await this.importDmail(noticeDID);

                    if (imported) {
                        await this.addToNotices(did, [NoticeTags.DMAIL]);
                    }

                    continue;
                }

                const isBallot = await this._notice_isBallot(noticeDID);

                if (isBallot) {
                    let imported = false;
                    try {
                        imported = await this.updatePoll(noticeDID);
                    } catch { }

                    if (imported) {
                        await this.addToNotices(did, [NoticeTags.BALLOT]);
                    }

                    continue;
                }

                const poll = await this.getPoll(noticeDID);

                if (poll) {
                    const names = await this.listNames();
                    if (!Object.values(names).includes(noticeDID)) {
                        await this._notice_addUnnamedPoll(noticeDID);
                    }
                    await this.addToNotices(did, [NoticeTags.POLL]);

                    continue;
                }

                const isCredential = await this.acceptCredential(noticeDID);

                if (isCredential) {
                    await this.addToNotices(did, [NoticeTags.CREDENTIAL]);
                    continue;
                }

                return false;
            }

            return true;
        }

        async searchNotices(): Promise<boolean> {
            const id = await this.fetchIdInfo();

            if (!id.notices) {
                id.notices = {};
            }

            // Search for all notice DIDs sent to the current ID
            const where = {
                "notice.to[*]": {
                    "$in": [id.did]
                }
            };

            let notices;

            try {
                // TBD search engine should not return expired notices
                notices = await this.gatekeeper.search({ where });
            }
            catch (error) {
                throw new KeymasterError('Failed to search for notices');
            }

            for (const notice of notices) {
                if (notice in id.notices) {
                    continue; // Already imported
                }

                try {
                    await this.importNotice(notice);
                } catch (error) {
                    continue; // Skip if notice is expired or invalid
                }
            }

            return true;
        }

        async cleanupNotices(): Promise<boolean> {
            await this.mutateWallet(async (wallet) => {
                const id = await this.fetchIdInfo(undefined, wallet);
                if (!id.notices) {
                    return;
                }

                for (const nDid of Object.keys(id.notices)) {
                    try {
                        const asset = await this.resolveAsset(nDid) as { notice?: NoticeMessage };
                        if (!asset || !asset.notice) {
                            delete id.notices[nDid]; // revoked or invalid
                        }
                    } catch {
                        delete id.notices[nDid]; // expired/unresolvable
                    }
                }
            });
            return true;
        }

        async refreshNotices(): Promise<boolean> {
            await this.searchNotices();
            return this.cleanupNotices();
        }
    };
}
