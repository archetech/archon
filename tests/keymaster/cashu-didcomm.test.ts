import { jest } from '@jest/globals';
import { getEncodedToken } from '@cashu/cashu-ts';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import {
    CashuMintNotAddedError,
    CashuMintUnsupportedError,
    CashuTokenLockedError,
    CashuTokenSpentError,
    InvalidParameterError,
} from '@didcid/common/errors';
import { CASHU_TOKEN_TYPE, isCashuTokenMessage } from '../../packages/keymaster/src/didcomm-protocols.ts';
import { proofY } from '../../packages/keymaster/src/cashu.ts';
import { FakeMint } from './cashu-fake-mint.ts';
import type { FakeMintOptions } from './cashu-fake-mint.ts';

const PUBLIC_URL = 'https://mint.example/cashu';
const OTHER_URL = 'https://other.example/cashu';
const DAY = 24 * 60 * 60;

let ipfs: MemoryClient;
let mint: FakeMint;
let node: string;
let gatekeeper: any;
let wallet: WalletJsonMemory;
let keymaster: Keymaster;
let aliceDid: string;
let bobDid: string;

async function setup(options: FakeMintOptions = {}): Promise<void> {
    ipfs = new MemoryClient();
    const base = new Gatekeeper({ db: new DbJsonMemory('test'), ipfs, registries: ['local', 'hyperswarm'] });
    mint = new FakeMint(options);
    node = await mint.start();
    gatekeeper = Object.create(base);
    gatekeeper.url = node;
    gatekeeper.getCashuMint = async () => PUBLIC_URL;
    gatekeeper.getDidCommEndpoint = async () => `${node}/didcomm`;
    wallet = new WalletJsonMemory();
    keymaster = new Keymaster({ gatekeeper, wallet, cipher: new CipherNode(), passphrase: 'passphrase' });
    await keymaster.newWallet();
    aliceDid = await keymaster.createId('Alice');
    bobDid = await keymaster.createId('Bob');
    await keymaster.createId('Carol');
    for (const name of ['Alice', 'Bob', 'Carol']) {
        await keymaster.publishDidComm(`${node}/didcomm`, name);
    }
    await keymaster.addCashu('Alice');
    await keymaster.addCashu('Bob');
    await fund(100);
}

async function fund(amount: number, id = 'Alice'): Promise<void> {
    const quote = await keymaster.createCashuMintQuote(amount, undefined, id);
    mint.payMintQuote(quote.quote);
    await keymaster.claimCashuMintQuote(quote.quote, undefined, id);
}

// Key rotation needs an anchored identity, which `local` is at once.
async function anchoredIdentity(name: string, cashu = true): Promise<string> {
    const did = await keymaster.createId(name, { registry: 'local' });
    await keymaster.publishDidComm(`${node}/didcomm`, name);
    if (cashu) {
        await keymaster.addCashu(name);
    }
    return did;
}

const balance = (id: string) => keymaster.getCashuBalance(undefined, id);
const send = (amount = 30, options = {}) => keymaster.sendCashuTo('Bob', amount, { name: 'Alice', ...options });

afterEach(async () => {
    jest.restoreAllMocks();
    await mint?.stop();
    await ipfs?.stop?.();
    mint = undefined as unknown as FakeMint;
});

describe('sendCashuTo', () => {
    beforeEach(() => setup());

    it('locks the token to the recipient, delivers it, and keeps it outstanding', async () => {
        const result = await send(30, { memo: 'lunch' });

        expect(result).toMatchObject({
            amount: 30, fee: 0, mint: PUBLIC_URL, recipient: bobDid, delivered: true,
        });
        expect(result.error).toBeUndefined();
        expect(await balance('Alice')).toMatchObject({ spendable: 70, inFlight: 0, outstanding: 30 });
        expect(mint.mailbox).toHaveLength(1);
        expect(mint.mailbox[0].to).toBe(bobDid);

        const [listed] = await keymaster.listCashuSends(undefined, 'Alice');
        expect(listed).toMatchObject({
            operationId: result.operationId, amount: 30, recipient: bobDid, delivered: true, memo: 'lunch', locktime: result.locktime,
        });
    });

    it('takes a DID as well as an alias', async () => {
        await expect(keymaster.sendCashuTo(bobDid, 5, { name: 'Alice' })).resolves.toMatchObject({ recipient: bobDid });
    });

    it('defaults to a three day locktime and refuses more than the mailbox keeps', async () => {
        const before = Math.floor(Date.now() / 1000);
        const { locktime } = await send(1);
        expect(locktime).toBeGreaterThanOrEqual(before + 3 * DAY);
        expect(locktime).toBeLessThanOrEqual(before + 3 * DAY + 5);

        await expect(send(1, { locktime: 7 * DAY + 1 })).rejects.toThrow(InvalidParameterError);
        await expect(send(1, { locktime: 0 })).rejects.toThrow(InvalidParameterError);
        await expect(send(1, { locktime: 1.5 })).rejects.toThrow(InvalidParameterError);
    });

    it('treats null options as absent, as a JSON caller sends them', async () => {
        const result = await keymaster.sendCashuTo('Bob', 5, { name: 'Alice', memo: null, locktime: null, mint: null } as never);

        expect(result.delivered).toBe(true);
        expect(result.locktime).toBeGreaterThan(Date.now() / 1000 + 2 * DAY);
    });

    it.each([0, -1, 1.5, '10'])('refuses the amount %s', async (amount) => {
        await expect(send(amount as number)).rejects.toThrow(InvalidParameterError);
    });

    it('charges the sender the fee the recipient will pay to redeem', async () => {
        await mint.stop();
        await setup({ inputFeePpk: 1000 });

        const { amount, fee } = await send(30);
        expect(fee).toBeGreaterThan(0);

        const { redeemed } = await keymaster.receiveCashuMessages('Bob');
        // The smallest gross that nets enough can net a little more.
        expect(redeemed[0].amount).toBeGreaterThanOrEqual(amount);
    });

    describe('choosing a mint', () => {
        it('uses the sender\'s mint, whether or not the recipient has heard of it', async () => {
            await expect(send(5)).resolves.toMatchObject({ mint: PUBLIC_URL });
        });

        it('uses the mint given', async () => {
            await expect(send(5, { mint: PUBLIC_URL })).resolves.toMatchObject({ mint: PUBLIC_URL });
        });

        it('refuses a mint the sender has not added, before moving anything', async () => {
            await expect(send(5, { mint: OTHER_URL })).rejects.toThrow(CashuMintNotAddedError);
            expect(await balance('Alice')).toMatchObject({ spendable: 100, inFlight: 0 });
        });

        it('leaves a token for a recipient to claim once it adds the mint', async () => {
            await keymaster.sendCashuTo('Carol', 5, { name: 'Alice' });

            const [waiting] = await keymaster.listCashuMessages('Carol');
            expect(waiting).toMatchObject({ mint: PUBLIC_URL, redeemable: false });
            expect(waiting.reason).toContain('not added');

            await keymaster.addCashu('Carol');
            const { redeemed } = await keymaster.receiveCashuMessages('Carol');
            expect(redeemed[0].amount).toBeGreaterThanOrEqual(5);
        });
    });

    it('refuses before moving anything when the mint lacks NUT-11', async () => {
        await mint.stop();
        await setup({ nuts: [4, 5, 7, 8, 9, 12] });

        await expect(send()).rejects.toThrow(CashuMintUnsupportedError);
        await expect(send()).rejects.toThrow(/NUT-11/);
        expect(await balance('Alice')).toMatchObject({ spendable: 100, inFlight: 0, outstanding: 0 });
    });

    it('refuses before moving anything when the recipient has no DIDComm endpoint', async () => {
        await keymaster.unpublishDidComm('Bob');

        await expect(send()).rejects.toThrow(/DIDComm/);
        expect(await balance('Alice')).toMatchObject({ spendable: 100, inFlight: 0, outstanding: 0 });
    });

    describe('a recipient behind a mediator', () => {
        const untouched = async () => expect(await balance('Alice')).toMatchObject({ spendable: 100, inFlight: 0, outstanding: 0 });

        it('refuses before moving anything when the mediator has no direct endpoint', async () => {
            const carol = (await keymaster.resolveDID('Carol')).didDocument!.id!;
            await keymaster.unpublishDidComm('Carol');
            await keymaster.publishDidComm(carol, 'Bob');

            await expect(send()).rejects.toThrow(/no direct DIDCommMessaging endpoint/);
            await untouched();
        });

        it('refuses before moving anything when the mediator only forwards too', async () => {
            const carol = (await keymaster.resolveDID('Carol')).didDocument!.id!;
            await keymaster.publishDidComm(bobDid, 'Carol');
            await keymaster.publishDidComm(carol, 'Bob');

            await expect(send()).rejects.toThrow(/no direct DIDCommMessaging endpoint/);
            await untouched();
        });

        it('refuses before moving anything when a routing key cannot be resolved', async () => {
            await keymaster.publishDidComm(`${node}/didcomm`, 'Bob', ['did:cid:bagaaieranosuchroutingkey']);

            await expect(send()).rejects.toThrow();
            await untouched();
        });

        it('sends when the route is sound', async () => {
            const carol = (await keymaster.resolveDID('Carol')).didDocument!.id!;
            await keymaster.publishDidComm(`${node}/didcomm`, 'Bob', [carol]);

            await expect(send()).resolves.toMatchObject({ amount: 30 });
        });
    });

    it('refuses before moving anything when the sender cannot authenticate a message', async () => {
        await keymaster.unpublishDidComm('Alice');

        await expect(send()).rejects.toThrow(/key agreement|keyAgreement/i);
        expect(await balance('Alice')).toMatchObject({ spendable: 100, inFlight: 0, outstanding: 0 });
    });

    it('cannot be spent by anyone but the recipient', async () => {
        const { token } = await send();
        await keymaster.addCashu('Carol');

        await expect(keymaster.receiveCashu(token, 'Carol')).rejects.toThrow(CashuTokenLockedError);
        expect(await balance('Carol')).toMatchObject({ spendable: 0, inFlight: 0 });
    });
});

describe('delivery', () => {
    beforeEach(() => setup());

    it('keeps a token the relay refused, and says so', async () => {
        mint.relayDown = true;

        const result = await send();

        expect(result.delivered).toBe(false);
        expect(result.error).toMatch(/DIDComm|fetch|failed/i);
        expect(result.token).toMatch(/^cashuB/);
        expect(await balance('Alice')).toMatchObject({ spendable: 70, outstanding: 30 });
        const [listed] = await keymaster.listCashuSends(undefined, 'Alice');
        expect(listed.delivered).toBe(false);
    });

    it('delivers on the next check, with the same message id', async () => {
        mint.relayDown = true;
        const { messageId } = await send();
        mint.relayDown = false;

        await keymaster.checkCashu(undefined, 'Alice');

        expect(mint.mailbox).toHaveLength(1);
        const [message] = await keymaster.receiveDidComm({ name: 'Bob', ack: false });
        expect(message.message.id).toBe(messageId);
        const [listed] = await keymaster.listCashuSends(undefined, 'Alice');
        expect(listed.delivered).toBe(true);
    });

    it('does not resend what was delivered', async () => {
        await send();

        await keymaster.checkCashu(undefined, 'Alice');
        await keymaster.checkCashu(undefined, 'Alice');

        expect(mint.mailbox).toHaveLength(1);
    });

    it('recovers a lost swap response and still delivers', async () => {
        mint.loseResponse('/v1/swap');

        await expect(send()).rejects.toThrow();
        expect(await balance('Alice')).toMatchObject({ spendable: 68, inFlight: 32 });
        expect(mint.mailbox).toHaveLength(0);

        await keymaster.checkCashu(undefined, 'Alice');

        expect(await balance('Alice')).toMatchObject({ spendable: 70, inFlight: 0, outstanding: 30 });
        expect(mint.mailbox).toHaveLength(1);
        const { redeemed } = await keymaster.receiveCashuMessages('Bob');
        expect(redeemed[0].amount).toBe(30);
    });

    it('returns the inputs when the mint refuses the swap', async () => {
        mint.refuseNext('/v1/swap', 11001, 'nope');

        await expect(send()).rejects.toThrow(/nope/);

        expect(await balance('Alice')).toMatchObject({ spendable: 100, inFlight: 0, outstanding: 0 });
        expect(mint.mailbox).toHaveLength(0);
    });
});

describe('the general inbox', () => {
    beforeEach(() => setup());

    it('returns a token message but does not consume it', async () => {
        await send();

        const received = await keymaster.receiveDidComm({ name: 'Bob' });

        expect(received).toHaveLength(1);
        expect(received[0].message.type).toBe(CASHU_TOKEN_TYPE);
        expect(mint.mailbox).toHaveLength(1);
    });

    it('still consumes other messages beside it', async () => {
        await send();
        await keymaster.sendDidComm({ type: 'https://didcomm.org/basicmessage/2.0/message', body: { content: 'hi' } }, 'Bob', { name: 'Alice' });

        await keymaster.receiveDidComm({ name: 'Bob' });

        expect(mint.mailbox).toHaveLength(1);
        expect(JSON.parse(mint.mailbox[0].message)).toBeDefined();
        const [left] = await keymaster.receiveDidComm({ name: 'Bob', ack: false });
        expect(left.message.type).toBe(CASHU_TOKEN_TYPE);
    });

    it('lets an explicit ack remove one', async () => {
        await send();
        const [{ id }] = await keymaster.receiveDidComm({ name: 'Bob', ack: false });

        expect(await keymaster.ackDidComm([id], { name: 'Bob' })).toBe(1);
        expect(mint.mailbox).toHaveLength(0);
    });

    it.each([
        ['https://archetech.com/didcomm/cashu/1.0/token', true],
        ['https://archetech.com/didcomm/cashu/1.7/token', true],
        ['https://archetech.com/didcomm/cashu/2.0/token', false],
        ['https://archetech.com/didcomm/cashu/1.0/other', false],
        [undefined, false],
    ])('recognizes %s as %s', (type, expected) => {
        expect(isCashuTokenMessage({ type })).toBe(expected);
    });
});

describe('receiveCashuMessages', () => {
    beforeEach(() => setup());

    it('redeems a token, credits it, and clears the message', async () => {
        await send(30, { memo: 'lunch' });

        const { redeemed, failed } = await keymaster.receiveCashuMessages('Bob');

        expect(failed).toEqual([]);
        expect(redeemed).toHaveLength(1);
        expect(redeemed[0]).toMatchObject({ sender: aliceDid, amount: 30, mint: PUBLIC_URL, memo: 'lunch' });
        expect(await balance('Bob')).toMatchObject({ spendable: 30, inFlight: 0 });
        expect(mint.mailbox).toHaveLength(0);

        await keymaster.checkCashu(undefined, 'Alice');
        expect(await balance('Alice')).toMatchObject({ outstanding: 0 });
    });

    it('credits a resend only once', async () => {
        await send();
        const [delivered] = mint.mailbox;
        await keymaster.receiveCashuMessages('Bob');

        mint.mailbox.push({ ...delivered, id: 'resend' });
        const second = await keymaster.receiveCashuMessages('Bob');

        expect(second).toEqual({ redeemed: [], failed: [] });
        expect(await balance('Bob')).toMatchObject({ spendable: 30 });
        expect(mint.mailbox).toHaveLength(0);
    });

    it('leaves a message from a mint not added, to accept once it is', async () => {
        await send();
        await keymaster.removeCashuMint(PUBLIC_URL, false, 'Bob');

        const first = await keymaster.receiveCashuMessages('Bob');

        expect(first.redeemed).toEqual([]);
        expect(first.failed[0]).toMatchObject({ sender: aliceDid, mint: PUBLIC_URL, acknowledged: false });
        expect(mint.mailbox).toHaveLength(1);

        await keymaster.addCashu('Bob');
        const second = await keymaster.receiveCashuMessages('Bob');

        expect(second.redeemed[0].amount).toBe(30);
        expect(mint.mailbox).toHaveLength(0);
    });

    it('never asks an unadded mint about the token', async () => {
        await send();
        await keymaster.removeCashuMint(PUBLIC_URL, false, 'Bob');
        mint.requests.length = 0;

        await keymaster.receiveCashuMessages('Bob');

        expect(mint.requests).toEqual([]);
    });

    it('reports a spent token and clears its message', async () => {
        const { token } = await send();
        await keymaster.receiveCashu(token, 'Bob');

        const { failed } = await keymaster.receiveCashuMessages('Bob');

        expect(failed[0]).toMatchObject({ acknowledged: true });
        expect(failed[0].reason).toMatch(/spent|in the wallet/);
        expect(mint.mailbox).toHaveLength(0);
    });

    it('leaves the message when the mint is unreachable', async () => {
        await send();
        const { fetch: realFetch } = globalThis;
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            if (String(input).includes('/cashu/')) {
                throw new TypeError('connection refused');
            }
            return realFetch(input as never, init);
        });

        const { redeemed, failed } = await keymaster.receiveCashuMessages('Bob');

        expect(redeemed).toEqual([]);
        expect(failed[0]).toMatchObject({ mint: PUBLIC_URL, acknowledged: false });
        expect(mint.mailbox).toHaveLength(1);
        expect(await balance('Bob')).toMatchObject({ spendable: 0, inFlight: 0 });
    });

    it('leaves the message when the mint refuses the swap, and can try again', async () => {
        await send();
        mint.refuseNext('/v1/swap', 12345, 'temporarily refused');

        const first = await keymaster.receiveCashuMessages('Bob');

        expect(first.failed[0]).toMatchObject({ acknowledged: false });
        expect(first.failed[0].reason).toMatch(/temporarily refused/);
        expect(mint.mailbox).toHaveLength(1);
        expect(await balance('Bob')).toMatchObject({ spendable: 0, inFlight: 0 });

        const second = await keymaster.receiveCashuMessages('Bob');

        expect(second.redeemed[0].amount).toBe(30);
        expect(mint.mailbox).toHaveLength(0);
    });

    it('keeps the message while a lost response is unresolved, and credits once', async () => {
        await send();
        mint.loseResponse('/v1/swap');

        const first = await keymaster.receiveCashuMessages('Bob');

        expect(first.redeemed).toEqual([]);
        expect(first.failed[0].acknowledged).toBe(false);
        expect(mint.mailbox).toHaveLength(1);

        const second = await keymaster.receiveCashuMessages('Bob');

        expect(second).toEqual({ redeemed: [], failed: [] });
        expect(await balance('Bob')).toMatchObject({ spendable: 30, inFlight: 0 });
        expect(mint.mailbox).toHaveLength(0);
    });

    it('redeems a message once when accepted twice at the same moment', async () => {
        await send();
        mint.requests.length = 0;

        const results = await Promise.all([
            keymaster.receiveCashuMessages('Bob'),
            keymaster.receiveCashuMessages('Bob'),
        ]);

        expect(results.flatMap(result => result.redeemed)).toHaveLength(1);
        expect(results.flatMap(result => result.failed).filter(item => item.acknowledged)).toEqual([]);
        expect(mint.requests.filter(request => request === 'POST /v1/swap')).toHaveLength(1);
        expect(await balance('Bob')).toMatchObject({ spendable: 30, inFlight: 0 });
        expect(mint.mailbox).toHaveLength(0);
    });

    it('leaves a message it cannot read', async () => {
        await keymaster.sendDidComm({ type: CASHU_TOKEN_TYPE, body: { token: 'not a token' } }, 'Bob', { name: 'Alice' });

        const { redeemed, failed } = await keymaster.receiveCashuMessages('Bob');

        expect(redeemed).toEqual([]);
        expect(failed[0]).toMatchObject({ acknowledged: false });
        expect(mint.mailbox).toHaveLength(1);
    });

    it('redeems with a key the recipient has since rotated away', async () => {
        await anchoredIdentity('Rita');
        await keymaster.sendCashuTo('Rita', 30, { name: 'Alice' });
        await keymaster.setCurrentId('Rita');
        await keymaster.rotateKeys();

        const { redeemed, failed } = await keymaster.receiveCashuMessages('Rita');

        expect(failed).toEqual([]);
        expect(redeemed[0].amount).toBe(30);
    });

    it('does not touch messages for another identity', async () => {
        await send();

        expect(await keymaster.receiveCashuMessages('Alice')).toEqual({ redeemed: [], failed: [] });
        expect(mint.mailbox).toHaveLength(1);
    });
});

describe('a token partly spent already', () => {
    beforeEach(() => setup());

    // A 30 sat token is four proofs, and this spends the 2 sat one at the mint.
    async function sendWithOneSpent(): Promise<void> {
        await send();
        const wallet = await keymaster.loadWallet();
        const { sent } = wallet.ids.Alice.cashu[PUBLIC_URL].operations[0];
        const smallest = sent.reduce((a: { amount: number }, b: { amount: number }) => (b.amount < a.amount ? b : a));
        mint.spent.add(proofY(smallest.secret));
    }

    function onSecondSwap(act: () => void): void {
        let swaps = 0;
        mint.onRequest = async (path) => {
            if (path === '/v1/swap' && ++swaps === 2) {
                act();
            }
        };
    }

    it('redeems the rest and says what was already gone', async () => {
        await sendWithOneSpent();

        const { redeemed, failed } = await keymaster.receiveCashuMessages('Bob');

        expect(failed).toEqual([]);
        expect(redeemed[0]).toMatchObject({ amount: 28, spent: 2 });
        expect(await balance('Bob')).toMatchObject({ spendable: 28, inFlight: 0 });
        expect(mint.mailbox).toHaveLength(0);
    });

    it('redeems the rest of a token given directly too', async () => {
        await send();
        const { token } = await keymaster.sendCashuTo('Bob', 30, { name: 'Alice' });
        const wallet = await keymaster.loadWallet();
        const { sent } = wallet.ids.Alice.cashu[PUBLIC_URL].operations[1];
        mint.spent.add(proofY(sent.find((proof: { amount: number }) => proof.amount === 2).secret));

        await expect(keymaster.receiveCashu(token, 'Bob')).resolves.toMatchObject({ amount: 28, spent: 2 });
    });

    it('keeps the message when the mint refuses the rest, and can try again', async () => {
        await sendWithOneSpent();
        onSecondSwap(() => mint.refuseNext('/v1/swap', 12345, 'temporarily refused'));

        const first = await keymaster.receiveCashuMessages('Bob');

        expect(first.redeemed).toEqual([]);
        expect(first.failed[0]).toMatchObject({ acknowledged: false });
        expect(mint.mailbox).toHaveLength(1);
        expect(await balance('Bob')).toMatchObject({ spendable: 0, inFlight: 0 });

        mint.onRequest = undefined;
        const second = await keymaster.receiveCashuMessages('Bob');

        expect(second.redeemed[0]).toMatchObject({ amount: 28 });
        expect(mint.mailbox).toHaveLength(0);
    });

    it('keeps the message while the rest is unresolved, and credits it once', async () => {
        await sendWithOneSpent();
        onSecondSwap(() => mint.loseResponse('/v1/swap'));

        const first = await keymaster.receiveCashuMessages('Bob');

        expect(first.redeemed).toEqual([]);
        expect(first.failed[0]).toMatchObject({ acknowledged: false });
        expect(mint.mailbox).toHaveLength(1);

        mint.onRequest = undefined;
        expect(await keymaster.receiveCashuMessages('Bob')).toEqual({ redeemed: [], failed: [] });

        expect(await balance('Bob')).toMatchObject({ spendable: 28, inFlight: 0 });
        expect(mint.mailbox).toHaveLength(0);
    });

    it('still clears the message when every proof is spent', async () => {
        await send();
        const wallet = await keymaster.loadWallet();
        for (const { secret } of wallet.ids.Alice.cashu[PUBLIC_URL].operations[0].sent) {
            mint.spent.add(proofY(secret));
        }

        const { failed } = await keymaster.receiveCashuMessages('Bob');

        expect(failed[0]).toMatchObject({ acknowledged: true });
        expect(mint.mailbox).toHaveLength(0);
    });
});

describe('keys', () => {
    beforeEach(() => setup());

    // NUT-11 and BIP-340 work on the x-coordinate, so either prefix names the key.
    it('recognizes a key written with the opposite parity prefix', async () => {
        const host = (keymaster as any).cashu.host;
        const documentPublicKey = host.documentPublicKey;
        host.documentPublicKey = (doc: unknown) => {
            const key: string = documentPublicKey(doc);
            return `${key.startsWith('02') ? '03' : '02'}${key.slice(2)}`;
        };
        await send();
        host.documentPublicKey = documentPublicKey;

        expect((await keymaster.listCashuMessages('Bob'))[0].redeemable).toBe(true);
        const { redeemed, failed } = await keymaster.receiveCashuMessages('Bob');

        expect(failed).toEqual([]);
        expect(redeemed[0].amount).toBe(30);
    });
});

describe('listCashuMessages', () => {
    beforeEach(() => setup());

    it('describes a waiting token and changes nothing', async () => {
        await send(30, { memo: 'lunch' });
        mint.requests.length = 0;

        const messages = await keymaster.listCashuMessages('Bob');

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ sender: aliceDid, amount: 30, mint: PUBLIC_URL, memo: 'lunch', redeemable: true });
        expect(mint.requests).toEqual([]);
        expect(mint.mailbox).toHaveLength(1);
        expect(await balance('Bob')).toMatchObject({ spendable: 0 });
    });

    it('says why a token cannot be redeemed', async () => {
        await send();
        await keymaster.removeCashuMint(PUBLIC_URL, false, 'Bob');

        const [message] = await keymaster.listCashuMessages('Bob');

        expect(message.redeemable).toBe(false);
        expect(message.reason).toContain(PUBLIC_URL);
    });

    it('agrees with redemption about a refund needing several signatures', async () => {
        const doc = await keymaster.resolveDID(bobDid);
        const bobKey = (keymaster as any).cashu.host.documentPublicKey(doc);
        const stranger = `02${'11'.repeat(32)}`;
        const secret = JSON.stringify(['P2PK', {
            nonce: '00',
            data: stranger,
            tags: [['locktime', '1000'], ['refund', bobKey], ['n_sigs_refund', '2']],
        }]);
        const token = getEncodedToken({
            mint: PUBLIC_URL,
            unit: 'sat',
            proofs: [{ id: mint.keysetId, amount: 1, secret, C: `02${'00'.repeat(32)}` }] as never,
        });
        await keymaster.sendDidComm({ type: CASHU_TOKEN_TYPE, body: { token } }, 'Bob', { name: 'Alice' });

        const [message] = await keymaster.listCashuMessages('Bob');
        expect(message.redeemable).toBe(false);

        const { redeemed, failed } = await keymaster.receiveCashuMessages('Bob');
        expect(redeemed).toEqual([]);
        expect(failed).toHaveLength(1);
    });

    it('lists a redemption still unresolved, without contacting the mint', async () => {
        await send();
        mint.loseResponse('/v1/swap');
        await keymaster.receiveCashuMessages('Bob');
        mint.requests.length = 0;

        const messages = await keymaster.listCashuMessages('Bob');

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ redeemable: false, sender: aliceDid, amount: 30 });
        expect(messages[0].reason).toMatch(/pending/);
        expect(mint.requests).toEqual([]);
    });

    it('calls a token in another unit not redeemable', async () => {
        const token = getEncodedToken({
            mint: PUBLIC_URL,
            unit: 'usd',
            proofs: [{ id: mint.keysetId, amount: 1, secret: 'a'.repeat(64), C: `02${'00'.repeat(32)}` }] as never,
        });
        await keymaster.sendDidComm({ type: CASHU_TOKEN_TYPE, body: { token } }, 'Bob', { name: 'Alice' });

        const [message] = await keymaster.listCashuMessages('Bob');

        expect(message.redeemable).toBe(false);
        expect(message.reason).toMatch(/usd/);
        expect((await keymaster.receiveCashuMessages('Bob')).redeemed).toEqual([]);
    });

    it('does not list what was redeemed', async () => {
        await send();
        await keymaster.receiveCashuMessages('Bob');

        expect(await keymaster.listCashuMessages('Bob')).toEqual([]);
    });
});

describe('reclaiming a locked send', () => {
    beforeEach(() => setup());

    function after(seconds: number) {
        const later = Date.now() + seconds * 1000;
        jest.spyOn(Date, 'now').mockReturnValue(later);
    }

    it('is refused while the lock is in force, and leaves the send outstanding', async () => {
        const { operationId } = await send();

        await expect(keymaster.reclaimCashu(operationId, 'Alice')).rejects.toThrow(CashuTokenLockedError);

        expect(await balance('Alice')).toMatchObject({ spendable: 70, inFlight: 0, outstanding: 30 });
        expect(await keymaster.listCashuSends(undefined, 'Alice')).toHaveLength(1);
    });

    it('takes the value back with the refund key once the lock has passed', async () => {
        const { operationId } = await send(30, { locktime: 60 });
        after(120);

        await expect(keymaster.reclaimCashu(operationId, 'Alice')).resolves.toMatchObject({ amount: 30, mint: PUBLIC_URL });

        expect(await balance('Alice')).toMatchObject({ spendable: 100, inFlight: 0, outstanding: 0 });
    });

    it('still works after the sender rotates its keys', async () => {
        await anchoredIdentity('Rita');
        await fund(100, 'Rita');
        const { operationId } = await keymaster.sendCashuTo('Bob', 30, { name: 'Rita', locktime: 60 });
        await keymaster.setCurrentId('Rita');
        await keymaster.rotateKeys();
        after(120);

        await expect(keymaster.reclaimCashu(operationId, 'Rita')).resolves.toMatchObject({ amount: 30 });
    });

    it('reclaims a token that was never delivered', async () => {
        mint.relayDown = true;
        const { operationId } = await send(30, { locktime: 60 });
        after(120);

        await expect(keymaster.reclaimCashu(operationId, 'Alice')).resolves.toMatchObject({ amount: 30 });

        mint.relayDown = false;
        await keymaster.checkCashu(undefined, 'Alice');
        expect(mint.mailbox).toHaveLength(0);
    });

    it('reports a token the recipient already redeemed', async () => {
        const { operationId } = await send(30, { locktime: 60 });
        await keymaster.receiveCashuMessages('Bob');
        after(120);

        await expect(keymaster.reclaimCashu(operationId, 'Alice')).rejects.toThrow(CashuTokenSpentError);
        expect(await balance('Bob')).toMatchObject({ spendable: 30 });
    });

    it('lets the recipient redeem past the locktime, and then the sender cannot', async () => {
        const { operationId } = await send(30, { locktime: 60 });
        after(120);

        const { redeemed } = await keymaster.receiveCashuMessages('Bob');
        expect(redeemed[0].amount).toBe(30);

        await expect(keymaster.reclaimCashu(operationId, 'Alice')).rejects.toThrow(CashuTokenSpentError);
    });

    it('leaves the recipient a spent token if the sender reclaims first', async () => {
        const { operationId } = await send(30, { locktime: 60 });
        after(120);
        await keymaster.reclaimCashu(operationId, 'Alice');

        const { redeemed, failed } = await keymaster.receiveCashuMessages('Bob');

        expect(redeemed).toEqual([]);
        expect(failed[0]).toMatchObject({ acknowledged: true });
        expect(mint.mailbox).toHaveLength(0);
    });

    it('lets only one of two concurrent reclaims through', async () => {
        const { operationId } = await send(30, { locktime: 60 });
        after(120);
        mint.requests.length = 0;

        const results = await Promise.allSettled([
            keymaster.reclaimCashu(operationId, 'Alice'),
            keymaster.reclaimCashu(operationId, 'Alice'),
        ]);

        expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(mint.requests.filter(request => request === 'POST /v1/swap')).toHaveLength(1);
        expect(await balance('Alice')).toMatchObject({ spendable: 100, inFlight: 0, outstanding: 0 });
    });

    it('keeps a settlement off a reclaim still running', async () => {
        const { operationId } = await send(30, { locktime: 60 });
        after(120);
        mint.requests.length = 0;

        // Whichever gets there first, the other is told to wait, and the send is whole.
        await Promise.allSettled([
            keymaster.reclaimCashu(operationId, 'Alice'),
            keymaster.checkCashu(undefined, 'Alice'),
            keymaster.reclaimCashu(operationId, 'Alice'),
        ]);

        expect(mint.requests.filter(request => request === 'POST /v1/swap').length).toBeLessThanOrEqual(1);
        const { spendable, inFlight, outstanding } = await balance('Alice');
        expect(inFlight).toBe(0);
        expect(spendable + outstanding).toBe(100);
    });

    it('can still deliver what is left when the reclaim of a partly spent token is refused', async () => {
        mint.relayDown = true;
        const { operationId, messageId } = await send(30, { locktime: 60 });
        const stored = await keymaster.loadWallet();
        const { sent } = stored.ids.Alice.cashu[PUBLIC_URL].operations.find((op: { id: string }) => op.id === operationId);
        mint.spent.add(proofY(sent[0].secret));
        after(120);
        mint.relayDown = false;
        let swaps = 0;
        mint.onRequest = async (path) => {
            if (path === '/v1/swap' && ++swaps === 2) {
                mint.refuseNext('/v1/swap', 12345, 'temporarily refused');
            }
        };

        await keymaster.reclaimCashu(operationId, 'Alice');
        mint.onRequest = undefined;

        const [listed] = await keymaster.listCashuSends(undefined, 'Alice');
        expect(listed).toMatchObject({ recipient: bobDid, delivered: false });

        await keymaster.checkCashu(undefined, 'Alice');

        const [message] = await keymaster.receiveDidComm({ name: 'Bob', ack: false });
        expect(message.message.id).toBe(messageId);
    });

    it('can still deliver a token whose reclaim was refused', async () => {
        mint.relayDown = true;
        const { operationId, messageId } = await send(30, { locktime: 60 });
        after(120);
        mint.relayDown = false;
        mint.refuseNext('/v1/swap', 12345, 'temporarily refused');
        // Delivered by the check inside the reclaim's own settlement otherwise.
        await expect(keymaster.reclaimCashu(operationId, 'Alice')).rejects.toThrow(/temporarily refused/);

        const [listed] = await keymaster.listCashuSends(undefined, 'Alice');
        expect(listed).toMatchObject({ recipient: bobDid, delivered: false });

        await keymaster.checkCashu(undefined, 'Alice');

        const [message] = await keymaster.receiveDidComm({ name: 'Bob', ack: false });
        expect(message.message.id).toBe(messageId);
    });

    it('puts a refused reclaim back, to be reclaimed again', async () => {
        const { operationId } = await send(30, { locktime: 60 });
        after(120);
        mint.refuseNext('/v1/swap', 12345, 'temporarily refused');

        await expect(keymaster.reclaimCashu(operationId, 'Alice')).rejects.toThrow(/temporarily refused/);
        expect(await balance('Alice')).toMatchObject({ outstanding: 30, inFlight: 0 });

        await expect(keymaster.reclaimCashu(operationId, 'Alice')).resolves.toMatchObject({ amount: 30 });
    });
});

describe('receiveCashu with a locked token', () => {
    beforeEach(() => setup());

    it('redeems one locked to this identity', async () => {
        const { token } = await send();

        await expect(keymaster.receiveCashu(token, 'Bob')).resolves.toMatchObject({ amount: 30 });
    });
});
