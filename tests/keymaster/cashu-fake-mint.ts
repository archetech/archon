import http from 'http';
import type { AddressInfo } from 'net';
import {
    createBlindSignature,
    createNewMintKeys,
    createDLEQProof,
    hashToCurve,
    pointFromHex,
    serializeMintKeys,
    verifyMintQuoteSignature,
    verifyUnblindedSignature,
} from '@cashu/cashu-ts';
import { signedInvoice } from '../cli/helpers.ts';

// A mint that really signs: blind signatures from cashu-ts, spent and signed
// sets, and quotes it settles when told to. Journal recovery can only be tested
// against something that enforces double-spend rules, so a canned HTTP mock
// would not do. It is served at /cashu, as Drawbridge serves the node's mint.

export interface FakeMintOptions {
    inputFeePpk?: number;
    nuts?: number[];
    nut20?: boolean;
}

interface MintQuote {
    amount: number;
    state: 'UNPAID' | 'PAID' | 'ISSUED';
    pubkey?: string;
    expiry: number;
}

interface MeltQuote {
    amount: number;
    fee_reserve: number;
    state: 'UNPAID' | 'PENDING' | 'PAID';
    request: string;
    change?: unknown[];
    payment_preimage?: string;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

class MintRefusal extends Error {
    constructor(readonly code: number, detail: string) {
        super(detail);
    }
}

export class FakeMint {
    server!: http.Server;
    keyset;
    // Every keyset the mint has had, by id. `keyset` is the active one.
    keysets = new Map<string, ReturnType<typeof createNewMintKeys>>();
    private generation = 7;
    inputFeePpk: number;
    readonly nuts: number[];
    readonly nut20: boolean;
    spent = new Set<string>();
    signed = new Map<string, { id: string; amount: number; C_: string; dleq: { e: string; s: string } }>();
    mintQuotes = new Map<string, MintQuote>();
    meltQuotes = new Map<string, MeltQuote>();
    requests: string[] = [];
    // The invoice a mint quote carries; a test can make it dishonest.
    invoiceFor: (amount: number) => string = signedInvoice;
    // The fee the Lightning payment of a melt actually costs.
    meltRoutingFee = 1;
    meltOutcome: 'PAID' | 'PENDING' | 'UNPAID' = 'PAID';
    // Mints differ here: NUT-00 lists 11003, cdk-mintd sends 20006 on a mint.
    alreadySignedCode = 11003;
    // When set, /v1/checkstate answers for only this many proofs.
    statesLimit?: number;
    // Runs while a request is on the wire, before the mint answers it.
    onRequest?: (path: string) => Promise<void>;
    // Requests whose work is done but whose response never arrives.
    private lose = new Set<string>();
    private refuseWith = new Map<string, MintRefusal>();
    private next = 0;

    constructor(options: FakeMintOptions = {}) {
        this.inputFeePpk = options.inputFeePpk ?? 0;
        this.nuts = options.nuts ?? [4, 5, 7, 8, 9, 12];
        this.nut20 = options.nut20 ?? true;
        this.keyset = this.newKeyset();
    }

    private newKeyset() {
        const keyset = createNewMintKeys(16, new Uint8Array(32).fill(this.generation++), { input_fee_ppk: this.inputFeePpk, unit: 'sat' });
        this.keysets.set(keyset.keysetId, keyset);
        return keyset;
    }

    // Retires the active keyset. Its proofs stay redeemable; nothing new is signed.
    rotate(): void {
        this.keyset = this.newKeyset();
    }

    get keysetId(): string {
        return this.keyset.keysetId;
    }

    async start(): Promise<string> {
        this.server = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => this.handle(req, res, body));
        });
        this.server.listen(0, '127.0.0.1');
        await new Promise(resolve => this.server.once('listening', resolve));
        return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }

    async stop(): Promise<void> {
        this.server.closeAllConnections();
        await new Promise(resolve => this.server.close(resolve));
    }

    payMintQuote(quote: string): void {
        this.mintQuotes.get(quote)!.state = 'PAID';
    }

    // The next request to this path does its work, then the connection drops.
    loseResponse(path: string): void {
        this.lose.add(path);
    }

    refuseNext(path: string, code: number, detail: string): void {
        this.refuseWith.set(path, new MintRefusal(code, detail));
    }

    private sign(outputs: { amount: number; id: string; B_: string }[]) {
        return outputs.map((output) => {
            if (output.id !== this.keysetId) {
                throw new MintRefusal(12002, 'keyset inactive');
            }
            const privateKey = this.keyset.privKeys[output.amount];
            const B_ = pointFromHex(output.B_);
            const { C_ } = createBlindSignature(B_, privateKey, this.keysetId);
            const dleq = createDLEQProof(B_, privateKey);
            const signature = {
                id: this.keysetId,
                amount: output.amount,
                C_: C_.toHex(true),
                dleq: { e: toHex(dleq.e), s: toHex(dleq.s) },
            };
            this.signed.set(output.B_, signature);
            return signature;
        });
    }

    private checkOutputs(outputs: { B_: string }[]): void {
        if (outputs.some(output => this.signed.has(output.B_))) {
            throw new MintRefusal(this.alreadySignedCode, 'outputs already signed');
        }
    }

    private spend(inputs: { id: string; amount: number; secret: string; C: string }[]): void {
        const encoder = new TextEncoder();
        const seen = new Set<string>();
        for (const input of inputs) {
            if (seen.has(input.secret)) {
                throw new MintRefusal(11007, 'duplicate inputs');
            }
            seen.add(input.secret);
            const valid = verifyUnblindedSignature({
                C: pointFromHex(input.C),
                secret: encoder.encode(input.secret),
                id: input.id,
            }, this.keysets.get(input.id)!.privKeys[input.amount]);
            if (!valid) {
                throw new MintRefusal(10003, 'invalid proof');
            }
            if (this.spent.has(this.Y(input.secret))) {
                throw new MintRefusal(11001, 'token already spent');
            }
        }
        inputs.forEach(input => this.spent.add(this.Y(input.secret)));
    }

    private Y(secret: string): string {
        return hashToCurve(new TextEncoder().encode(secret)).toHex(true);
    }

    private fee(inputs: unknown[]): number {
        return Math.ceil(inputs.length * this.inputFeePpk / 1000);
    }

    private route(method: string, path: string, body: any): unknown {
        if (method === 'GET' && path === '/v1/info') {
            const nuts: Record<string, unknown> = {};
            this.nuts.forEach((nut) => { nuts[nut] = { supported: true }; });
            if (this.nut20) {
                nuts[20] = { supported: true };
            }
            return { name: 'Fake mint', version: 'fake/1', nuts };
        }
        if (method === 'GET' && path === '/v1/keysets') {
            return {
                keysets: [...this.keysets.keys()].map(id => ({
                    id,
                    unit: 'sat',
                    active: id === this.keysetId,
                    input_fee_ppk: this.inputFeePpk,
                })),
            };
        }
        if (method === 'GET' && path.startsWith('/v1/keys/')) {
            const id = path.split('/').pop()!;
            return { keysets: [{ id, unit: 'sat', keys: serializeMintKeys(this.keysets.get(id)!.pubKeys) }] };
        }
        if (method === 'POST' && path === '/v1/mint/quote/bolt11') {
            const quote = `mq${++this.next}`;
            this.mintQuotes.set(quote, {
                amount: body.amount,
                state: 'UNPAID',
                pubkey: body.pubkey,
                expiry: Math.floor(Date.now() / 1000) + 600,
            });
            return { quote, request: this.invoiceFor(body.amount), unit: 'sat', state: 'UNPAID', amount: body.amount, expiry: this.mintQuotes.get(quote)!.expiry };
        }
        if (method === 'GET' && path.startsWith('/v1/mint/quote/bolt11/')) {
            const quote = this.mintQuotes.get(path.split('/').pop()!)!;
            return { quote: path.split('/').pop(), request: 'lnbc', unit: 'sat', ...quote };
        }
        if (method === 'POST' && path === '/v1/mint/bolt11') {
            const quote = this.mintQuotes.get(body.quote)!;
            if (quote.state === 'ISSUED') {
                throw new MintRefusal(20002, 'quote already issued');
            }
            if (quote.state !== 'PAID') {
                throw new MintRefusal(20001, 'quote not paid');
            }
            if (quote.pubkey && !verifyMintQuoteSignature(quote.pubkey, body.quote, body.outputs, body.signature)) {
                throw new MintRefusal(20008, 'bad quote signature');
            }
            this.checkOutputs(body.outputs);
            quote.state = 'ISSUED';
            return { signatures: this.sign(body.outputs) };
        }
        if (method === 'POST' && path === '/v1/swap') {
            this.checkOutputs(body.outputs);
            const total = body.inputs.reduce((sum: number, input: { amount: number }) => sum + input.amount, 0);
            const out = body.outputs.reduce((sum: number, output: { amount: number }) => sum + output.amount, 0);
            if (total - this.fee(body.inputs) !== out) {
                throw new MintRefusal(11002, 'transaction unbalanced');
            }
            this.spend(body.inputs);
            return { signatures: this.sign(body.outputs) };
        }
        if (method === 'POST' && path === '/v1/melt/quote/bolt11') {
            const quote = `xq${++this.next}`;
            const amount = Number(/amount=(\d+)/.exec(body.request)?.[1] ?? 100);
            this.meltQuotes.set(quote, { amount, fee_reserve: 10, state: 'UNPAID', request: body.request });
            return { quote, amount, unit: 'sat', fee_reserve: 10, state: 'UNPAID', expiry: Math.floor(Date.now() / 1000) + 600 };
        }
        if (method === 'GET' && path.startsWith('/v1/melt/quote/bolt11/')) {
            const id = path.split('/').pop()!;
            return { quote: id, unit: 'sat', expiry: 0, ...this.meltQuotes.get(id)! };
        }
        if (method === 'POST' && path === '/v1/melt/bolt11') {
            const quote = this.meltQuotes.get(body.quote)!;
            const total = body.inputs.reduce((sum: number, input: { amount: number }) => sum + input.amount, 0);
            this.checkOutputs(body.outputs);
            this.spend(body.inputs);
            if (this.meltOutcome !== 'PAID') {
                quote.state = this.meltOutcome;
                if (this.meltOutcome === 'UNPAID') {
                    body.inputs.forEach((input: { secret: string }) => this.spent.delete(this.Y(input.secret)));
                }
                return { quote: body.quote, unit: 'sat', expiry: 0, ...quote };
            }
            quote.state = 'PAID';
            quote.payment_preimage = 'ab'.repeat(32);
            let overpaid = total - this.fee(body.inputs) - quote.amount - this.meltRoutingFee;
            const change = [];
            for (let bit = 1, i = 0; bit <= overpaid && i < body.outputs.length; bit *= 2) {
                if (Math.floor(overpaid / bit) % 2 === 1) {
                    change.push({ ...body.outputs[i++], amount: bit });
                }
            }
            overpaid = 0;
            quote.change = this.sign(change);
            return { quote: body.quote, unit: 'sat', expiry: 0, ...quote };
        }
        if (method === 'POST' && path === '/v1/checkstate') {
            return {
                states: body.Ys.slice(0, this.statesLimit).map((Y: string) => ({ Y, state: this.spent.has(Y) ? 'SPENT' : 'UNSPENT', witness: null })),
            };
        }
        if (method === 'POST' && path === '/v1/restore') {
            const found = body.outputs.filter((output: { B_: string }) => this.signed.has(output.B_));
            return {
                outputs: found,
                signatures: found.map((output: { B_: string }) => this.signed.get(output.B_)),
            };
        }
        return undefined;
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string): Promise<void> {
        const path = req.url!.replace(/^\/cashu/, '');
        this.requests.push(`${req.method} ${path}`);
        await this.onRequest?.(path);
        res.setHeader('Content-Type', 'application/json');
        try {
            const refusal = this.refuseWith.get(path);
            if (refusal) {
                this.refuseWith.delete(path);
                throw refusal;
            }
            const result = this.route(req.method!, path, raw ? JSON.parse(raw) : undefined);
            if (this.lose.delete(path)) {
                req.socket.destroy();
                return;
            }
            if (result === undefined) {
                res.statusCode = 404;
                res.end(JSON.stringify({ detail: 'not found' }));
                return;
            }
            res.end(JSON.stringify(result));
        }
        catch (error) {
            res.statusCode = 400;
            const code = error instanceof MintRefusal ? error.code : 0;
            res.end(JSON.stringify({ code, detail: (error as Error).message }));
        }
    }
}
