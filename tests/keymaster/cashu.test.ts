import { jest } from '@jest/globals';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import {
    CashuInsufficientFundsError,
    CashuMintNotAddedError,
    CashuMintUnsupportedError,
    CashuNotConfiguredError,
    CashuQuoteUnpaidError,
    CashuStateError,
    CashuTokenSpentError,
    CashuUnavailableError,
} from '@didcid/common/errors';
import { signedInvoice } from '../cli/helpers.ts';
import { getEncodedToken } from '@cashu/cashu-ts';
import { CashuWallet, normalizeMintUrl, proofY, splitAmount } from '../../packages/keymaster/src/cashu.ts';
import { FakeMint } from './cashu-fake-mint.ts';
import type { FakeMintOptions } from './cashu-fake-mint.ts';

const PUBLIC_URL = 'https://mint.example/cashu';
const PASSPHRASE = 'passphrase';

let ipfs: MemoryClient;
let mint: FakeMint;
let node: string;
let gatekeeper: any;
let wallet: WalletJsonMemory;
let cipher: CipherNode;
let keymaster: Keymaster;

function newKeymaster(store = wallet): Keymaster {
    return new Keymaster({ gatekeeper, wallet: store, cipher, passphrase: PASSPHRASE });
}

async function setup(options: FakeMintOptions = {}): Promise<void> {
    ipfs = new MemoryClient();
    const base = new Gatekeeper({ db: new DbJsonMemory('test'), ipfs, registries: ['local', 'hyperswarm'] });
    mint = new FakeMint(options);
    node = await mint.start();
    gatekeeper = Object.create(base);
    gatekeeper.url = node;
    gatekeeper.getCashuMint = async () => PUBLIC_URL;
    wallet = new WalletJsonMemory();
    cipher = new CipherNode();
    keymaster = newKeymaster();
    await keymaster.newWallet();
    await keymaster.createId('Alice');
}

afterEach(async () => {
    await mint?.stop();
    await ipfs?.stop?.();
    mint = undefined as unknown as FakeMint;
});

async function fund(amount: number, id?: string, km = keymaster): Promise<void> {
    const quote = await km.createCashuMintQuote(amount, undefined, id);
    mint.payMintQuote(quote.quote);
    await km.claimCashuMintQuote(quote.quote, undefined, id);
}

async function entry(km = keymaster, id = 'Alice') {
    const stored = await km.loadWallet();
    return stored.ids[id].cashu[PUBLIC_URL];
}

describe('choosing proofs', () => {
    beforeEach(async () => {
        await setup();
        await keymaster.addCashu();
        await fund(16000);
    });

    const inFlight = async () => (await keymaster.getCashuBalance()).inFlight;

    // A melt that goes pending locks what it selected, for as long as the mint keeps
    // it pending, so it must not take more than it needs.
    it('locks the smallest proof that covers a melt, not the largest', async () => {
        mint.meltOutcome = 'PENDING';

        await keymaster.meltCashu(signedInvoice(700));

        expect(await inFlight()).toBe(1024);
    });

    it('combines proofs only when no single one covers it, without any to spare', async () => {
        mint.meltOutcome = 'PENDING';

        await keymaster.meltCashu(signedInvoice(9000));

        // 8192 + 2048 covers 9010; 4096 + 8192 would hold more than it needs to.
        expect(await inFlight()).toBeLessThan(12288);
        expect(await inFlight()).toBeGreaterThanOrEqual(9010);
    });

    it('still reports too little across everything', async () => {
        await expect(keymaster.meltCashu(signedInvoice(16000))).rejects.toThrow(CashuInsufficientFundsError);
        expect(await inFlight()).toBe(0);
    });

    it('counts each input fee when choosing', async () => {
        await mint.stop();
        await setup({ inputFeePpk: 1000 });
        await keymaster.addCashu();
        await fund(16000);

        const { amount } = await keymaster.sendCashu(1000);

        expect(amount).toBe(1000);
        const balance = await keymaster.getCashuBalance();
        expect(balance.spendable + balance.outstanding).toBeLessThanOrEqual(16000);
        expect(balance.inFlight).toBe(0);
    });
});

describe('selecting from a fragmented balance', () => {
    const keysets = [{ id: 'free', unit: 'sat', active: true }, { id: 'paid', unit: 'sat', active: true, input_fee_ppk: 600 }];
    const proof = (i: number, id = 'free', amount = 1) => ({ id, amount, secret: `s${i}`, C: 'c' });
    const select = (proofs: unknown[], target: number) =>
        (new CashuWallet({} as never) as any).select(proofs, target, keysets) as { amount: number; id: string }[];
    const value = (some: { amount: number }[]) => some.reduce((total, item) => total + item.amount, 0);

    // Selection runs inside the wallet's write, so it must stay quick with many proofs.
    it('stays quick across thousands of proofs', () => {
        const proofs = Array.from({ length: 4000 }, (_, i) => proof(i));
        const start = Date.now();

        expect(select(proofs, 3999)).toHaveLength(3999);
        expect(() => select(proofs, 4001)).toThrow(CashuInsufficientFundsError);

        expect(Date.now() - start).toBeLessThan(5000);
    });

    it('rounds the fee on the total, not on each input', () => {
        // Two inputs at 600 ppk owe 2 sats; each alone would round to 1.
        const chosen = select([proof(1, 'paid', 4), proof(2, 'paid', 4)], 6);

        expect(value(chosen)).toBe(8);
    });

    it('counts the fee of the proof that would finish the job', () => {
        // 3 at 600 ppk nets 2, so the 3 does not cover 3, and the 4 does.
        expect(select([proof(1, 'paid', 3), proof(2, 'paid', 4)], 3)).toEqual([expect.objectContaining({ amount: 4 })]);
    });

    it('prefers the smallest proof that finishes the job at each step', () => {
        const chosen = select([1, 2, 4, 8, 16].map((amount, i) => proof(i, 'free', amount)), 18);

        expect(chosen.map(item => item.amount)).toEqual([16, 2]);
    });
});

describe('a melt quote', () => {
    beforeEach(async () => {
        await setup();
        await keymaster.addCashu();
        await fund(1000);
    });

    it('is refused when it asks for more than the invoice is for', async () => {
        mint.meltAmountOverride = 900;

        await expect(keymaster.meltCashu(signedInvoice(100))).rejects.toThrow(CashuMintUnsupportedError);

        expect(await keymaster.getCashuBalance()).toMatchObject({ spendable: 1000, inFlight: 0 });
    });

    it('is refused when it asks for less', async () => {
        mint.meltAmountOverride = 50;

        await expect(keymaster.meltCashu(signedInvoice(100))).rejects.toThrow(CashuMintUnsupportedError);
    });

    it('is not requested for an invoice with no amount', async () => {
        mint.requests = [];

        await expect(keymaster.meltCashu(signedInvoice())).rejects.toThrow(/amount/);

        expect(mint.requests).toEqual([]);
    });

    it('is not requested for something that is not an invoice', async () => {
        mint.requests = [];

        await expect(keymaster.meltCashu('lnbc-garbage')).rejects.toThrow(/bolt11/);

        expect(mint.requests).toEqual([]);
    });
});

describe('helpers', () => {
    it.each([
        ['HTTPS://Mint.Example:443/Cashu/', 'https://mint.example/Cashu'],
        ['https://mint.example/?a=1#frag', 'https://mint.example'],
        ['http://mint.example:80', 'http://mint.example'],
        ['https://mint.example:8443/', 'https://mint.example:8443'],
    ])('normalizes %s', (input, output) => {
        expect(normalizeMintUrl(input)).toBe(output);
    });

    it.each([[1, [1]], [13, [1, 4, 8]], [64, [64]], [0, []]])('splits %d', (amount, parts) => {
        expect(splitAmount(amount as number)).toEqual(parts);
    });
});

function walletWith(publicFetch: typeof fetch): CashuWallet {
    return new CashuWallet({
        gatekeeper,
        mutateWallet: (keymaster as any).mutateWallet.bind(keymaster),
        loadWallet: () => keymaster.loadWallet(),
        fetchIdInfo: (name, stored) => keymaster.fetchIdInfo(name, stored),
        getSeed: stored => (keymaster as any).getSeedFromCacheOrMnemonic(stored),
        getCapabilities: async () => null,
        resolveDID: did => keymaster.resolveDID(did),
        updateDID: (did, doc) => keymaster.updateDID(did, doc),
        ownPublicKey: async () => '',
        documentPublicKey: () => '',
        findPrivateKey: async () => undefined,
        requireDidCommRoute: async () => undefined,
        sendDidComm: async () => [],
        receiveDidComm: async () => [],
        ackDidComm: async () => 0,
    }, publicFetch);
}

describe('enabling', () => {
    beforeEach(() => setup());

    it('adds the node mint under its public URL, idempotently', async () => {
        const info = await keymaster.addCashu();

        expect(info).toMatchObject({ url: PUBLIC_URL, isNodeMint: true, name: 'Fake mint' });
        await keymaster.addCashu();
        expect(await entry()).toMatchObject({ node, proofs: [] });
        expect(await keymaster.listCashuMints()).toHaveLength(1);
    });

    it('points to addCashuMint on a node without a mint', async () => {
        gatekeeper.getCashuMint = async () => undefined;

        await expect(keymaster.addCashu()).rejects.toThrow(CashuUnavailableError);
        await expect(keymaster.addCashu()).rejects.toThrow(/addCashuMint/);
    });

    it('refuses a mint without the NUTs the journal depends on', async () => {
        await mint.stop();
        await setup({ nuts: [4, 5, 7, 8] });

        await expect(keymaster.addCashu()).rejects.toThrow(CashuMintUnsupportedError);
    });

    it('refuses an outside mint over http or on a private address', async () => {
        await expect(keymaster.addCashuMint('http://mint.example')).rejects.toThrow(CashuUnavailableError);
        await expect(keymaster.addCashuMint('https://127.0.0.1:3338')).rejects.toThrow(CashuUnavailableError);
    });

    it('uses an outside mint through the public fetch at its own URL', async () => {
        const requested: string[] = [];
        const publicFetch = ((url: string, init?: RequestInit) => {
            requested.push(url);
            return fetch(url.replace('https://outside.example', `${node}/cashu`), init);
        }) as typeof fetch;
        const cashu = walletWith(publicFetch);

        const info = await cashu.addCashuMint('https://outside.example/');

        expect(info).toMatchObject({ url: 'https://outside.example', isNodeMint: false });
        expect(requested.every(url => url.startsWith('https://outside.example/v1/'))).toBe(true);
    });

    // What a browser read through a proxy that had lost a compressed response's encoding.
    function outsideMint() {
        const state = { garbled: false };
        const publicFetch = (async (url: string, init?: RequestInit) => {
            if (state.garbled && url.endsWith('/v1/keysets')) {
                return new Response(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]), { status: 200 });
            }
            return fetch(url.replace('https://outside.example', `${node}/cashu`), init);
        }) as typeof fetch;
        return { state, cashu: walletWith(publicFetch) };
    }

    it('does not save a mint whose keysets cannot be read, and says why', async () => {
        const { state, cashu } = outsideMint();
        state.garbled = true;

        await expect(cashu.addCashuMint('https://outside.example')).rejects.toThrow(/\/v1\/keysets is not JSON/);
        expect(await cashu.listCashuMints()).toEqual([]);
    });

    it('says why listing could not read a mint, and still lists it', async () => {
        const { state, cashu } = outsideMint();
        await cashu.addCashuMint('https://outside.example');
        state.garbled = true;

        expect(await cashu.listCashuMints()).toEqual([{
            url: 'https://outside.example',
            nuts: {},
            keysets: [],
            isNodeMint: false,
            error: expect.stringMatching(/outside\.example: the answer to \/v1\/keysets is not JSON/),
        }]);
    });

    it('requires a mint before anything else', async () => {
        await expect(keymaster.getCashuBalance()).rejects.toThrow(CashuNotConfiguredError);
        await expect(keymaster.sendCashu(1)).rejects.toThrow(CashuNotConfiguredError);
    });

});

describe('minting', () => {
    beforeEach(async () => {
        await setup();
        await keymaster.addCashu();
    });

    // A quote's invoice comes from the mint and may be paid automatically, so an
    // outside mint must not be able to ask for more than the wallet asked for.
    it.each([
        ['more than asked', () => signedInvoice(10000)],
        ['less than asked', () => signedInvoice(20)],
        ['no amount', () => signedInvoice()],
        ['something that is not an invoice', () => 'lnbc-garbage'],
    ])('refuses a quote whose invoice is for %s', async (_case, invoice) => {
        mint.invoiceFor = invoice;

        await expect(keymaster.createCashuMintQuote(21)).rejects.toThrow(CashuMintUnsupportedError);

        expect(await keymaster.listCashuQuotes()).toEqual([]);
    });

    it('claims a paid quote with a NUT-20 signature and credits the balance', async () => {
        const quote = await keymaster.createCashuMintQuote(100);
        expect(quote).toMatchObject({ amount: 100, state: 'UNPAID' });
        expect(mint.mintQuotes.get(quote.quote)!.pubkey).toMatch(/^0[23][0-9a-f]{64}$/);
        expect(await keymaster.listCashuQuotes()).toEqual([
            expect.objectContaining({ kind: 'mint', quote: quote.quote, amount: 100, mint: PUBLIC_URL }),
        ]);

        mint.payMintQuote(quote.quote);
        await expect(keymaster.claimCashuMintQuote(quote.quote)).resolves.toEqual({ amount: 100, mint: PUBLIC_URL });

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 100, inFlight: 0, outstanding: 0 });
        expect(await keymaster.listCashuQuotes()).toEqual([]);
        expect((await entry()).proofs.map((proof: { amount: number }) => proof.amount)).toEqual([4, 32, 64]);
    });

    it('refuses to claim an unpaid quote and keeps it open', async () => {
        const quote = await keymaster.createCashuMintQuote(10);

        await expect(keymaster.claimCashuMintQuote(quote.quote)).rejects.toThrow(CashuQuoteUnpaidError);
        expect(await keymaster.listCashuQuotes()).toHaveLength(1);
    });

    it('reports an expired unpaid quote as unpaid, and drops it', async () => {
        const quote = await keymaster.createCashuMintQuote(10);
        mint.mintQuotes.get(quote.quote)!.expiry = 1;

        await expect(keymaster.claimCashuMintQuote(quote.quote)).rejects.toThrow(CashuQuoteUnpaidError);

        expect(await keymaster.listCashuQuotes()).toEqual([]);
        expect((await keymaster.getCashuBalance()).spendable).toBe(0);
    });

    it('recovers a claim whose response was lost', async () => {
        const quote = await keymaster.createCashuMintQuote(21);
        mint.payMintQuote(quote.quote);
        mint.loseResponse('/v1/mint/bolt11');

        await expect(keymaster.claimCashuMintQuote(quote.quote)).rejects.toThrow(CashuUnavailableError);
        expect((await keymaster.getCashuBalance()).spendable).toBe(0);

        expect(await keymaster.checkCashu()).toEqual({ settled: 1, open: 0 });
        expect((await keymaster.getCashuBalance()).spendable).toBe(21);
    });

    it('claims a paid quote during settlement', async () => {
        const quote = await keymaster.createCashuMintQuote(5);
        mint.payMintQuote(quote.quote);

        await keymaster.checkCashu();

        expect((await keymaster.getCashuBalance()).spendable).toBe(5);
    });

    it('does not touch the network in read methods', async () => {
        const quote = await keymaster.createCashuMintQuote(5);
        mint.payMintQuote(quote.quote);
        mint.requests = [];

        await keymaster.getCashuBalance();
        await keymaster.listCashuQuotes();
        await keymaster.listCashuSends();

        expect(mint.requests).toEqual([]);
    });

    it('survives a process restart with the journal intact', async () => {
        const quote = await keymaster.createCashuMintQuote(9);
        mint.payMintQuote(quote.quote);

        const restarted = newKeymaster();
        await restarted.claimCashuMintQuote(quote.quote);

        expect((await restarted.getCashuBalance()).spendable).toBe(9);
    });
});

describe('sending and receiving', () => {
    beforeEach(async () => {
        await setup();
        await keymaster.addCashu();
        await fund(100);
        await keymaster.createId('Bob');
        await keymaster.addCashu('Bob');
        await keymaster.setCurrentId('Alice');
    });

    it('moves value between identities through a token', async () => {
        const sent = await keymaster.sendCashu(30);
        expect(sent).toMatchObject({ amount: 30, fee: 0 });
        expect(sent.token.startsWith('cashuB')).toBe(true);
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 0, outstanding: 30 });
        expect(await keymaster.listCashuSends()).toEqual([
            expect.objectContaining({ operationId: sent.operationId, amount: 30, mint: PUBLIC_URL }),
        ]);

        await expect(keymaster.receiveCashu(sent.token, 'Bob')).resolves.toEqual({ amount: 30, mint: PUBLIC_URL });

        expect((await keymaster.getCashuBalance(undefined, 'Bob')).spendable).toBe(30);
        await keymaster.checkCashu();
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 0, outstanding: 0 });
        expect(await keymaster.listCashuSends()).toEqual([]);
    });

    it('rejects a token already redeemed, crediting nothing', async () => {
        const { token } = await keymaster.sendCashu(10);
        await keymaster.receiveCashu(token, 'Bob');
        await keymaster.createId('Carol');
        await keymaster.addCashu('Carol');

        await expect(keymaster.receiveCashu(token, 'Carol')).rejects.toThrow(CashuTokenSpentError);

        expect((await keymaster.getCashuBalance(undefined, 'Carol')).spendable).toBe(0);
        expect((await entry(keymaster, 'Carol')).operations).toBeUndefined();
    });

    it('rejects a token from a mint the identity has not added, before any request', async () => {
        const { token } = await keymaster.sendCashu(10);
        await keymaster.createId('Dave');
        await keymaster.addCashu('Dave');
        const other = getEncodedToken({
            mint: 'https://other.example',
            unit: 'sat',
            proofs: [{ id: mint.keysetId, amount: 1 as never, secret: 'aa', C: `02${'ab'.repeat(32)}` }],
        });
        mint.requests = [];

        await expect(keymaster.receiveCashu(other, 'Dave')).rejects.toThrow(CashuMintNotAddedError);
        expect(mint.requests).toEqual([]);
        expect(token).toBeTruthy();
    });

    it('reports an unreachable mint as that, not as a bad token', async () => {
        const { token } = await keymaster.sendCashu(8);
        const fresh = newKeymaster();
        await fresh.setCurrentId('Bob');
        const original = global.fetch;
        const down = jest.fn(async (url: string, init?: RequestInit) => {
            if (url.includes('/v1/keys/')) {
                throw new Error('connection refused');
            }
            return original(url, init);
        });
        global.fetch = down as never;
        try {
            await expect(fresh.receiveCashu(token)).rejects.toThrow(CashuUnavailableError);
        }
        finally {
            global.fetch = original;
        }
    });

    it('stays with the identity it started on when the current one changes', async () => {
        mint.onRequest = async (path) => {
            if (path === '/v1/swap') {
                mint.onRequest = undefined;
                await keymaster.setCurrentId('Bob');
            }
        };

        await expect(keymaster.sendCashu(30)).resolves.toMatchObject({ amount: 30 });

        expect(await keymaster.getCashuBalance(undefined, 'Alice')).toEqual({ spendable: 70, inFlight: 0, outstanding: 30 });
        expect(await keymaster.getCashuBalance(undefined, 'Bob')).toEqual({ spendable: 0, inFlight: 0, outstanding: 0 });
    });

    it('does not let another identity restore the outputs of an unfinished send', async () => {
        mint.loseResponse('/v1/swap');
        await expect(keymaster.sendCashu(30)).rejects.toThrow(CashuUnavailableError);

        await expect(keymaster.restoreCashu(undefined, 'Bob')).resolves.toEqual({ restored: 0, amount: 0 });
        await keymaster.checkCashu();

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 0, outstanding: 30 });
        expect((await keymaster.getCashuBalance(undefined, 'Bob')).spendable).toBe(0);
    });

    async function partlyRedeemed(): Promise<{ operationId: string; four: { secret: string } }> {
        const { operationId } = await keymaster.sendCashu(6);
        const { sent } = (await entry()).operations.find((op: { id: string }) => op.id === operationId);
        const two = sent.find((proof: { amount: number }) => proof.amount === 2);
        mint.spent.add(proofY(two.secret));
        return { operationId, four: sent.find((proof: { amount: number }) => proof.amount === 4) };
    }

    it('re-swaps the unspent part of a partly redeemed reclaim, and says what happened', async () => {
        const { operationId, four } = await partlyRedeemed();

        await expect(keymaster.reclaimCashu(operationId)).resolves.toEqual({ amount: 4, mint: PUBLIC_URL, redeemed: 2 });

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 98, inFlight: 0, outstanding: 0 });
        // The recipient still holds the original, so it must not come back as is.
        expect((await entry()).proofs.map((proof: { secret: string }) => proof.secret)).not.toContain(four.secret);
        expect(mint.spent.has(proofY(four.secret))).toBe(true);
    });

    it('reports what is still in flight when the remainder swap does not finish', async () => {
        const { operationId } = await partlyRedeemed();
        mint.loseResponse('/v1/swap');

        await expect(keymaster.reclaimCashu(operationId)).resolves.toEqual({ amount: 0, mint: PUBLIC_URL, redeemed: 2, pending: 4 });

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 94, inFlight: 4, outstanding: 0 });
        await keymaster.checkCashu();
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 98, inFlight: 0, outstanding: 0 });
    });

    it('does not take a backup\'s stale counters as its own lost response', async () => {
        const stored = await wallet.loadWallet();
        const copy = new WalletJsonMemory();
        await copy.saveWallet(structuredClone(stored!), true);
        const backup = newKeymaster(copy);
        await keymaster.sendCashu(30);

        // The 32 it selects is spent, and the original signed the same counters for
        // other amounts, so this is not its own response to recover.
        await expect(backup.sendCashu(20)).rejects.toThrow(CashuTokenSpentError);

        expect(await backup.getCashuBalance()).toEqual({ spendable: 68, inFlight: 0, outstanding: 0 });
        expect(await backup.listCashuSends()).toEqual([]);
    });

    it('keeps what a backup had not spent when a send selects both', async () => {
        const stored = await wallet.loadWallet();
        const copy = new WalletJsonMemory();
        await copy.saveWallet(structuredClone(stored!), true);
        const backup = newKeymaster(copy);
        await keymaster.sendCashu(30);

        await expect(backup.sendCashu(90)).rejects.toThrow(CashuTokenSpentError);

        expect(await backup.getCashuBalance()).toMatchObject({ spendable: 68, inFlight: 0, outstanding: 0 });
    });

    it('drops proofs the mint reports spent when checking, and reports their value', async () => {
        const four = (await entry()).proofs.find((proof: { amount: number }) => proof.amount === 4);
        mint.spent.add(proofY(four.secret));

        await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 0, open: 0, dropped: 4 });

        expect((await keymaster.getCashuBalance()).spendable).toBe(96);
    });

    it('keeps checking through a mint that cannot report proof states', async () => {
        mint.refuseNext('/v1/checkstate', 20000, 'try later');

        await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 0, open: 0 });

        expect((await keymaster.getCashuBalance()).spendable).toBe(100);
    });

    it('does not read a proof the mint left out as unspent', async () => {
        mint.refuseNext('/v1/swap', 11002, 'transaction unbalanced');
        mint.statesLimit = 0;

        await expect(keymaster.sendCashu(30)).rejects.toThrow(CashuUnavailableError);
        expect((await keymaster.getCashuBalance()).inFlight).toBe(32);

        mint.statesLimit = undefined;
        await keymaster.checkCashu();
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 0, outstanding: 30 });
    });

    it('does not retire an outstanding send on a partial state answer', async () => {
        const { operationId } = await keymaster.sendCashu(30);
        const { sent } = (await entry()).operations.find((op: { id: string }) => op.id === operationId);
        mint.spent.add(proofY(sent[0].secret));
        mint.statesLimit = 1;

        await keymaster.checkCashu();

        expect(await keymaster.listCashuSends()).toHaveLength(1);
    });

    it('swaps the rest of a partly spent token it was receiving, and credits only that', async () => {
        const { token, operationId } = await keymaster.sendCashu(6);
        const sent = (await entry()).operations.find((op: { id: string }) => op.id === operationId).sent;
        mint.spent.add(proofY(sent[0].secret));

        const value = sent[1].amount;
        await expect(keymaster.receiveCashu(token, 'Bob')).resolves.toMatchObject({ amount: value, spent: sent[0].amount });

        expect(await keymaster.getCashuBalance(undefined, 'Bob')).toEqual({ spendable: value, inFlight: 0, outstanding: 0 });
        const held = (await entry(keymaster, 'Bob')).proofs.map((proof: { secret: string }) => proof.secret);
        expect(held).not.toContain(sent[1].secret);
    });

    it('credits nothing of a partly spent token when the mint refuses the rest', async () => {
        const { token, operationId } = await keymaster.sendCashu(6);
        const sent = (await entry()).operations.find((op: { id: string }) => op.id === operationId).sent;
        mint.spent.add(proofY(sent[0].secret));
        let swaps = 0;
        mint.onRequest = async (path) => {
            if (path === '/v1/swap' && ++swaps === 2) {
                mint.refuseNext('/v1/swap', 12345, 'refused');
            }
        };

        await expect(keymaster.receiveCashu(token, 'Bob')).rejects.toThrow(CashuUnavailableError);

        expect(await keymaster.getCashuBalance(undefined, 'Bob')).toEqual({ spendable: 0, inFlight: 0, outstanding: 0 });
    });

    it('does not let settlement submit a record still being saved', async () => {
        const save = wallet.saveWallet.bind(wallet);
        let check: Promise<unknown> | undefined;
        wallet.saveWallet = async (stored, overwrite) => {
            const operations = (await keymaster.loadWallet()).ids.Alice.cashu[PUBLIC_URL].operations ?? [];
            if (!check && operations.some((op: { kind: string; sent?: unknown }) => op.kind === 'send' && !op.sent)) {
                check = keymaster.checkCashu();
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return save(stored, overwrite);
        };
        mint.requests = [];

        await keymaster.sendCashu(30);
        await check;

        expect(mint.requests.filter(request => request === 'POST /v1/swap')).toHaveLength(1);
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 0, outstanding: 30 });
    });

    it('keeps a token outstanding when the mint refuses to reclaim it', async () => {
        const { operationId, token } = await keymaster.sendCashu(30);
        mint.refuseNext('/v1/swap', 11002, 'transaction unbalanced');

        await expect(keymaster.reclaimCashu(operationId)).rejects.toThrow('transaction unbalanced');

        // The recipient still holds these proofs, so they cannot become balance.
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 0, outstanding: 30 });
        expect(await keymaster.listCashuSends()).toEqual([expect.objectContaining({ operationId, amount: 30 })]);

        await keymaster.receiveCashu(token, 'Bob');
        await keymaster.checkCashu();
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 0, outstanding: 0 });
    });

    it('refuses to reclaim a send while settlement is working on it', async () => {
        const { operationId } = await keymaster.sendCashu(30);
        let reclaim: Promise<unknown> | undefined;
        mint.onRequest = async (path) => {
            if (path === '/v1/checkstate' && !reclaim) {
                reclaim = keymaster.reclaimCashu(operationId).catch(error => error);
                await reclaim;
            }
        };

        await keymaster.checkCashu();

        expect(await reclaim).toBeInstanceOf(CashuUnavailableError);
        expect(await keymaster.listCashuSends()).toHaveLength(1);
    });

    it('can retry a reclaim the mint refused', async () => {
        const { operationId } = await keymaster.sendCashu(30);
        mint.refuseNext('/v1/swap', 11002, 'transaction unbalanced');
        await expect(keymaster.reclaimCashu(operationId)).rejects.toThrow('transaction unbalanced');

        await expect(keymaster.reclaimCashu(operationId)).resolves.toEqual({ amount: 30, mint: PUBLIC_URL });

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 100, inFlight: 0, outstanding: 0 });
    });

    it('sends nothing, and keeps its proofs, when the journal cannot be saved', async () => {
        const save = wallet.saveWallet.bind(wallet);
        wallet.saveWallet = async () => { throw new Error('disk full'); };
        mint.requests = [];

        await expect(keymaster.sendCashu(30)).rejects.toThrow('disk full');
        wallet.saveWallet = save;

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 100, inFlight: 0, outstanding: 0 });
        expect(await keymaster.checkCashu()).toEqual({ settled: 0, open: 0 });
        expect(mint.requests).not.toContain('POST /v1/swap');
    });

    it('rejects a token that repeats a proof, crediting nothing', async () => {
        const { getDecodedToken } = await import('@cashu/cashu-ts');
        const { token } = await keymaster.sendCashu(8);
        const decoded = getDecodedToken(token, [mint.keysetId]);
        const doubled = getEncodedToken({ ...decoded, proofs: [...decoded.proofs, ...decoded.proofs] });

        await expect(keymaster.receiveCashu(doubled, 'Bob')).rejects.toThrow('duplicate inputs');

        expect(await keymaster.getCashuBalance(undefined, 'Bob')).toEqual({ spendable: 0, inFlight: 0, outstanding: 0 });
    });

    it('rejects a malformed token', async () => {
        await expect(keymaster.receiveCashu('cashuBnot-a-token')).rejects.toThrow('Invalid parameter: token');
    });

    it('accepts a V3 token', async () => {
        const { token } = await keymaster.sendCashu(8);
        const { getDecodedToken } = await import('@cashu/cashu-ts');
        const decoded = getDecodedToken(token, [mint.keysetId]);
        const v3 = `cashuA${Buffer.from(JSON.stringify({
            token: [{ mint: PUBLIC_URL, proofs: decoded.proofs.map(proof => ({ ...proof, amount: proof.amount.toNumber() })) }],
            unit: 'sat',
        })).toString('base64url')}`;

        await expect(keymaster.receiveCashu(v3, 'Bob')).resolves.toMatchObject({ amount: 8 });
    });

    it('fails a send beyond the balance, with nothing taken', async () => {
        await expect(keymaster.sendCashu(101)).rejects.toThrow(CashuInsufficientFundsError);
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 100, inFlight: 0, outstanding: 0 });
    });

    it('finishes a send whose response was lost', async () => {
        mint.loseResponse('/v1/swap');

        await expect(keymaster.sendCashu(30)).rejects.toThrow(CashuUnavailableError);
        // The 32 proof covers it; the rest of the funding (4 + 64) stays spendable.
        expect(await keymaster.getCashuBalance()).toMatchObject({ spendable: 68, inFlight: 32 });

        await keymaster.checkCashu();

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 0, outstanding: 30 });
    });

    it('finishes a receive whose response was lost, without double counting', async () => {
        const { token } = await keymaster.sendCashu(30);
        mint.loseResponse('/v1/swap');

        await expect(keymaster.receiveCashu(token, 'Bob')).rejects.toThrow(CashuUnavailableError);
        await keymaster.checkCashu(undefined, 'Bob');
        await keymaster.checkCashu(undefined, 'Bob');

        expect((await keymaster.getCashuBalance(undefined, 'Bob')).spendable).toBe(30);
    });

    it('returns owned inputs when the mint rejects a swap, and frees its counters', async () => {
        const before = (await keymaster.loadWallet()).cashu.counters[mint.keysetId].next;
        mint.refuseNext('/v1/swap', 11002, 'transaction unbalanced');

        await expect(keymaster.sendCashu(30)).rejects.toThrow('transaction unbalanced');

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 100, inFlight: 0, outstanding: 0 });
        const counters = (await keymaster.loadWallet()).cashu.counters[mint.keysetId];
        expect(counters.next).toBeGreaterThan(before);
        expect(counters.free.length).toBeGreaterThan(0);

        // Released counters are used before new ones.
        await keymaster.sendCashu(30);
        expect((await keymaster.loadWallet()).cashu.counters[mint.keysetId].free).toEqual([]);
    });

    it('takes back an unredeemed send', async () => {
        const { operationId } = await keymaster.sendCashu(30);

        await expect(keymaster.reclaimCashu(operationId)).resolves.toEqual({ amount: 30, mint: PUBLIC_URL });

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 100, inFlight: 0, outstanding: 0 });
    });

    it('cannot take back a redeemed send', async () => {
        const { token, operationId } = await keymaster.sendCashu(30);
        await keymaster.receiveCashu(token, 'Bob');

        await expect(keymaster.reclaimCashu(operationId)).rejects.toThrow(CashuTokenSpentError);

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 0, outstanding: 0 });
    });

    it('keeps concurrent operations from spending the same proofs', async () => {
        const sends = await Promise.all([keymaster.sendCashu(4), keymaster.sendCashu(4), keymaster.sendCashu(4)]);

        expect(new Set(sends.map(send => send.token)).size).toBe(3);
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 88, inFlight: 0, outstanding: 12 });
    });

    it('rejects a token whose DLEQ proof does not verify, with no request to spend it', async () => {
        const { getDecodedToken } = await import('@cashu/cashu-ts');
        const { token } = await keymaster.sendCashu(8);
        const decoded = getDecodedToken(token, [mint.keysetId]);
        const forged = getEncodedToken({
            ...decoded,
            proofs: decoded.proofs.map(proof => ({ ...proof, dleq: { ...proof.dleq!, s: 'ab'.repeat(32) } })),
        });
        mint.requests = [];

        await expect(keymaster.receiveCashu(forged, 'Bob')).rejects.toThrow('Invalid parameter: token');
        expect(mint.requests).not.toContain('POST /v1/swap');
    });

    it('leaves a swap open when the mint reports its outputs pending', async () => {
        mint.refuseNext('/v1/swap', 11004, 'outputs pending');

        await expect(keymaster.sendCashu(30)).rejects.toThrow(CashuUnavailableError);

        expect((await keymaster.getCashuBalance()).inFlight).toBe(32);
        await keymaster.checkCashu();
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 0, outstanding: 30 });
    });

    it('keeps settlement failures from blocking the operation that triggered them', async () => {
        const quote = await keymaster.createCashuMintQuote(5);
        mint.payMintQuote(quote.quote);
        mint.refuseNext('/v1/mint/bolt11', 20000, 'try later');

        await expect(keymaster.sendCashu(4)).resolves.toMatchObject({ amount: 4 });
        expect(await keymaster.checkCashu()).toMatchObject({ open: 1 });
        expect((await keymaster.getCashuBalance()).spendable).toBe(101);
    });
});

describe('input fees', () => {
    beforeEach(async () => {
        await setup({ inputFeePpk: 500 });
        await keymaster.addCashu();
        await fund(100);
        await keymaster.createId('Bob');
        await keymaster.addCashu('Bob');
        await keymaster.setCurrentId('Alice');
    });

    // 30 is a case with no exact gross: 31 nets 28 after a five-part fee, 32 nets 31.
    it('sends so the recipient nets at least the amount after their redemption fee', async () => {
        const sent = await keymaster.sendCashu(30);
        expect(sent).toMatchObject({ amount: 30, fee: 2 });

        await expect(keymaster.receiveCashu(sent.token, 'Bob')).resolves.toMatchObject({ amount: 31 });
    });

    it('nets exactly the amount when a gross allows it', async () => {
        const sent = await keymaster.sendCashu(31);
        expect(sent.fee).toBe(1);

        await expect(keymaster.receiveCashu(sent.token, 'Bob')).resolves.toMatchObject({ amount: 31 });
    });

    it('never mints or destroys value beyond the fees', async () => {
        const before = (await keymaster.getCashuBalance()).spendable;
        const sent = await keymaster.sendCashu(30);
        const after = await keymaster.getCashuBalance();

        expect(before - after.spendable - after.outstanding).toBeLessThanOrEqual(3);
        expect(after.outstanding).toBe(30 + sent.fee);
    });
});

describe('melting', () => {
    beforeEach(async () => {
        await setup();
        await keymaster.addCashu();
        await fund(200);
    });

    it('pays an invoice and keeps the change from the fee reserve', async () => {
        const result = await keymaster.meltCashu(signedInvoice(100));

        expect(result).toMatchObject({ paid: true, fee: 1, preimage: 'ab'.repeat(32) });
        expect((await keymaster.getCashuBalance()).spendable).toBe(99);
        expect(result.change).toBeGreaterThan(0);
    });

    it('frees the counters of change outputs the mint did not sign', async () => {
        await keymaster.meltCashu(signedInvoice(100));

        const { free } = (await keymaster.loadWallet()).cashu.counters[mint.keysetId];
        expect(free.length).toBeGreaterThan(0);
    });

    it('leaves a pending melt open, then settles it when paid', async () => {
        mint.meltOutcome = 'PENDING';
        const result = await keymaster.meltCashu(signedInvoice(100));

        expect(result).toMatchObject({ paid: false, pending: true, change: 0 });
        expect((await keymaster.getCashuBalance()).inFlight).toBeGreaterThan(0);

        expect(await keymaster.checkCashu()).toEqual({ settled: 0, open: 1 });

        const quote = [...mint.meltQuotes.values()][0];
        quote.state = 'PAID';
        expect(await keymaster.checkCashu()).toEqual({ settled: 1, open: 0 });
        expect((await keymaster.getCashuBalance()).inFlight).toBe(0);
    });

    it('returns the inputs of an unpaid melt', async () => {
        mint.meltOutcome = 'UNPAID';

        const result = await keymaster.meltCashu(signedInvoice(100));

        expect(result).toMatchObject({ paid: false, change: 0 });
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 200, inFlight: 0, outstanding: 0 });
    });

    it('keeps the change when the response was lost', async () => {
        mint.loseResponse('/v1/melt/bolt11');

        await expect(keymaster.meltCashu(signedInvoice(100))).rejects.toThrow(CashuUnavailableError);
        await keymaster.checkCashu();

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 99, inFlight: 0, outstanding: 0 });
    });

    it('requires an invoice', async () => {
        await expect(keymaster.meltCashu(undefined as never)).rejects.toThrow('Invalid parameter: bolt11');
    });

    function spendElsewhere(amount: number) {
        return entry().then((held) => {
            const proof = held.proofs.find((item: { amount: number }) => item.amount === amount);
            mint.spent.add(proofY(proof.secret));
        });
    }

    it('frees the other inputs of a melt whose input was spent elsewhere', async () => {
        await spendElsewhere(64);

        await expect(keymaster.meltCashu(signedInvoice(150))).rejects.toThrow('token already spent');

        // 8 + 128, the 128 swapped to new proofs since another copy may hold it.
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 136, inFlight: 0, outstanding: 0 });
        expect(await keymaster.listCashuQuotes()).toEqual([]);
    });

    it('settles a melt as paid when the quote becomes paid between the two reads', async () => {
        mint.meltOutcome = 'PENDING';
        await keymaster.meltCashu(signedInvoice(100));
        const quote = [...mint.meltQuotes.values()][0];
        quote.state = 'UNPAID';
        mint.onRequest = async (path) => {
            if (path === '/v1/checkstate') {
                quote.state = 'PAID';
            }
        };

        await expect(keymaster.checkCashu()).resolves.toMatchObject({ settled: 1, open: 0 });

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 72, inFlight: 0, outstanding: 0 });
    });

    it('stays open when a re-read quote is neither paid nor unpaid', async () => {
        mint.meltOutcome = 'PENDING';
        await keymaster.meltCashu(signedInvoice(100));
        const quote = [...mint.meltQuotes.values()][0];
        quote.state = 'UNPAID';
        mint.onRequest = async (path) => {
            if (path === '/v1/checkstate') {
                quote.state = 'UNKNOWN' as never;
            }
        };

        await expect(keymaster.checkCashu()).resolves.toMatchObject({ settled: 0, open: 1 });
    });

    it('fails a melt it cannot cover', async () => {
        await expect(keymaster.meltCashu(signedInvoice(500))).rejects.toThrow(CashuInsufficientFundsError);
    });
});

describe('recovery', () => {
    beforeEach(async () => {
        await setup();
        await keymaster.addCashu();
        await fund(100);
    });

    async function recovered(): Promise<Keymaster> {
        const mnemonic = await keymaster.decryptMnemonic();
        const other = newKeymaster(new WalletJsonMemory());
        await other.newWallet(mnemonic);
        await other.createId('Alice');
        await other.addCashu();
        return other;
    }

    it('restores unspent proofs from the mnemonic, and only once', async () => {
        const other = await recovered();

        await expect(other.restoreCashu()).resolves.toEqual({ restored: expect.any(Number), amount: 100 });
        await expect(other.restoreCashu()).resolves.toMatchObject({ amount: 0 });

        expect((await other.getCashuBalance()).spendable).toBe(100);
        const { next } = (await other.loadWallet()).cashu.counters[mint.keysetId];
        expect(next).toBeGreaterThan(0);
    });

    it('does not restore spent proofs', async () => {
        await keymaster.meltCashu(signedInvoice(90));
        const balance = (await keymaster.getCashuBalance()).spendable;
        const other = await recovered();

        await other.restoreCashu();

        expect((await other.getCashuBalance()).spendable).toBe(balance);
    });

    // cdk-mintd answers a mint request with 20006 where NUT-00 lists 11003.
    it.each([11003, 20006])('repairs stale counters on a mint request refused with %d', async (code) => {
        mint.alreadySignedCode = code;
        const other = await recovered();

        // Its counters start at zero, which the first wallet already used.
        await expect(fund(40, undefined, other)).resolves.toBeUndefined();

        expect((await other.getCashuBalance()).spendable).toBe(140);
    });

    async function withStaleCounters(): Promise<Keymaster> {
        const other = await recovered();
        await other.restoreCashu();
        await (other as any).mutateWallet((stored: any) => {
            stored.cashu.counters[mint.keysetId] = { next: 0, free: [] };
        });
        return other;
    }

    it('repairs stale counters on a swap', async () => {
        const other = await withStaleCounters();

        await expect(other.sendCashu(10)).resolves.toMatchObject({ amount: 10 });

        expect((await other.getCashuBalance()).spendable).toBe(90);
    });

    it('repairs stale counters on a melt', async () => {
        const other = await withStaleCounters();

        await expect(other.meltCashu(signedInvoice(50))).resolves.toMatchObject({ paid: true });

        expect((await other.getCashuBalance()).spendable).toBe(49);
    });

    it('fails a refused request whose outputs were not signed, without a scan', async () => {
        const quote = await keymaster.createCashuMintQuote(5);
        mint.payMintQuote(quote.quote);
        mint.refuseNext('/v1/mint/bolt11', 20000, 'try later');

        await expect(keymaster.claimCashuMintQuote(quote.quote)).rejects.toThrow('try later');

        expect(mint.requests.filter(request => request === 'POST /v1/restore')).toHaveLength(1);
        expect(await keymaster.listCashuQuotes()).toHaveLength(1);
    });

    it('finds nothing to restore on an empty keyset, after three empty batches', async () => {
        await mint.stop();
        await setup();
        await keymaster.addCashu();
        mint.requests = [];

        await expect(keymaster.restoreCashu()).resolves.toEqual({ restored: 0, amount: 0 });
        expect(mint.requests.filter(request => request === 'POST /v1/restore')).toHaveLength(3);
    });
});

describe('keyset rotation', () => {
    const keysetsHeld = async () => new Set((await entry()).proofs.map((proof: { id: string }) => proof.id));

    describe('without fees', () => {
        beforeEach(async () => {
            await setup();
            await keymaster.addCashu();
            await fund(100);
        });

        it('moves proofs from an inactive keyset to the active one when checking', async () => {
            mint.rotate();

            await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 0, open: 0, rotated: 100 });

            expect(await keysetsHeld()).toEqual(new Set([mint.keysetId]));
            expect(await keymaster.getCashuBalance()).toEqual({ spendable: 100, inFlight: 0, outstanding: 0 });
            await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 0, open: 0 });
        });

        it('leaves proofs alone while their keyset is active', async () => {
            mint.requests = [];

            await keymaster.checkCashu();

            expect(mint.requests).not.toContain('POST /v1/swap');
        });

        it('moves proofs only when checking', async () => {
            const before = (await entry()).proofs.find((proof: { amount: number }) => proof.amount === 4);
            mint.rotate();

            await keymaster.sendCashu(40);

            const after = (await entry()).proofs.find((proof: { secret: string }) => proof.secret === before.secret);
            expect(after.id).toBe(before.id);
            expect(after.id).not.toBe(mint.keysetId);
        });

        it('keeps the proofs spendable when the mint refuses the move', async () => {
            const before = await keysetsHeld();
            mint.rotate();
            mint.refuseNext('/v1/swap', 11002, 'transaction unbalanced');

            await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 0, open: 0 });

            expect(await keysetsHeld()).toEqual(before);
            expect(await keymaster.getCashuBalance()).toEqual({ spendable: 100, inFlight: 0, outstanding: 0 });
            await expect(keymaster.checkCashu()).resolves.toMatchObject({ rotated: 100 });
        });

        it('finishes the move on the next check when the response was lost', async () => {
            mint.rotate();
            mint.loseResponse('/v1/swap');

            await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 0, open: 0 });
            expect((await keymaster.getCashuBalance()).inFlight).toBe(100);

            await expect(keymaster.checkCashu()).resolves.toMatchObject({ settled: 1, open: 0 });
            expect(await keymaster.getCashuBalance()).toEqual({ spendable: 100, inFlight: 0, outstanding: 0 });
            expect(await keysetsHeld()).toEqual(new Set([mint.keysetId]));
        });

        it('does not move a sent token', async () => {
            await keymaster.sendCashu(6);
            mint.rotate();

            await keymaster.checkCashu();

            expect((await keymaster.getCashuBalance()).outstanding).toBe(6);
        });

        it('accepts a token from an inactive keyset', async () => {
            const { token } = await keymaster.sendCashu(6);
            await keymaster.createId('Bob');
            await keymaster.addCashu('Bob');
            mint.rotate();

            await expect(keymaster.receiveCashu(token, 'Bob')).resolves.toMatchObject({ amount: 6 });

            expect((await entry(keymaster, 'Bob')).proofs.every((proof: { id: string }) => proof.id === mint.keysetId)).toBe(true);
        });

        it('restores proofs from an inactive keyset', async () => {
            const mnemonic = await keymaster.decryptMnemonic();
            mint.rotate();
            const other = newKeymaster(new WalletJsonMemory());
            await other.newWallet(mnemonic);
            await other.createId('Alice');
            await other.addCashu();

            await expect(other.restoreCashu()).resolves.toMatchObject({ amount: 100 });
        });
    });

    describe('with input fees', () => {
        beforeEach(async () => {
            await setup({ inputFeePpk: 1000 });
            await keymaster.addCashu();
        });

        it('pays the fee out of the value it moves', async () => {
            await fund(100);
            mint.rotate();

            // Three proofs at one sat each.
            await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 0, open: 0, rotated: 97 });

            expect((await keymaster.getCashuBalance()).spendable).toBe(97);
        });

        it('leaves proofs worth no more than the fee to move them', async () => {
            await fund(1);
            mint.rotate();
            mint.requests = [];

            await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 0, open: 0 });

            expect(mint.requests).not.toContain('POST /v1/swap');
            expect((await keymaster.getCashuBalance()).spendable).toBe(1);
        });
    });
});

describe('removal guards', () => {
    beforeEach(async () => {
        await setup();
        await keymaster.addCashu();
    });

    it('removes an empty mint', async () => {
        await keymaster.removeCashuMint(PUBLIC_URL);

        expect((await keymaster.loadWallet()).ids.Alice.cashu).toBeUndefined();
    });

    it('refuses to discard proofs or journal records unless forced', async () => {
        await keymaster.createCashuMintQuote(5);

        await expect(keymaster.removeCashuMint(PUBLIC_URL)).rejects.toThrow(CashuStateError);
        await expect(keymaster.removeCashu()).rejects.toThrow(CashuStateError);

        await keymaster.removeCashu(true);
        expect((await keymaster.loadWallet()).ids.Alice.cashu).toBeUndefined();
    });

    it.each(['false', 'true', 1, {}])('does not take %j as force', async (force) => {
        await keymaster.createCashuMintQuote(5);

        await expect(keymaster.removeCashu(force as never)).rejects.toThrow(CashuStateError);
        await expect(keymaster.removeCashuMint(PUBLIC_URL, force as never)).rejects.toThrow(CashuStateError);
    });

    it('refuses to remove an identity holding Cashu state', async () => {
        await fund(5);

        await expect(keymaster.removeId('Alice')).rejects.toThrow(CashuStateError);
    });

    it('keeps an identity holding Cashu state in fixWallet, and reports it', async () => {
        await fund(5);
        const { did } = await keymaster.fetchIdInfo();
        await keymaster.revokeDID(did);

        const result = await keymaster.fixWallet();

        expect(result).toMatchObject({ idsRemoved: 0, idsKept: ['Alice'] });
        expect((await keymaster.loadWallet()).ids.Alice).toBeDefined();
    });
});

describe('several mints', () => {
    beforeEach(async () => {
        await setup();
        await keymaster.addCashu();
    });

    function addOutside(url: string) {
        return (keymaster as any).mutateWallet(async (stored: any) => {
            stored.ids.Alice.cashu[url] = { added: 'now', proofs: [{ id: 'x', amount: 7, secret: 'a', C: 'b' }] };
        });
    }

    it('defaults to the node mint, and totals the balance across all', async () => {
        await addOutside('https://outside.example');
        await fund(10);

        const balance = await keymaster.getCashuBalance();

        expect(balance).toMatchObject({ spendable: 17, inFlight: 0, outstanding: 0 });
        expect(balance.mints![PUBLIC_URL].spendable).toBe(10);
        await expect(keymaster.getCashuBalance('https://outside.example')).resolves.toMatchObject({ spendable: 7 });
    });

    it('requires a mint when the identity has several and none is the node mint', async () => {
        await addOutside('https://outside.example');
        await addOutside('https://other.example');
        await keymaster.removeCashuMint(PUBLIC_URL);

        await expect(keymaster.sendCashu(1)).rejects.toThrow(/mint is required/);
    });

    it('refuses a mint the identity has not added', async () => {
        await expect(keymaster.sendCashu(1, 'https://nope.example')).rejects.toThrow(CashuMintNotAddedError);
    });
});
