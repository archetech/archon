import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';

let ipfs: MemoryClient;
let gatekeeper: Gatekeeper;
let cipher: CipherNode;
let owner: Keymaster;
let voter: Keymaster;

beforeAll(async () => {
    ipfs = new MemoryClient();
    await ipfs.start();
});

afterAll(async () => {
    if (ipfs) {
        await ipfs.stop();
    }
});

beforeEach(async () => {
    const db = new DbJsonMemory('test');
    gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm'] });
    cipher = new CipherNode();
    owner = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher, passphrase: 'owner' });
    await owner.loadOrCreateWallet();
    voter = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher, passphrase: 'voter' });
    await voter.loadOrCreateWallet();
});

describe('viewPoll', () => {
    it('shows the owner a member\'s spoiled ballot as spoiled', async () => {
        await owner.createId('Bob');
        const alice = await voter.createId('Alice');
        const poll = await owner.createPoll(await owner.pollTemplate());
        await owner.addPollVoter(poll, alice);

        const ballot = await voter.votePoll(poll, 0);
        expect(await owner.updatePoll(ballot)).toBe(true);

        const view = await owner.viewPoll(poll);
        expect(view.results!.ballots).toStrictEqual([{
            voter: alice,
            vote: 0,
            option: 'spoil',
            received: expect.any(String),
        }]);
        expect(view.results!.tally[0]).toStrictEqual({ vote: 0, option: 'spoil', count: 1 });
    });
});

describe('importNotice', () => {
    it('aliases a poll under a numbered name when its own name is taken', async () => {
        await owner.createId('Bob');
        const alice = await voter.createId('Alice');
        const template = await owner.pollTemplate();
        const poll = await owner.createPoll(template);
        await owner.addPollVoter(poll, alice);
        const notice = await owner.createNotice({ to: [alice], dids: [poll] });

        const other = await voter.createAsset({ unrelated: true });
        await voter.addAlias(template.name, other);

        expect(await voter.importNotice(notice)).toBe(true);

        const aliases = await voter.listAliases();
        expect(aliases[template.name]).toBe(other);
        expect(aliases[`${template.name}-2`]).toBe(poll);
    });
});

describe('refreshNotices', () => {
    it('skips a notice that names a DID this node cannot resolve', async () => {
        // A DID made on another node: well formed, and unknown here.
        const elsewhere = new Keymaster({
            gatekeeper: new Gatekeeper({ db: new DbJsonMemory('elsewhere'), ipfs, registries: ['local', 'hyperswarm'] }),
            wallet: new WalletJsonMemory(),
            cipher,
            passphrase: 'elsewhere',
        });
        await elsewhere.loadOrCreateWallet();
        await elsewhere.createId('Carol');
        const unknown = await elsewhere.createAsset({ nowhere: true });

        await owner.createId('Bob');
        const alice = await voter.createId('Alice');
        const notice = await owner.createNotice({ to: [alice], dids: [unknown] });

        expect(await voter.refreshNotices()).toBe(true);

        const id = await voter.fetchIdInfo();
        expect(id.notices?.[notice]).toBeUndefined();
    });
});

describe('verifyDmail', () => {
    it('refuses a message with no recipients field', async () => {
        await owner.createId('Bob');

        await expect(owner.verifyDmail({ subject: 'hi', body: 'there' } as any))
            .rejects.toThrow('Invalid parameter: dmail.to');
    });
});

// Dmail written by a client that leaves out an empty cc list: the message is
// a vault item named `dmail` holding { dmail: { to, subject, body } }.
describe('a dmail with no cc list', () => {
    it('is sent to its recipients and listed with no cc', async () => {
        await owner.createId('Bob');
        const alice = await voter.createId('Alice');
        const vault = await owner.createVault();
        await owner.addVaultMember(vault, alice);
        const message = { to: [alice], subject: 'hello', body: 'no cc here' };
        await owner.addVaultItem(vault, 'dmail', Buffer.from(JSON.stringify({ dmail: message })));

        const notice = await owner.sendDmail(vault);
        expect(notice).toBeTruthy();
        expect((await owner.resolveAsset(notice!)).notice.to).toEqual([alice]);

        expect(await voter.importNotice(notice!)).toBe(true);
        const item = (await voter.listDmail())[vault];
        expect(item.message).toStrictEqual(message);
        expect(item.to).toEqual(['Alice']);
        expect(item.cc).toEqual([]);
    });
});
