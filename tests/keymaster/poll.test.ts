import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import { ExpectedExceptionError } from '@didcid/common/errors';
import HeliaClient from '@didcid/ipfs/helia';

let ipfs: HeliaClient;
let gatekeeper: Gatekeeper;
let ownerWallet: WalletJsonMemory;
let voterWallet: WalletJsonMemory;
let cipher: CipherNode;
let owner: Keymaster;
let voter: Keymaster;

beforeAll(async () => {
    ipfs = new HeliaClient();
    await ipfs.start();
});

afterAll(async () => {
    if (ipfs) {
        await ipfs.stop();
    }
});

beforeEach(() => {
    const db = new DbJsonMemory('test');
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm', 'BTC:signet'] });
    cipher = new CipherNode();
    ownerWallet = new WalletJsonMemory();
    voterWallet = new WalletJsonMemory();
    owner = new Keymaster({ gatekeeper, wallet: ownerWallet, cipher, passphrase: 'owner' });
    voter = new Keymaster({ gatekeeper, wallet: voterWallet, cipher, passphrase: 'voter' });
});

describe('pollTemplate', () => {
    it('should return a poll template', async () => {
        const template = await owner.pollTemplate();

        const expectedTemplate = {
            type: 'poll',
            version: 2,
            description: 'What is this poll about?',
            options: ['yes', 'no', 'abstain'],
            deadline: expect.any(String),
        };

        expect(template).toStrictEqual(expectedTemplate);
    });
});

describe('createPoll', () => {
    it('should create a poll from a valid template', async () => {
        await owner.createId('Bob');
        const template = await owner.pollTemplate();

        const pollDid = await owner.createPoll(template);
        const config = await owner.getPoll(pollDid);

        expect(config).toStrictEqual(template);
    });

    it('should not create a poll from an invalid template', async () => {
        await owner.createId('Bob');
        const template = await owner.pollTemplate();

        try {
            const poll = JSON.parse(JSON.stringify(template));
            poll.type = "wrong type";
            await owner.createPoll(poll);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: poll');
        }

        try {
            const poll = JSON.parse(JSON.stringify(template));
            poll.version = 0;
            await owner.createPoll(poll);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: poll.version');
        }

        try {
            const poll = JSON.parse(JSON.stringify(template));
            delete poll.description;
            await owner.createPoll(poll);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: poll.description');
        }

        try {
            const poll = JSON.parse(JSON.stringify(template));
            delete poll.options;
            await owner.createPoll(poll);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: poll.options');
        }

        try {
            const poll = JSON.parse(JSON.stringify(template));
            poll.options = ['one option'];
            await owner.createPoll(poll);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: poll.options');
        }

        try {
            const poll = JSON.parse(JSON.stringify(template));
            poll.options = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
            await owner.createPoll(poll);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: poll.options');
        }

        try {
            const poll = JSON.parse(JSON.stringify(template));
            poll.options = "not a list";
            await owner.createPoll(poll);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: poll.options');
        }

        try {
            const poll = JSON.parse(JSON.stringify(template));
            delete poll.deadline;
            await owner.createPoll(poll);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: poll.deadline');
        }

        try {
            const poll = JSON.parse(JSON.stringify(template));
            poll.deadline = "not a date";
            await owner.createPoll(poll);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: poll.deadline');
        }

        try {
            const poll = JSON.parse(JSON.stringify(template));
            const now = new Date();
            const lastWeek = new Date();
            lastWeek.setDate(now.getDate() - 7);
            poll.deadline = lastWeek.toISOString();
            await owner.createPoll(poll);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: poll.deadline');
        }
    });
});

describe('testPoll', () => {
    it('should return true only for a poll DID', async () => {
        const agentDid = await owner.createId('Bob');
        const template = await owner.pollTemplate();

        const pollDid = await owner.createPoll(template);
        let isPoll = await owner.testPoll(pollDid);
        expect(isPoll).toBe(true);

        isPoll = await owner.testPoll(agentDid);
        expect(isPoll).toBe(false);

        // @ts-expect-error Testing invalid usage, missing arg
        isPoll = await owner.testPoll();
        expect(isPoll).toBe(false);

        // @ts-expect-error Testing invalid usage, missing arg
        isPoll = await owner.testPoll(100);
        expect(isPoll).toBe(false);

        isPoll = await owner.testPoll('did:cid:mock');
        expect(isPoll).toBe(false);
    });
});

describe('listPolls', () => {
    it('should return list of polls', async () => {
        await owner.createId('Bob');
        const template = await owner.pollTemplate();

        const poll1 = await owner.createPoll(template);
        const poll2 = await owner.createPoll(template);
        const poll3 = await owner.createPoll(template);
        const schema1 = await owner.createSchema();

        const polls = await owner.listPolls();

        expect(polls.includes(poll1)).toBe(true);
        expect(polls.includes(poll2)).toBe(true);
        expect(polls.includes(poll3)).toBe(true);
        expect(polls.includes(schema1)).toBe(false);
    });
});

describe('getPoll', () => {
    it('should return the specified poll config', async () => {
        await owner.createId('Bob');
        const template = await owner.pollTemplate();

        const pollDid = await owner.createPoll(template);
        const config = await owner.getPoll(pollDid);

        expect(config).toStrictEqual(template);
    });

    it('should return null if non-poll DID specified', async () => {
        const agentDID = await owner.createId('Bob');
        const config = await owner.getPoll(agentDID);

        expect(config).toBe(null);
    });

    it('should return null for a plain vault without poll config', async () => {
        await owner.createId('Bob');
        const vaultDid = await owner.createVault();
        const config = await owner.getPoll(vaultDid);

        expect(config).toBe(null);
    });

    it('should return null if no poll DID specified', async () => {
        // @ts-expect-error Testing invalid usage, missing arg
        const config = await owner.getPoll();
        expect(config).toBe(null);
    });
});

describe('addPollMember', () => {
    it('should add a member to the poll', async () => {
        await owner.createId('Bob');
        const aliceDid = await voter.createId('Alice');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        const ok = await owner.addPollMember(pollDid, aliceDid);
        expect(ok).toBe(true);

        const members = await owner.listPollMembers(pollDid);
        expect(members[aliceDid]).toBeDefined();
    });

    it('should throw on invalid poll id', async () => {
        const bobDid = await owner.createId('Bob');

        try {
            await owner.addPollMember(bobDid, bobDid);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: pollId');
        }
    });
});

describe('removePollMember', () => {
    it('should remove a member from the poll', async () => {
        await owner.createId('Bob');
        const aliceDid = await voter.createId('Alice');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        await owner.addPollMember(pollDid, aliceDid);
        const ok = await owner.removePollMember(pollDid, aliceDid);
        expect(ok).toBe(true);

        const members = await owner.listPollMembers(pollDid);
        expect(members[aliceDid]).toBeUndefined();
    });

    it('should throw on invalid poll id', async () => {
        const bobDid = await owner.createId('Bob');

        try {
            await owner.removePollMember(bobDid, bobDid);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: pollId');
        }
    });
});

describe('listPollMembers', () => {
    it('should list all poll members', async () => {
        await owner.createId('Bob');
        const aliceDid = await voter.createId('Alice');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        await owner.addPollMember(pollDid, aliceDid);
        const members = await owner.listPollMembers(pollDid);

        expect(Object.keys(members)).toContain(aliceDid);
    });

    it('should return empty members for a new poll', async () => {
        await owner.createId('Bob');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        const members = await owner.listPollMembers(pollDid);
        expect(Object.keys(members).length).toBe(0);
    });

    it('should throw on invalid poll id', async () => {
        const bobDid = await owner.createId('Bob');

        try {
            await owner.listPollMembers(bobDid);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: pollId');
        }
    });
});

describe('viewPoll', () => {
    it('should return a valid view for the owner', async () => {
        await owner.createId('Bob');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        const view = await owner.viewPoll(pollDid);

        expect(view.deadline).toBe(template.deadline);
        expect(view.description).toBe(template.description);
        expect(view.options).toStrictEqual(template.options);
        expect(view.hasVoted).toBe(false);
        expect(view.isEligible).toBe(true);
        expect(view.isOwner).toBe(true);
        expect(view.voteExpired).toBe(false);
        expect(view.results!.ballots).toStrictEqual([]);
        expect(view.results!.tally.length).toBe(4);
        expect(view.results!.votes!.eligible).toBe(1);
        expect(view.results!.votes!.pending).toBe(1);
        expect(view.results!.votes!.received).toBe(0);
        expect(view.results!.final).toBe(false);
    });

    it('should show voter as eligible when added as member', async () => {
        await owner.createId('Bob');
        const aliceDid = await voter.createId('Alice');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);
        await owner.addPollMember(pollDid, aliceDid);

        const view = await voter.viewPoll(pollDid);

        expect(view.isEligible).toBe(true);
        expect(view.isOwner).toBe(false);
        expect(view.hasVoted).toBe(false);
    });

    it('should throw when non-member tries to view poll', async () => {
        await owner.createId('Bob');
        await voter.createId('Alice');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        try {
            await voter.viewPoll(pollDid);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: pollId');
        }
    });

    it('should throw on invalid poll id', async () => {
        const did = await owner.createId('Bob');

        try {
            await owner.viewPoll(did);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: pollId');
        }
    });
});

describe('votePoll', () => {
    it('should return a valid ballot for the owner', async () => {
        await owner.createId('Bob');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        const ballotDid = await owner.votePoll(pollDid, 1);
        const ballot = await owner.decryptJSON(ballotDid);

        expect(ballot).toStrictEqual({
            poll: pollDid,
            vote: 1,
        });
    });

    it('should return a valid ballot for a vault member', async () => {
        await owner.createId('Bob');
        const aliceDid = await voter.createId('Alice');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);
        await owner.addPollMember(pollDid, aliceDid);

        const ballotDid = await voter.votePoll(pollDid, 2);

        // The ballot is encrypted for the owner, so voter cannot decrypt it
        // but we can verify it was created
        expect(ballotDid).toBeDefined();
    });

    it('should allow a spoiled ballot', async () => {
        await owner.createId('Bob');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        const ballotDid = await owner.votePoll(pollDid, 1, { spoil: true });
        const ballot = await owner.decryptJSON(ballotDid);

        expect(ballot).toStrictEqual({
            poll: pollDid,
            vote: 0,
        });
    });

    it('should not return a ballot for an invalid vote', async () => {
        await owner.createId('Bob');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        try {
            await owner.votePoll(pollDid, 5);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: vote');
        }
    });

    it('should not return a ballot for an ineligible voter', async () => {
        await owner.createId('Bob');
        await voter.createId('Alice');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        try {
            await voter.votePoll(pollDid, 1);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: pollId');
        }
    });

    it('should throw on an invalid poll id', async () => {
        const did = await owner.createId('Bob');

        try {
            await owner.votePoll(did, 1);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: pollId');
        }
    });
});

describe('sendBallot', () => {
    it('should send a ballot notice to the poll owner', async () => {
        await owner.createId('Bob');
        const aliceDid = await voter.createId('Alice');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);
        await owner.addPollMember(pollDid, aliceDid);

        const ballotDid = await voter.votePoll(pollDid, 1);
        const noticeDid = await voter.sendBallot(ballotDid, pollDid);

        expect(noticeDid).toBeDefined();
    });

    it('should throw on invalid poll', async () => {
        const did = await owner.createId('Bob');

        try {
            await owner.sendBallot('fakeBallot', did);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBeDefined();
        }
    });
});

describe('viewBallot', () => {
    it('should return ballot details for the poll owner', async () => {
        await owner.createId('Bob');
        const aliceDid = await voter.createId('Alice');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);
        await owner.addPollMember(pollDid, aliceDid);

        const ballotDid = await voter.votePoll(pollDid, 2);
        const result = await owner.viewBallot(ballotDid);

        expect(result.poll).toBe(pollDid);
        expect(result.voter).toBe(aliceDid);
        expect(result.vote).toBe(2);
        expect(result.option).toBe('no');
    });

    it('should return limited info when caller cannot decrypt', async () => {
        await owner.createId('Bob');
        const aliceDid = await voter.createId('Alice');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);
        await owner.addPollMember(pollDid, aliceDid);

        const ballotDid = await voter.votePoll(pollDid, 1);

        // Voter cannot decrypt (ballot was encrypted for owner only)
        const result = await voter.viewBallot(ballotDid);

        expect(result.voter).toBe(aliceDid);
        expect(result.poll).toBe('');
        expect(result.vote).toBeUndefined();
    });
});

describe('updatePoll', () => {
    it('should update poll with valid ballot from owner', async () => {
        await owner.createId('Bob');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        const ballotDid = await owner.votePoll(pollDid, 1);
        const ok = await owner.updatePoll(ballotDid);

        expect(ok).toBe(true);
    });

    it('should update poll with ballot from a vault member', async () => {
        await owner.createId('Bob');
        const aliceDid = await voter.createId('Alice');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);
        await owner.addPollMember(pollDid, aliceDid);

        const ballotDid = await voter.votePoll(pollDid, 2);
        const ok = await owner.updatePoll(ballotDid);

        expect(ok).toBe(true);
    });

    it('should reject non-ballots', async () => {
        await owner.createId('Bob');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        try {
            await owner.updatePoll(pollDid);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: ballot');
        }
    });

    it('should throw on invalid ballot id', async () => {
        const bob = await owner.createId('Bob');
        const mockJson = { key: "value" };
        const did = await owner.encryptJSON(mockJson, bob);

        try {
            await owner.updatePoll(did);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toBe('Invalid parameter: ballot');
        }
    });

    it('should throw on invalid poll id in ballot', async () => {
        const bob = await owner.createId('Bob');
        const ballot = { poll: bob, vote: 1 };
        const did = await owner.encryptJSON(ballot, bob);

        try {
            await owner.updatePoll(did);
            throw new ExpectedExceptionError();
        }
        catch (error: any) {
            expect(error.message).toContain('Cannot find poll related to ballot');
        }
    });
});

describe('publishPoll', () => {
    it('should publish results to poll', async () => {
        await owner.createId('Bob');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        const ballotDid = await owner.votePoll(pollDid, 1);
        await owner.updatePoll(ballotDid);
        const ok = await owner.publishPoll(pollDid);

        expect(ok).toBe(true);

        const view = await owner.viewPoll(pollDid);
        expect(view.results!.final).toBe(true);
        expect(view.results!.votes!.eligible).toBe(1);
        expect(view.results!.votes!.pending).toBe(0);
        expect(view.results!.votes!.received).toBe(1);
        expect(view.results!.tally.length).toBe(4);
        expect(view.results!.tally[0]).toStrictEqual({
            vote: 0,
            option: 'spoil',
            count: 0,
        });
        expect(view.results!.tally[1]).toStrictEqual({
            vote: 1,
            option: 'yes',
            count: 1,
        });
        expect(view.results!.tally[2]).toStrictEqual({
            vote: 2,
            option: 'no',
            count: 0,
        });
        expect(view.results!.tally[3]).toStrictEqual({
            vote: 3,
            option: 'abstain',
            count: 0,
        });
    });

    it('should reveal ballots when requested', async () => {
        const bobDid = await owner.createId('Bob');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        const ballotDid = await owner.votePoll(pollDid, 1);
        await owner.updatePoll(ballotDid);
        const ok = await owner.publishPoll(pollDid, { reveal: true });

        expect(ok).toBe(true);

        const view = await owner.viewPoll(pollDid);
        expect(view.results!.ballots!.length).toBe(1);
        expect(view.results!.ballots![0]).toStrictEqual({
            voter: bobDid,
            vote: 1,
            option: 'yes',
            received: expect.any(String),
        });
    });

    it('should publish results with multiple voters', async () => {
        await owner.createId('Bob');
        const aliceDid = await voter.createId('Alice');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);
        await owner.addPollMember(pollDid, aliceDid);

        const bobBallot = await owner.votePoll(pollDid, 1);
        await owner.updatePoll(bobBallot);

        const aliceBallot = await voter.votePoll(pollDid, 2);
        await owner.updatePoll(aliceBallot);

        const ok = await owner.publishPoll(pollDid);
        expect(ok).toBe(true);

        const view = await owner.viewPoll(pollDid);
        expect(view.results!.final).toBe(true);
        expect(view.results!.votes!.eligible).toBe(2);
        expect(view.results!.votes!.received).toBe(2);
        expect(view.results!.votes!.pending).toBe(0);
        expect(view.results!.tally[1].count).toBe(1); // yes
        expect(view.results!.tally[2].count).toBe(1); // no
    });
});

describe('unpublishPoll', () => {
    it('should remove results from poll', async () => {
        await owner.createId('Bob');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);

        const ballotDid = await owner.votePoll(pollDid, 1);
        await owner.updatePoll(ballotDid);
        await owner.publishPoll(pollDid);
        const ok = await owner.unpublishPoll(pollDid);

        expect(ok).toBe(true);
    });

    it('should throw when non-owner tries to unpublish poll', async () => {
        await owner.createId('Bob');
        const aliceDid = await voter.createId('Alice');
        const template = await owner.pollTemplate();
        const pollDid = await owner.createPoll(template);
        await owner.addPollMember(pollDid, aliceDid);

        const ballotDid = await owner.votePoll(pollDid, 1);
        await owner.updatePoll(ballotDid);

        const aliceBallot = await voter.votePoll(pollDid, 2);
        await owner.updatePoll(aliceBallot);

        await owner.publishPoll(pollDid);

        try {
            await voter.unpublishPoll(pollDid);
            throw new ExpectedExceptionError();
        } catch (error: any) {
            expect(error.message).toBe(`Invalid parameter: ${pollDid}`);
        }
    });
});
