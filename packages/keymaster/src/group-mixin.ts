import {
    InvalidParameterError,
} from '@didcid/common/errors';
import {
    ResolveDIDOptions,
} from '@didcid/gatekeeper/types';
import {
    CreateAssetOptions,
    Group,
} from '@didcid/keymaster/types';

// Type for constructors
type Constructor<T = {}> = new (...args: any[]) => T;

// Interface describing the base class requirements for GroupMixin
export interface GroupMixinRequirements {
    createAsset(data: unknown, options?: CreateAssetOptions): Promise<string>;
    resolveAsset(did: string, options?: ResolveDIDOptions): Promise<any>;
    updateAsset(did: string, data: Record<string, unknown>): Promise<boolean>;
    lookupDID(name: string): Promise<string>;
    resolveDID(did: string, options?: ResolveDIDOptions): Promise<any>;
    listAssets(owner?: string): Promise<string[]>;
}

export function GroupMixin<TBase extends Constructor<GroupMixinRequirements>>(Base: TBase) {
    return class GroupImpl extends Base {
        async createGroup(
            name: string,
            options: CreateAssetOptions = {}
        ): Promise<string> {
            const group = {
                name: name,
                members: []
            };

            return this.createAsset({ group }, options);
        }

        async getGroup(id: string): Promise<Group | null> {
            const asset = await this.resolveAsset(id);
            if (!asset) {
                return null;
            }

            // TEMP during did:cid, return old version groups
            const castOldAsset = asset as Group;
            if (castOldAsset.members) {
                return castOldAsset;
            }

            const castAsset = asset as { group?: Group };
            if (!castAsset.group) {
                return null;
            }

            return castAsset.group;
        }

        async addGroupMember(
            groupId: string,
            memberId: string
        ): Promise<boolean> {
            const groupDID = await this.lookupDID(groupId);
            const memberDID = await this.lookupDID(memberId);

            // Can't add a group to itself
            if (memberDID === groupDID) {
                throw new InvalidParameterError("can't add a group to itself");
            }

            try {
                // test for valid member DID
                await this.resolveDID(memberDID);
            }
            catch {
                throw new InvalidParameterError('memberId');
            }

            const group = await this.getGroup(groupId);

            if (!group?.members) {
                throw new InvalidParameterError('groupId');
            }

            // If already a member, return immediately
            if (group.members.includes(memberDID)) {
                return true;
            }

            // Can't add a mutual membership relation
            const isMember = await this.testGroup(memberId, groupId);

            if (isMember) {
                throw new InvalidParameterError("can't create mutual membership");
            }

            const members = new Set(group.members);
            members.add(memberDID);
            group.members = Array.from(members);

            return this.updateAsset(groupDID, { group });
        }

        async removeGroupMember(
            groupId: string,
            memberId: string
        ): Promise<boolean> {
            const groupDID = await this.lookupDID(groupId);
            const memberDID = await this.lookupDID(memberId);
            const group = await this.getGroup(groupDID);

            if (!group?.members) {
                throw new InvalidParameterError('groupId');
            }

            try {
                // test for valid member DID
                await this.resolveDID(memberDID);
            }
            catch {
                throw new InvalidParameterError('memberId');
            }

            // If not already a member, return immediately
            if (!group.members.includes(memberDID)) {
                return true;
            }

            const members = new Set(group.members);
            members.delete(memberDID);
            group.members = Array.from(members);

            return this.updateAsset(groupDID, { group });
        }

        async testGroup(
            groupId: string,
            memberId?: string
        ): Promise<boolean> {
            try {
                const group = await this.getGroup(groupId);

                if (!group) {
                    return false;
                }

                if (!memberId) {
                    return true;
                }

                const didMember = await this.lookupDID(memberId);
                let isMember = group.members.includes(didMember);

                if (!isMember) {
                    for (const did of group.members) {
                        isMember = await this.testGroup(did, didMember);

                        if (isMember) {
                            break;
                        }
                    }
                }

                return isMember;
            }
            catch (error) {
                return false;
            }
        }

        async listGroups(owner?: string): Promise<string[]> {
            const assets = await this.listAssets(owner);
            const groups = [];

            for (const did of assets) {
                const isGroup = await this.testGroup(did);

                if (isGroup) {
                    groups.push(did);
                }
            }

            return groups;
        }
    };
}
