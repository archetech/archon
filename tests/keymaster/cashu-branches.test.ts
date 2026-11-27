import { jest } from '@jest/globals';
import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import {
    CashuMintNotAddedError,
    CashuMintUnsupportedError,
    CashuTokenSpentError,
    CashuUnavailableError,
    InvalidParameterError,
} from '@didcid/common/errors';
import {
    OutputData,
    createRandomSecretKey,
    getDecodedToken,
    getEncodedToken,
    getPubKeyFromPrivKey,
} from '@cashu/cashu-ts';
import type { P2PKOptions } from '@cashu/cashu-ts';
import { signedInvoice } from '../cli/helpers.ts';
import { CASHU_TOKEN_TYPE, cashuToken } from '../../packages/keymaster/src/didcomm-protocols.ts';
import { CashuWallet, hasCashuState, normalizeMintUrl, p2pkLock, proofY } from '../../packages/keymaster/src/cashu.ts';
import type { CashuHost } from '../../packages/keymaster/src/cashu.ts';
import { FakeMint } from './cashu-fake-mint.ts';
import type { FakeMintOptions } from './cashu-fake-mint.ts';

const PUBLIC_URL = 'https://mint.example/cashu';
const OUTSIDE = 'https://outside.example';

let ipfs: MemoryClient;
let mint: FakeMint;
let node: string;
let gatekeeper: any;
let wallet: WalletJsonMemory;
let keymaster: Keymaster;
let restoreFetch: (() => void) | undefined;

function newKeymaster(store = wallet): Keymaster {
    return new Keymaster({ gatekeeper, wallet: store, cipher: new CipherNode(), passphrase: 'passphrase' });
}

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
    keymaster = newKeymaster();
    await keymaster.newWallet();
    await keymaster.createId('Alice');
}

afterEach(async () => {
    restoreFetch?.();
    restoreFetch = undefined;
    jest.restoreAllMocks();
    await mint?.stop();
    await ipfs?.stop?.();
    mint = undefined as unknown as FakeMint;
});

async function fund(amount: number, id?: string, km = keymaster): Promise<void> {
    const quote = await km.createCashuMintQuote(amount, undefined, id);
    mint.payMintQuote(quote.quote);
    await km.claimCashuMintQuote(quote.quote, undefined, id);
}

async function entry(km = keymaster, id = 'Alice', url = PUBLIC_URL) {
    return (await km.loadWallet()).ids[id].cashu[url];
}

async function counters(km = keymaster) {
    return (await km.loadWallet()).cashu.counters[mint.keysetId];
}

async function copyOfWallet(): Promise<Keymaster> {
    const copy = new WalletJsonMemory();
    await copy.saveWallet(structuredClone((await wallet.loadWallet())!), true);
    return newKeymaster(copy);
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The node's mint is reached through the global fetch, so a test can stand
// between the wallet and the fake mint to give an answer some other mint would.
function onMint(handler: (path: string, forward: () => Promise<Response>) => Promise<Response>): void {
    const original = global.fetch;
    const prefix = `${node}/cashu`;
    global.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith(prefix)) {
            return original(input, init);
        }
        return handler(url.slice(prefix.length), () => original(input, init));
    }) as typeof fetch;
    restoreFetch = () => { global.fetch = original; };
}

async function edited(forward: () => Promise<Response>, edit: (body: any) => any): Promise<Response> {
    const response = await forward();
    return json(edit(await response.json()), response.status);
}

// A proof the wallet has not checked yet: it is refused or accepted on its
// secret before the mint is asked to verify its signature.
function unsignedToken(secret: string, amount = 1): string {
    return getEncodedToken({
        mint: PUBLIC_URL,
        unit: 'sat',
        proofs: [{ id: mint.keysetId, amount, secret, C: `02${'00'.repeat(32)}` }] as never,
    });
}

function lockedSecret(tags: string[][]): string {
    return JSON.stringify(['P2PK', { nonce: '00', data: `02${'11'.repeat(32)}`, tags }]);
}

// A P2PK token the fake mint really signed, minted outside the wallet.
async function mintLocked(amount: number, lock: P2PKOptions): Promise<string> {
    const base = `${node}/cashu`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then(response => response.json() as Promise<any>);
    const { quote } = await post('/v1/mint/quote/bolt11', { amount, unit: 'sat' });
    mint.payMintQuote(quote);
    const data = OutputData.createSingleP2PKData(lock, amount as never, mint.keysetId);
    const { signatures } = await post('/v1/mint/bolt11', {
        quote,
        outputs: [{ amount, id: mint.keysetId, B_: data.blindedMessage.B_ }],
    });
    const { keysets } = await fetch(`${base}/v1/keys/${mint.keysetId}`).then(response => response.json() as Promise<any>);
    const proof = data.toProof(signatures[0], keysets[0]);
    return getEncodedToken({ mint: PUBLIC_URL, unit: 'sat', proofs: [proof] });
}

describe('helpers', () => {
    it('refuses a mint url that is not http or https', () => {
        expect(() => normalizeMintUrl('ftp://mint.example')).toThrow(InvalidParameterError);
        expect(() => normalizeMintUrl('file:///etc/mint')).toThrow('Invalid parameter: mint url');
    });

    it('reads a P2PK secret with no tags as one key, one signature, no locktime', () => {
        const secret = JSON.stringify(['P2PK', { nonce: '00', data: '02ab' }]);

        expect(p2pkLock(secret)).toEqual({ keys: ['02ab'], refund: [], signatures: 1, refundSignatures: 1, sigAll: false });
    });

    it('treats an identity as holding Cashu state only for proofs or open records', () => {
        expect(hasCashuState({ did: 'did:x' } as never)).toBe(false);
        expect(hasCashuState({ did: 'did:x', cashu: { [PUBLIC_URL]: { added: 'now', proofs: [] } } } as never)).toBe(false);
        expect(hasCashuState({
            did: 'did:x',
            cashu: { [PUBLIC_URL]: { added: 'now', proofs: [], operations: [{ id: 'op' }] } },
        } as never)).toBe(true);
    });
});

describe('what a mint answers', () => {
    beforeEach(async () => {
        await setup();
        await keymaster.addCashu();
    });

    it.each([
        ['a detail and no code', { detail: 'amount too large' }, 'Keymaster: mint refused: amount too large', undefined],
        ['a code and no detail', { code: 11005 }, 'Keymaster: mint refused: error 11005', 11005],
    ])('reports a refusal with %s', async (_case, body, message, code) => {
        onMint(async (path, forward) => path === '/v1/mint/quote/bolt11' ? json(body, 400) : forward());

        const error = await keymaster.createCashuMintQuote(10).catch(caught => caught);

        expect(error.message).toBe(message);
        expect(error.code).toBe(code);
        expect(await keymaster.listCashuQuotes()).toEqual([]);
    });

    it('reports an error page that is not JSON as the mint being unavailable', async () => {
        onMint(async (path, forward) => path === '/v1/mint/quote/bolt11'
            ? new Response('<html>Bad gateway</html>', { status: 502 })
            : forward());

        await expect(keymaster.createCashuMintQuote(10)).rejects.toThrow(CashuUnavailableError);
        await expect(keymaster.createCashuMintQuote(10)).rejects.toThrow(/HTTP 502/);
    });

    it('refuses to use a mint with no active keyset', async () => {
        await fund(10);
        onMint(async (path, forward) => path === '/v1/keysets'
            ? edited(forward, body => ({ keysets: body.keysets.map((keyset: object) => ({ ...keyset, active: false })) }))
            : forward());

        await expect(keymaster.sendCashu(5)).rejects.toThrow(/has no active sat keyset/);

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 10, inFlight: 0, outstanding: 0 });
    });

    // NUT-02 makes input_fee_ppk optional; a mint that leaves it out charges nothing.
    it('treats a keyset with no input fee as free', async () => {
        await fund(100);
        await keymaster.createId('Bob');
        await keymaster.addCashu('Bob');
        onMint(async (path, forward) => path === '/v1/keysets'
            ? edited(forward, body => ({
                keysets: body.keysets.map(({ input_fee_ppk: _fee, ...keyset }: { input_fee_ppk?: number }) => keyset),
            }))
            : forward());

        const sent = await keymaster.sendCashu(30, undefined, 'Alice');

        expect(sent).toMatchObject({ amount: 30, fee: 0 });
        await expect(keymaster.receiveCashu(sent.token, 'Bob')).resolves.toEqual({ amount: 30, mint: PUBLIC_URL });
    });

    it('uses the cheapest of several active keysets', async () => {
        await fund(100);
        const expensive = { id: '00aaaaaaaaaaaaaa', unit: 'sat', active: true, input_fee_ppk: 100 };
        const pricier = { id: '00bbbbbbbbbbbbbb', unit: 'sat', active: true, input_fee_ppk: 200 };
        onMint(async (path, forward) => path === '/v1/keysets'
            ? edited(forward, body => ({
                keysets: [
                    expensive,
                    // The real keyset, with its fee left out, which counts as none.
                    ...body.keysets.map(({ input_fee_ppk: _fee, ...keyset }: { input_fee_ppk?: number }) => keyset),
                    pricier,
                ],
            }))
            : forward());

        const { token, fee } = await keymaster.sendCashu(30);

        expect(fee).toBe(0);
        const ids = getDecodedToken(token, [mint.keysetId, expensive.id, pricier.id]).proofs.map(proof => proof.id);
        expect(new Set(ids)).toEqual(new Set([mint.keysetId]));
    });

    it('spends proofs of a keyset the mint has stopped listing', async () => {
        await fund(100);
        mint.rotate();
        onMint(async (path, forward) => path === '/v1/keysets'
            ? edited(forward, body => ({ keysets: body.keysets.filter((keyset: { active: boolean }) => keyset.active) }))
            : forward());

        await expect(keymaster.sendCashu(30)).resolves.toMatchObject({ amount: 30, fee: 0 });

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 0, outstanding: 30 });
    });

    it('lists a mint whose info no longer names its NUTs', async () => {
        onMint(async (path, forward) => path === '/v1/info' ? json({ name: 'Quiet mint' }) : forward());

        expect(await keymaster.listCashuMints()).toEqual([
            expect.objectContaining({ url: PUBLIC_URL, name: 'Quiet mint', nuts: {}, isNodeMint: true }),
        ]);
    });

    it('records no expiry for a quote the mint gives none', async () => {
        onMint(async (path, forward) => path === '/v1/mint/quote/bolt11'
            ? edited(forward, body => ({ ...body, expiry: null }))
            : forward());

        const quote = await keymaster.createCashuMintQuote(10);

        expect(quote.expiry).toBeUndefined();
        expect((await entry()).operations[0]).not.toHaveProperty('expiry');
    });

    it('drops an unpaid quote by the expiry it was created with, when the mint no longer says', async () => {
        onMint(async (path, forward) => {
            if (path === '/v1/mint/quote/bolt11') {
                return edited(forward, body => ({ ...body, expiry: 1 }));
            }
            if (path.startsWith('/v1/mint/quote/bolt11/')) {
                return edited(forward, ({ expiry: _expiry, ...body }) => body);
            }
            return forward();
        });
        const quote = await keymaster.createCashuMintQuote(10);
        expect(quote.expiry).toBe(1);

        await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 1, open: 0 });

        expect(await keymaster.listCashuQuotes()).toEqual([]);
    });

    it('collects melt change by restoring it when the quote does not list it', async () => {
        await fund(200);
        mint.loseResponse('/v1/melt/bolt11');
        onMint(async (path, forward) => path.startsWith('/v1/melt/quote/bolt11/')
            ? edited(forward, ({ change: _change, ...body }) => body)
            : forward());

        await expect(keymaster.meltCashu(signedInvoice(100))).rejects.toThrow(CashuUnavailableError);
        await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 1, open: 0 });

        // 100 paid and 1 of the reserve spent on routing: the rest is change.
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 99, inFlight: 0, outstanding: 0 });
    });

    it('keeps a refused swap open while the mint reports its inputs pending', async () => {
        await fund(100);
        mint.refuseNext('/v1/swap', 11002, 'transaction unbalanced');
        onMint(async (path, forward) => path === '/v1/checkstate'
            ? edited(forward, body => ({ states: body.states.map((state: object) => ({ ...state, state: 'PENDING' })) }))
            : forward());

        await expect(keymaster.sendCashu(30)).rejects.toThrow(/has the send pending/);
        expect((await keymaster.getCashuBalance()).inFlight).toBe(32);

        restoreFetch!();
        restoreFetch = undefined;
        await keymaster.checkCashu();
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 0, outstanding: 30 });
    });

    it('keeps an unpaid melt open while the mint reports its inputs pending', async () => {
        await fund(200);
        mint.meltOutcome = 'UNPAID';
        onMint(async (path, forward) => path === '/v1/checkstate'
            ? edited(forward, body => ({ states: body.states.map((state: object) => ({ ...state, state: 'PENDING' })) }))
            : forward());

        await expect(keymaster.meltCashu(signedInvoice(100))).resolves.toEqual({ paid: false, pending: true, change: 0 });

        expect((await keymaster.getCashuBalance()).inFlight).toBe(128);
        expect(await keymaster.listCashuQuotes()).toEqual([expect.objectContaining({ kind: 'melt', amount: 100 })]);
    });

    it('keeps checking when the mint cannot be reached for proof states', async () => {
        await fund(10);
        onMint(async (path, forward) => {
            if (path === '/v1/checkstate') {
                throw new TypeError('fetch failed');
            }
            return forward();
        });

        await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 0, open: 0 });

        expect((await keymaster.getCashuBalance()).spendable).toBe(10);
    });
});

describe('the identity and its mints', () => {
    beforeEach(() => setup());

    function cashuWith(overrides: Partial<CashuHost>, publicFetch?: typeof fetch): CashuWallet {
        const host = (keymaster as any).cashu.host as CashuHost;
        return new CashuWallet({ ...host, ...overrides }, publicFetch);
    }

    it('does not ask for the node mint when the node says it offers none', async () => {
        const getCashuMint = jest.fn(async () => PUBLIC_URL);
        const cashu = cashuWith({
            gatekeeper: { url: node, getCashuMint },
            getCapabilities: async () => ({ cashu: false }),
        });

        await expect(cashu.addCashu()).rejects.toThrow(/addCashuMint/);

        expect(getCashuMint).not.toHaveBeenCalled();
        expect(await keymaster.listCashuMints()).toEqual([]);
    });

    it('uses an identity\'s only mint by default when it is not the node\'s', async () => {
        const publicFetch = ((url: string, init?: RequestInit) =>
            fetch(url.replace(OUTSIDE, `${node}/cashu`), init)) as typeof fetch;
        const cashu = cashuWith({}, publicFetch);
        await cashu.addCashuMint(OUTSIDE);

        const quote = await cashu.createCashuMintQuote(10);

        expect(await cashu.listCashuQuotes()).toEqual([expect.objectContaining({ quote: quote.quote, mint: OUTSIDE })]);
    });

    it('keeps the node mint\'s ecash and records when its public address changes', async () => {
        await keymaster.addCashu();
        await fund(100);
        const { operationId } = await keymaster.sendCashu(30);
        const { quote } = await keymaster.createCashuMintQuote(5);
        const moved = 'https://new.example/cashu';
        gatekeeper.getCashuMint = async () => moved;

        await expect(keymaster.addCashu()).resolves.toMatchObject({ url: moved, isNodeMint: true });

        const mints = (await keymaster.loadWallet()).ids.Alice.cashu;
        expect(Object.keys(mints)).toEqual([moved]);
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 0, outstanding: 30 });
        expect(await keymaster.listCashuSends()).toEqual([expect.objectContaining({ operationId, mint: moved })]);
        expect(await keymaster.listCashuQuotes()).toEqual([expect.objectContaining({ quote, mint: moved })]);
    });

    it('does not move ecash to a different mint the node now serves', async () => {
        await keymaster.addCashu();
        await fund(100);
        // A new mint behind the same node: none of the held proofs' keysets are its own.
        mint.keysets.clear();
        mint.rotate();
        const other = 'https://new.example/cashu';
        gatekeeper.getCashuMint = async () => other;

        await keymaster.addCashu();

        const mints = (await keymaster.loadWallet()).ids.Alice.cashu;
        expect(Object.keys(mints).sort()).toEqual([other, PUBLIC_URL].sort());
        expect(mints[other].proofs).toEqual([]);
        expect(await keymaster.getCashuBalance(PUBLIC_URL)).toMatchObject({ spendable: 100 });
    });

    it('refuses a mint the identity has not added, in every method that names one', async () => {
        await keymaster.addCashu();

        await expect(keymaster.removeCashuMint(OUTSIDE)).rejects.toThrow(CashuMintNotAddedError);
        await expect(keymaster.getCashuBalance(OUTSIDE)).rejects.toThrow(CashuMintNotAddedError);
        await expect(keymaster.listCashuQuotes(OUTSIDE)).rejects.toThrow(CashuMintNotAddedError);
        await expect(keymaster.listCashuSends(OUTSIDE)).rejects.toThrow(CashuMintNotAddedError);
    });

    it('lists only quotes, from the mint named', async () => {
        await keymaster.addCashu();
        await fund(100);
        mint.loseResponse('/v1/swap');
        await expect(keymaster.sendCashu(30)).rejects.toThrow(CashuUnavailableError);
        const { quote } = await keymaster.createCashuMintQuote(5);

        expect(await keymaster.listCashuQuotes(`${PUBLIC_URL}/`)).toEqual([
            expect.objectContaining({ kind: 'mint', quote, mint: PUBLIC_URL }),
        ]);
    });

    it('records no quote for a mint removed while the quote was being made', async () => {
        await keymaster.addCashu();
        mint.onRequest = async (path) => {
            if (path === '/v1/mint/quote/bolt11') {
                mint.onRequest = undefined;
                await keymaster.removeCashuMint(PUBLIC_URL, true);
            }
        };

        await expect(keymaster.createCashuMintQuote(10)).rejects.toThrow(CashuMintNotAddedError);

        expect((await keymaster.loadWallet()).ids.Alice.cashu).toBeUndefined();
    });
});

describe('argument checks', () => {
    beforeEach(async () => {
        await setup();
        await keymaster.addCashu();
        mint.requests = [];
    });

    it.each([0, -1, 1.5, '10', Number.MAX_SAFE_INTEGER + 1])('refuses to quote or send the amount %p', async (amount) => {
        await expect(keymaster.createCashuMintQuote(amount as never)).rejects.toThrow('Invalid parameter: amount');
        await expect(keymaster.sendCashu(amount as never)).rejects.toThrow('Invalid parameter: amount');

        expect(mint.requests).toEqual([]);
    });

    it('refuses to claim a quote it has no record of', async () => {
        await expect(keymaster.claimCashuMintQuote('mq-unknown')).rejects.toThrow('Invalid parameter: quote');

        expect(mint.requests).toEqual([]);
    });

    it('refuses to reclaim an operation that is not an outstanding send', async () => {
        await expect(keymaster.reclaimCashu('not-an-operation')).rejects.toThrow('Invalid parameter: operationId');
    });
});

describe('minting', () => {
    it('claims a quote without a signature from a mint without NUT-20', async () => {
        await setup({ nut20: false });
        await keymaster.addCashu();

        const quote = await keymaster.createCashuMintQuote(10);
        expect(mint.mintQuotes.get(quote.quote)!.pubkey).toBeUndefined();
        expect((await entry()).operations[0]).not.toHaveProperty('quoteKey');
        mint.payMintQuote(quote.quote);

        await expect(keymaster.claimCashuMintQuote(quote.quote)).resolves.toEqual({ amount: 10, mint: PUBLIC_URL });
    });

    describe('with the node mint', () => {
        beforeEach(async () => {
            await setup();
            await keymaster.addCashu();
        });

        it('refuses a second claim of a quote while the first is under way', async () => {
            const quote = await keymaster.createCashuMintQuote(10);
            mint.payMintQuote(quote.quote);
            let second: Promise<unknown> | undefined;
            mint.onRequest = async (path) => {
                if (path.startsWith('/v1/mint/quote/bolt11/') && !second) {
                    second = keymaster.claimCashuMintQuote(quote.quote).catch(error => error);
                    await second;
                }
            };

            await expect(keymaster.claimCashuMintQuote(quote.quote)).resolves.toEqual({ amount: 10, mint: PUBLIC_URL });

            const error = await second;
            expect(error).toBeInstanceOf(CashuUnavailableError);
            expect((error as Error).message).toMatch(/already being claimed/);
            expect((await keymaster.getCashuBalance()).spendable).toBe(10);
        });

        it('keeps a claim open when the mint reports its outputs pending, and finishes it later', async () => {
            const quote = await keymaster.createCashuMintQuote(10);
            mint.payMintQuote(quote.quote);
            mint.refuseNext('/v1/mint/bolt11', 11004, 'outputs pending');

            await expect(keymaster.claimCashuMintQuote(quote.quote)).rejects.toThrow();
            expect(await keymaster.listCashuQuotes()).toEqual([expect.objectContaining({ quote: quote.quote })]);
            // Pending means the mint is working on it: no restore scan for stale counters.
            expect(mint.requests).not.toContain('POST /v1/restore');

            await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 1, open: 0 });
            expect((await keymaster.getCashuBalance()).spendable).toBe(10);
        });

        it('collects its outputs when another copy of the wallet claims the quote first', async () => {
            const quote = await keymaster.createCashuMintQuote(10);
            mint.payMintQuote(quote.quote);
            const backup = await copyOfWallet();
            let raced = false;
            mint.onRequest = async (path) => {
                if (path === '/v1/mint/bolt11' && !raced) {
                    raced = true;
                    await backup.claimCashuMintQuote(quote.quote);
                }
            };

            await expect(keymaster.claimCashuMintQuote(quote.quote)).resolves.toEqual({ amount: 10, mint: PUBLIC_URL });

            expect(await keymaster.getCashuBalance()).toEqual({ spendable: 10, inFlight: 0, outstanding: 0 });
            expect(await keymaster.listCashuQuotes()).toEqual([]);
        });

        it('frees its counters when someone else was issued the quote', async () => {
            const quote = await keymaster.createCashuMintQuote(5);
            mint.payMintQuote(quote.quote);
            mint.refuseNext('/v1/mint/bolt11', 20000, 'try later');
            await expect(keymaster.claimCashuMintQuote(quote.quote)).rejects.toThrow('try later');
            expect(await counters()).toEqual({ next: 2, free: [] });

            mint.mintQuotes.get(quote.quote)!.state = 'ISSUED';

            await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 1, open: 0 });
            expect((await keymaster.getCashuBalance()).spendable).toBe(0);
            expect(await keymaster.listCashuQuotes()).toEqual([]);
            expect(await counters()).toEqual({ next: 2, free: [[0, 1]] });
        });
    });
});

describe('melting', () => {
    beforeEach(async () => {
        await setup();
        await keymaster.addCashu();
        await fund(200);
    });

    it('drops a melt whose only input was spent elsewhere, and keeps the rest', async () => {
        const held = (await entry()).proofs.find((proof: { amount: number }) => proof.amount === 128);
        mint.spent.add(proofY(held.secret));

        await expect(keymaster.meltCashu(signedInvoice(100))).rejects.toThrow('token already spent');

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 72, inFlight: 0, outstanding: 0 });
        expect(await keymaster.listCashuQuotes()).toEqual([]);
    });
});

describe('settlement', () => {
    beforeEach(async () => {
        await setup();
        await keymaster.addCashu();
        await fund(100);
    });

    async function pendingSend(): Promise<void> {
        mint.refuseNext('/v1/swap', 11004, 'outputs pending');
        await expect(keymaster.sendCashu(30)).rejects.toThrow(/has the send pending/);
    }

    it('counts a record the mint then refuses as settled, and returns its inputs', async () => {
        await pendingSend();
        mint.refuseNext('/v1/swap', 11002, 'transaction unbalanced');

        await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 1, open: 0 });

        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 100, inFlight: 0, outstanding: 0 });
    });

    it('stops on a failure to save the wallet, and finishes on the next check', async () => {
        await pendingSend();
        const save = wallet.saveWallet.bind(wallet);
        wallet.saveWallet = async () => { throw new Error('disk full'); };

        await expect(keymaster.checkCashu()).rejects.toThrow('disk full');

        wallet.saveWallet = save;
        await keymaster.checkCashu();
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 0, outstanding: 30 });
    });

    it('leaves a keyset move open when the mint reports its outputs pending', async () => {
        mint.rotate();
        mint.refuseNext('/v1/swap', 11004, 'outputs pending');

        await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 0, open: 0 });
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 0, inFlight: 100, outstanding: 0 });

        await expect(keymaster.checkCashu()).resolves.toEqual({ settled: 1, open: 0 });
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 100, inFlight: 0, outstanding: 0 });
    });

    it('keeps released counters the mint never signed when repairing stale ones, and drops those it did', async () => {
        mint.refuseNext('/v1/swap', 11002, 'transaction unbalanced');
        await expect(keymaster.sendCashu(30)).rejects.toThrow('transaction unbalanced');
        expect(await counters()).toEqual({ next: 8, free: [[3, 7]] });
        const backup = await copyOfWallet();

        // Signs 3, 4 and 5, which the backup still holds as released.
        await keymaster.sendCashu(3);

        // The backup's send takes counter 3, the mint refuses it as signed, and the
        // repair keeps only 6 and 7 of what was released, taking 6 for the retry.
        await expect(backup.sendCashu(32)).resolves.toMatchObject({ amount: 32 });
        expect(await counters(backup)).toEqual({ next: 8, free: [[7, 7]] });
        expect((await backup.getCashuBalance()).outstanding).toBe(32);
    });

    it('leaves a reclaim open when the mint reports its outputs pending', async () => {
        const { operationId } = await keymaster.sendCashu(30);
        mint.refuseNext('/v1/swap', 11004, 'outputs pending');

        await expect(keymaster.reclaimCashu(operationId)).rejects.toThrow(/has the reclaim pending/);
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 70, inFlight: 30, outstanding: 0 });

        await keymaster.checkCashu();
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 100, inFlight: 0, outstanding: 0 });
    });
});

describe('receiving', () => {
    beforeEach(async () => {
        await setup();
        await keymaster.addCashu();
        await keymaster.createId('Bob');
        await keymaster.addCashu('Bob');
        await keymaster.setCurrentId('Alice');
    });

    it('refuses a token made of proofs the identity already holds', async () => {
        await fund(10);
        const token = getEncodedToken({ mint: PUBLIC_URL, unit: 'sat', proofs: (await entry()).proofs });
        mint.requests = [];

        await expect(keymaster.receiveCashu(token)).rejects.toThrow(/already in the wallet/);

        expect(mint.requests).not.toContain('POST /v1/swap');
        expect(await keymaster.getCashuBalance()).toEqual({ spendable: 10, inFlight: 0, outstanding: 0 });
    });

    it('leaves a receive open when the mint reports its outputs pending', async () => {
        await fund(100);
        const { token } = await keymaster.sendCashu(30);
        mint.refuseNext('/v1/swap', 11004, 'outputs pending');

        await expect(keymaster.receiveCashu(token, 'Bob')).rejects.toThrow(/has the token pending/);
        expect(await keymaster.getCashuBalance(undefined, 'Bob')).toEqual({ spendable: 0, inFlight: 30, outstanding: 0 });

        await keymaster.checkCashu(undefined, 'Bob');
        expect(await keymaster.getCashuBalance(undefined, 'Bob')).toEqual({ spendable: 30, inFlight: 0, outstanding: 0 });
    });

    it('refuses a token needing SIG_ALL before asking the mint to spend it', async () => {
        mint.requests = [];

        await expect(keymaster.receiveCashu(unsignedToken(lockedSecret([['sigflag', 'SIG_ALL']])), 'Bob'))
            .rejects.toThrow(CashuMintUnsupportedError);

        expect(mint.requests).not.toContain('POST /v1/swap');
    });

    // NUT-11: once the locktime has passed, a lock with no refund keys binds nobody.
    it('redeems a lock past its locktime that has no refund keys, without a signature', async () => {
        const stranger = getPubKeyFromPrivKey(createRandomSecretKey());
        const token = await mintLocked(8, { pubkey: Buffer.from(stranger).toString('hex'), locktime: 1000 });

        await expect(keymaster.receiveCashu(token, 'Bob')).resolves.toEqual({ amount: 8, mint: PUBLIC_URL });

        expect(await keymaster.getCashuBalance(undefined, 'Bob')).toMatchObject({ spendable: 8 });
    });

    it('gives up the rest of a partly spent token worth less than the fee to redeem it', async () => {
        await mint.stop();
        await setup({ inputFeePpk: 1000 });
        await keymaster.addCashu();
        await keymaster.createId('Bob');
        await keymaster.addCashu('Bob');
        await fund(3, 'Alice');
        const proofs = (await entry()).proofs;
        expect(proofs.map((proof: { amount: number }) => proof.amount)).toEqual([1, 2]);
        mint.spent.add(proofY(proofs[1].secret));
        const token = getEncodedToken({ mint: PUBLIC_URL, unit: 'sat', proofs });
        mint.requests = [];

        await expect(keymaster.receiveCashu(token, 'Bob')).rejects.toThrow(CashuTokenSpentError);

        expect(mint.requests.filter(request => request === 'POST /v1/swap')).toHaveLength(1);
        expect(await keymaster.getCashuBalance(undefined, 'Bob')).toEqual({ spendable: 0, inFlight: 0, outstanding: 0 });
        expect((await entry(keymaster, 'Bob')).operations).toBeUndefined();
    });

    it('refuses a token worth no more than its fee', async () => {
        await mint.stop();
        await setup({ inputFeePpk: 1000 });
        await keymaster.addCashu();
        mint.requests = [];

        await expect(keymaster.receiveCashu(unsignedToken('a'.repeat(64)))).rejects.toThrow(/does not cover its fee/);

        expect(mint.requests).not.toContain('POST /v1/swap');
    });
});

describe('over DIDComm', () => {
    let aliceDid: string;
    let bobDid: string;

    beforeEach(async () => {
        await setup();
        bobDid = await keymaster.createId('Bob');
        aliceDid = (await keymaster.fetchIdInfo('Alice')).did;
        for (const name of ['Alice', 'Bob']) {
            await keymaster.publishDidComm(`${node}/didcomm`, name);
        }
        await keymaster.addCashu('Alice');
        await keymaster.addCashu('Bob');
        await fund(100, 'Alice');
        await keymaster.setCurrentId('Alice');
    });

    const sendTo = (amount = 30, options = {}) => keymaster.sendCashuTo('Bob', amount, { name: 'Alice', ...options });
    const message = (body: Record<string, unknown>, options = {}) =>
        keymaster.sendDidComm({ type: CASHU_TOKEN_TYPE, body }, 'Bob', { name: 'Alice', ...options });

    it('sends from the current identity when given no options', async () => {
        await expect(keymaster.sendCashuTo('Bob', 5)).resolves.toMatchObject({ amount: 5, recipient: bobDid, delivered: true });

        expect(await keymaster.getCashuBalance(undefined, 'Alice')).toMatchObject({ outstanding: 5 });
    });

    it('refuses a memo that is not text, and an empty recipient, before sending anything', async () => {
        mint.requests = [];

        await expect(sendTo(5, { memo: 42 })).rejects.toThrow('Invalid parameter: memo');
        await expect(keymaster.sendCashuTo('', 5, { name: 'Alice' })).rejects.toThrow('Invalid parameter: recipient');

        expect(mint.requests).toEqual([]);
        expect(mint.mailbox).toEqual([]);
    });

    it('delivers nothing when the proofs it chose were already spent', async () => {
        const held = (await entry()).proofs.find((proof: { amount: number }) => proof.amount === 32);
        mint.spent.add(proofY(held.secret));

        await expect(sendTo(30)).rejects.toThrow(CashuTokenSpentError);

        expect(mint.mailbox).toEqual([]);
        expect(await keymaster.getCashuBalance(undefined, 'Alice')).toEqual({ spendable: 68, inFlight: 0, outstanding: 0 });
    });

    it('delivers a locked send left pending once a check finishes it', async () => {
        mint.refuseNext('/v1/swap', 11004, 'outputs pending');

        await expect(sendTo(30)).rejects.toThrow(/has the send pending/);
        expect(mint.mailbox).toEqual([]);

        await keymaster.checkCashu(undefined, 'Alice');

        expect(mint.mailbox).toHaveLength(1);
        expect(await keymaster.listCashuSends(undefined, 'Alice')).toEqual([
            expect.objectContaining({ amount: 30, recipient: bobDid, delivered: true }),
        ]);
    });

    it('forgets messages it processed more than thirty days ago when it processes another', async () => {
        const recent = new Date().toISOString();
        await (keymaster as any).mutateWallet((stored: any) => {
            stored.ids.Bob.cashuInbox = { 'old|1': '2000-01-01T00:00:00.000Z', 'recent|2': recent };
        });
        await sendTo(30);

        await expect(keymaster.receiveCashuMessages('Bob')).resolves.toMatchObject({ redeemed: [{ amount: 30 }] });

        const inbox = (await keymaster.loadWallet()).ids.Bob.cashuInbox;
        expect(Object.keys(inbox)).toHaveLength(2);
        expect(inbox).not.toHaveProperty('old|1');
        expect(inbox['recent|2']).toBe(recent);
    });

    it('does not list a token it redeemed but could not acknowledge', async () => {
        await sendTo(30);
        jest.spyOn(keymaster, 'ackDidComm').mockRejectedValue(new Error('relay down'));

        await expect(keymaster.receiveCashuMessages('Bob')).resolves.toMatchObject({ redeemed: [{ amount: 30 }], failed: [] });

        expect(mint.mailbox).toHaveLength(1);
        expect(await keymaster.listCashuMessages('Bob')).toEqual([]);
    });

    it('says a message seen before is still pending, and acknowledges it once settled', async () => {
        await sendTo(30);
        mint.loseResponse('/v1/swap');
        await expect(keymaster.receiveCashuMessages('Bob')).resolves.toMatchObject({ redeemed: [] });
        mint.refuseNext('/v1/swap', 11004, 'outputs pending');

        const { redeemed, failed } = await keymaster.receiveCashuMessages('Bob');

        expect(redeemed).toEqual([]);
        expect(failed).toEqual([
            expect.objectContaining({ sender: aliceDid, mint: PUBLIC_URL, reason: 'still pending at the mint', acknowledged: false }),
        ]);
        expect(mint.mailbox).toHaveLength(1);

        await expect(keymaster.receiveCashuMessages('Bob')).resolves.toEqual({ redeemed: [], failed: [] });
        expect(mint.mailbox).toEqual([]);
        expect(await keymaster.getCashuBalance(undefined, 'Bob')).toMatchObject({ spendable: 30 });
    });

    it('fails a message whose token is not text, and lists it as not a valid token', async () => {
        await message({ token: 42 });

        expect(await keymaster.listCashuMessages('Bob')).toEqual([
            expect.objectContaining({ sender: aliceDid, redeemable: false, reason: 'not a valid token' }),
        ]);
        const { failed } = await keymaster.receiveCashuMessages('Bob');
        expect(failed).toEqual([{ id: expect.any(String), sender: aliceDid, reason: 'Invalid parameter: token', acknowledged: false }]);
    });

    it('takes an anonymous token message, naming no sender', async () => {
        const { token } = await keymaster.sendCashu(8, undefined, 'Alice');
        await keymaster.sendDidComm(cashuToken(token, { memo: 'from a friend' }), 'Bob', { name: 'Alice', anoncrypt: true });

        const [listed] = await keymaster.listCashuMessages('Bob');
        expect(listed).toMatchObject({ amount: 8, memo: 'from a friend', redeemable: true });
        expect(listed).not.toHaveProperty('sender');

        const { redeemed } = await keymaster.receiveCashuMessages('Bob');
        expect(redeemed).toEqual([{ id: expect.any(String), amount: 8, mint: PUBLIC_URL, memo: 'from a friend' }]);
    });

    it('calls an unlocked token redeemable and one needing SIG_ALL not', async () => {
        const { token } = await keymaster.sendCashu(8, undefined, 'Alice');
        await message({ token });
        await message({ token: unsignedToken(lockedSecret([['sigflag', 'SIG_ALL']])) });

        const listed = await keymaster.listCashuMessages('Bob');

        expect(listed).toEqual(expect.arrayContaining([
            expect.objectContaining({ amount: 8, redeemable: true }),
            expect.objectContaining({ amount: 1, redeemable: false, reason: 'needs SIG_ALL or several signatures' }),
        ]));
        expect(listed).toHaveLength(2);
    });
});
