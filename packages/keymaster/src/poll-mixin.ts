import {
    InvalidParameterError,
    KeymasterError,
} from '@didcid/common/errors';
import {
    DidCidDocument,
    ResolveDIDOptions,
} from '@didcid/gatekeeper/types';
import {
    CreateAssetOptions,
    EncryptOptions,
    Group,
    IDInfo,
    Poll,
    PollResults,
    ViewPollResult,
} from '@didcid/keymaster/types';

// Type for constructors
type Constructor<T = {}> = new (...args: any[]) => T;

// Interface describing the base class requirements for PollMixin
export interface PollMixinRequirements {
    // Base methods
    fetchIdInfo(id?: string): Promise<IDInfo>;
    lookupDID(name: string): Promise<string>;
    resolveDID(did: string, options?: ResolveDIDOptions): Promise<DidCidDocument>;
    resolveAsset(did: string, options?: ResolveDIDOptions): Promise<any>;
    createAsset(data: unknown, options?: CreateAssetOptions): Promise<string>;
    updateAsset(did: string, data: Record<string, unknown>): Promise<boolean>;
    listAssets(owner?: string): Promise<string[]>;

    // Encryption methods (from base or EncryptionMixin)
    encryptJSON(json: unknown, did: string, options?: EncryptOptions): Promise<string>;
    decryptJSON(did: string): Promise<unknown>;

    // Group methods (from GroupMixin)
    testGroup(groupId: string, memberId?: string): Promise<boolean>;
    getGroup(id: string): Promise<Group | null>;
}

export function PollMixin<TBase extends Constructor<PollMixinRequirements>>(Base: TBase) {
    return class PollImpl extends Base {
        async pollTemplate(): Promise<Poll> {
            const now = new Date();
            const nextWeek = new Date();
            nextWeek.setDate(now.getDate() + 7);

            return {
                type: 'poll',
                version: 1,
                description: 'What is this poll about?',
                roster: 'DID of the eligible voter group',
                options: ['yes', 'no', 'abstain'],
                deadline: nextWeek.toISOString(),
            };
        }

        async createPoll(
            poll: Poll,
            options: CreateAssetOptions = {}
        ): Promise<string> {
            if (poll.type !== 'poll') {
                throw new InvalidParameterError('poll');
            }

            if (poll.version !== 1) {
                throw new InvalidParameterError('poll.version');
            }

            if (!poll.description) {
                throw new InvalidParameterError('poll.description');
            }

            if (!poll.options || !Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 10) {
                throw new InvalidParameterError('poll.options');
            }

            if (!poll.roster) {
                // eslint-disable-next-line
                throw new InvalidParameterError('poll.roster');
            }

            try {
                const isValidGroup = await this.testGroup(poll.roster);

                if (!isValidGroup) {
                    throw new InvalidParameterError('poll.roster');
                }
            }
            catch {
                throw new InvalidParameterError('poll.roster');
            }

            if (!poll.deadline) {
                // eslint-disable-next-line
                throw new InvalidParameterError('poll.deadline');
            }

            const deadline = new Date(poll.deadline);

            if (isNaN(deadline.getTime())) {
                throw new InvalidParameterError('poll.deadline');
            }

            if (deadline < new Date()) {
                throw new InvalidParameterError('poll.deadline');
            }

            return this.createAsset({ poll }, options);
        }

        async getPoll(id: string): Promise<Poll | null> {
            const asset = await this.resolveAsset(id);

            // TEMP during did:cid, return old version poll
            const castOldAsset = asset as Poll;
            if (castOldAsset.options) {
                return castOldAsset;
            }

            const castAsset = asset as { poll?: Poll };
            if (!castAsset.poll) {
                return null;
            }

            return castAsset.poll;
        }

        async testPoll(id: string): Promise<boolean> {
            try {
                const poll = await this.getPoll(id);
                return poll !== null;
            }
            catch (error) {
                return false;
            }
        }

        async listPolls(owner?: string): Promise<string[]> {
            const assets = await this.listAssets(owner);
            const polls: string[] = [];

            for (const did of assets) {
                const isPoll = await this.testPoll(did);

                if (isPoll) {
                    polls.push(did);
                }
            }

            return polls;
        }

        async viewPoll(pollId: string): Promise<ViewPollResult> {
            const id = await this.fetchIdInfo();
            const poll = await this.getPoll(pollId);

            if (!poll) {
                throw new InvalidParameterError('pollId');
            }

            let hasVoted = false;

            if (poll.ballots) {
                hasVoted = !!poll.ballots[id.did];
            }

            const voteExpired = Date.now() > new Date(poll.deadline).getTime();
            const isEligible = await this.testGroup(poll.roster, id.did);
            const doc = await this.resolveDID(pollId);

            const view: ViewPollResult = {
                description: poll.description,
                options: poll.options,
                deadline: poll.deadline,
                isOwner: (doc.didDocument?.controller === id.did),
                isEligible: isEligible,
                voteExpired: voteExpired,
                hasVoted: hasVoted,
            };

            if (id.did === doc.didDocument?.controller) {
                let voted = 0;

                const results: PollResults = {
                    tally: [],
                    ballots: [],
                }

                results.tally.push({
                    vote: 0,
                    option: 'spoil',
                    count: 0,
                });

                for (let i = 0; i < poll.options.length; i++) {
                    results.tally.push({
                        vote: i + 1,
                        option: poll.options[i],
                        count: 0,
                    });
                }

                const ballots = poll.ballots ?? {};
                for (const voter in ballots) {
                    const ballot = ballots[voter];
                    const decrypted = await this.decryptJSON(ballot.ballot);
                    const vote = (decrypted as { vote: number }).vote;
                    if (results.ballots) {
                        results.ballots.push({
                            ...ballot,
                            voter,
                            vote,
                            option: poll.options[vote - 1],
                        });
                    }
                    voted += 1;
                    results.tally[vote].count += 1;
                }

                const roster = await this.getGroup(poll.roster);
                const total = roster!.members.length;

                results.votes = {
                    eligible: total,
                    received: voted,
                    pending: total - voted,
                };
                results.final = voteExpired || (voted === total);

                view.results = results;
            }

            return view;
        }

        async votePoll(
            pollId: string,
            vote: number,
            options: { spoil?: boolean; registry?: string; validUntil?: string } = {}
        ): Promise<string> {
            const { spoil = false } = options;

            const id = await this.fetchIdInfo();
            const didPoll = await this.lookupDID(pollId);
            const doc = await this.resolveDID(didPoll);
            const poll = await this.getPoll(pollId);
            if (!poll) {
                throw new InvalidParameterError('pollId');
            }

            const eligible = await this.testGroup(poll.roster, id.did);
            const expired = Date.now() > new Date(poll.deadline).getTime();
            const owner = doc.didDocument?.controller;

            if (!owner) {
                throw new KeymasterError('owner mising from poll');
            }

            if (!eligible) {
                throw new InvalidParameterError('voter not in roster');
            }

            if (expired) {
                throw new InvalidParameterError('poll has expired');
            }

            let ballot;

            if (spoil) {
                ballot = {
                    poll: didPoll,
                    vote: 0,
                };
            }
            else {
                const max = poll.options.length;

                if (!Number.isInteger(vote) || vote < 1 || vote > max) {
                    throw new InvalidParameterError('vote');
                }

                ballot = {
                    poll: didPoll,
                    vote: vote,
                };
            }

            // Encrypt for receiver only
            return await this.encryptJSON(ballot, owner, { ...options, encryptForSender: false });
        }

        async updatePoll(ballot: string): Promise<boolean> {
            const id = await this.fetchIdInfo();

            const didBallot = await this.lookupDID(ballot);
            const docBallot = await this.resolveDID(ballot);
            const didVoter = docBallot.didDocument!.controller!;
            let dataBallot: { poll: string; vote: number };

            try {
                dataBallot = await this.decryptJSON(didBallot) as { poll: string; vote: number };

                if (!dataBallot.poll || !dataBallot.vote) {
                    throw new InvalidParameterError('ballot');
                }
            }
            catch {
                throw new InvalidParameterError('ballot');
            }

            const didPoll = dataBallot.poll;
            const docPoll = await this.resolveDID(didPoll);
            const didOwner = docPoll.didDocument!.controller!;
            const poll = await this.getPoll(didPoll);

            if (!poll) {
                throw new KeymasterError('Cannot find poll related to ballot');
            }

            if (id.did !== didOwner) {
                throw new InvalidParameterError('only owner can update a poll');
            }

            const eligible = await this.testGroup(poll.roster, didVoter);

            if (!eligible) {
                throw new InvalidParameterError('voter not in roster');
            }

            const expired = Date.now() > new Date(poll.deadline).getTime();

            if (expired) {
                throw new InvalidParameterError('poll has expired');
            }

            const max = poll.options.length;
            const vote = dataBallot.vote;

            if (!vote || vote < 0 || vote > max) {
                throw new InvalidParameterError('ballot.vote');
            }

            if (!poll.ballots) {
                poll.ballots = {};
            }

            poll.ballots[didVoter] = {
                ballot: didBallot,
                received: new Date().toISOString(),
            };

            return this.updateAsset(didPoll, { poll });
        }

        async publishPoll(
            pollId: string,
            options: { reveal?: boolean } = {}
        ): Promise<boolean> {
            const { reveal = false } = options;

            const id = await this.fetchIdInfo();
            const doc = await this.resolveDID(pollId);
            const owner = doc.didDocument?.controller;

            if (id.did !== owner) {
                throw new InvalidParameterError('only owner can publish a poll');
            }

            const view = await this.viewPoll(pollId);

            if (!view.results?.final) {
                throw new InvalidParameterError('poll not final');
            }

            if (!reveal && view.results.ballots) {
                delete view.results.ballots;
            }

            const poll = await this.getPoll(pollId);

            if (!poll) {
                throw new InvalidParameterError(pollId);
            }

            poll.results = view.results;

            return this.updateAsset(pollId, { poll });
        }

        async unpublishPoll(pollId: string): Promise<boolean> {
            const id = await this.fetchIdInfo();
            const doc = await this.resolveDID(pollId);
            const owner = doc.didDocument?.controller;

            if (id.did !== owner) {
                throw new InvalidParameterError(pollId);
            }

            const poll = await this.getPoll(pollId);

            if (!poll) {
                throw new InvalidParameterError(pollId);
            }

            delete poll.results;

            return this.updateAsset(pollId, { poll });
        }
    };
}
