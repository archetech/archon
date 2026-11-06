import {
    Amount,
    OutputData,
    blindMessage,
    deriveSecretAndBlindingFactor,
    getDecodedToken,
    getEncodedToken,
    getPubKeyFromPrivKey,
    getTokenMetadata,
    createRandomSecretKey,
    hasValidDleq,
    hashToCurve,
    signMintQuote,
    signP2PKProofs,
} from '@cashu/cashu-ts';
import type { SerializedBlindedSignature, Proof as CtsProof } from '@cashu/cashu-ts';
import { decode as decodeBolt11 } from 'light-bolt11-decoder';
import { fetchPublicHttps } from '@didcid/common/net';
import { cashuToken, isCashuTokenMessage } from './didcomm-protocols.js';
import {
    CashuInsufficientFundsError,
    CashuMintNotAddedError,
    CashuMintUnsupportedError,
    CashuNotConfiguredError,
    CashuQuoteUnpaidError,
    CashuStateError,
    CashuTokenLockedError,
    CashuTokenSpentError,
    CashuUnavailableError,
    InvalidParameterError,
    KeymasterError,
} from '@didcid/common/errors';
import type {
    CashuAcceptResult,
    CashuBalance,
    CashuCheckResult,
    CashuClaimResult,
    CashuCounters,
    CashuMeltResult,
    CashuMessage,
    CashuMintEntry,
    CashuMintInfo,
    CashuMintQuote,
    CashuOperation,
    CashuProof,
    CashuQuoteRecord,
    CashuReceiveResult,
    CashuReclaimResult,
    CashuRestoreResult,
    CashuSendRecord,
    CashuSendResult,
    CashuSendToOptions,
    CashuSendToResult,
    DidCommReceivedMessage,
    IDInfo,
    WalletFile,
} from '@didcid/clients/keymaster-types';

// Per-identity Cashu wallets (docs/plans/cashu-1058.md). The proofs are bearer
// value, so every operation that talks to a mint is journaled first: its
// inputs and everything needed to rebuild its outputs are saved before the
// request goes out, and the record is retired only after the result is saved.
// An interrupted operation is finished by settlement rather than lost.

const UNIT = 'sat';
const REQUEST_TIMEOUT_MS = 30000;
const RESTORE_BATCH = 100;
const RESTORE_EMPTY_BATCHES = 3;

// A locked send's default locktime, and its limit: what the DIDComm mailbox keeps
// an unacknowledged message, so the value can be reclaimed before it could expire
// unread.
const LOCKTIME_DEFAULT_SECONDS = 3 * 24 * 60 * 60;
const LOCKTIME_MAX_SECONDS = 7 * 24 * 60 * 60;

// How long a processed token message is remembered, well past the mailbox's seven
// days, since a sender resends only while it holds the message undelivered.
const INBOX_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;

// Mints disagree on the code for outputs they have already signed: NUT-00 lists
// 11003, while cdk-mintd answers a mint request with 20006. So that case is
// detected by asking the mint about the outputs (NUT-09), not from the code.
const OUTPUTS_PENDING = 11004;

// Without NUT-07 the journal cannot be settled; without NUT-08 the unused part
// of a melt's fee reserve is never returned; without NUT-09 ecash could not be
// recovered from the mnemonic.
const REQUIRED_NUTS = ['7', '8', '9'];

type MintFetch = (url: string, init?: RequestInit) => Promise<Response>;

type OperationOutcome = 'done' | 'open' | 'spent' | 'rejected';

// What became of a reclaim's proofs when some were already spent.
interface SwapReport {
    redeemed: number;
    recovered: number;
    pending: number;
    // What the mint refused of a received token's remainder.
    refused: number;
}

interface MintKeyset {
    id: string;
    unit: string;
    active: boolean;
    input_fee_ppk?: number;
}

interface Blinded {
    amount: number;
    id: string;
    B_: string;
}

export function normalizeMintUrl(url: string): string {
    let parsed: URL;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new InvalidParameterError('mint url');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new InvalidParameterError('mint url');
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
}

// A mint's own refusal, with its NUT error code.
export class CashuMintError extends KeymasterError {
    code?: number;

    constructor(detail: string, code?: number) {
        super(`mint refused: ${detail}`);
        this.code = code;
    }
}

export class CashuMintClient {
    private keyCache = new Map<string, Record<string, string>>();

    constructor(readonly base: string, private readonly request: MintFetch) { }

    private async call(path: string, body?: unknown, timeout: number | null = REQUEST_TIMEOUT_MS): Promise<any> {
        const controller = new AbortController();
        const timer = timeout === null ? undefined : setTimeout(() => controller.abort(), timeout);
        let response: Response;
        try {
            response = await this.request(`${this.base}${path}`, {
                method: body === undefined ? 'GET' : 'POST',
                headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });
        }
        catch (error: any) {
            throw new CashuUnavailableError(`${this.base}: ${error?.cause?.message ?? error?.message ?? error}`);
        }
        finally {
            clearTimeout(timer);
        }

        let json: any;
        try {
            json = await response.json();
        }
        catch {
            json = undefined;
        }
        if (response.ok) {
            if (json === undefined) {
                throw new CashuUnavailableError(`${this.base}: the answer to ${path} is not JSON`);
            }
            return json;
        }
        if (typeof json?.code === 'number' || typeof json?.detail === 'string') {
            throw new CashuMintError(json.detail ?? `error ${json.code}`, json.code);
        }
        throw new CashuUnavailableError(`${this.base}: HTTP ${response.status}`);
    }

    info() { return this.call('/v1/info'); }

    async keysets(): Promise<MintKeyset[]> {
        const { keysets } = await this.call('/v1/keysets');
        return keysets.filter((keyset: MintKeyset) => keyset.unit === UNIT);
    }

    // A keyset's keys never change, so they are fetched once.
    async keys(id: string): Promise<{ id: string; keys: Record<string, string> }> {
        let keys = this.keyCache.get(id);
        if (!keys) {
            const response = await this.call(`/v1/keys/${encodeURIComponent(id)}`);
            keys = response.keysets[0].keys as Record<string, string>;
            this.keyCache.set(id, keys);
        }
        return { id, keys };
    }

    createMintQuote(amount: number, pubkey?: string) {
        return this.call('/v1/mint/quote/bolt11', { amount, unit: UNIT, ...(pubkey && { pubkey }) });
    }

    checkMintQuote(quote: string) { return this.call(`/v1/mint/quote/bolt11/${encodeURIComponent(quote)}`); }

    mint(quote: string, outputs: Blinded[], signature?: string) {
        return this.call('/v1/mint/bolt11', { quote, outputs, ...(signature && { signature }) });
    }

    createMeltQuote(request: string) { return this.call('/v1/melt/quote/bolt11', { unit: UNIT, request }); }

    checkMeltQuote(quote: string) { return this.call(`/v1/melt/quote/bolt11/${encodeURIComponent(quote)}`); }

    // NUT-05 advises no client timeout: a melt can take as long as the payment.
    melt(quote: string, inputs: CashuProof[], outputs: Blinded[]) {
        return this.call('/v1/melt/bolt11', { quote, inputs, outputs }, null);
    }

    swap(inputs: CashuProof[], outputs: Blinded[]) { return this.call('/v1/swap', { inputs, outputs }); }

    async states(Ys: string[]): Promise<Map<string, string>> {
        if (Ys.length === 0) {
            return new Map();
        }
        const { states } = await this.call('/v1/checkstate', { Ys });
        return new Map(states.map((state: { Y: string; state: string }) => [state.Y, state.state]));
    }

    // NUT-09: the signatures the mint holds for these outputs, by B_.
    async restore(outputs: Blinded[]): Promise<Map<string, SerializedBlindedSignature>> {
        if (outputs.length === 0) {
            return new Map();
        }
        const response = await this.call('/v1/restore', { outputs });
        const found = new Map<string, SerializedBlindedSignature>();
        response.outputs.forEach((output: Blinded, i: number) => found.set(output.B_, response.signatures[i]));
        return found;
    }
}

export function proofY(secret: string): string {
    return hashToCurve(new TextEncoder().encode(secret)).toHex(true);
}

// Ascending powers of two, the NUT-13-compatible split both ports use.
export function splitAmount(amount: number): number[] {
    const parts: number[] = [];
    for (let bit = 1; bit <= amount; bit *= 2) {
        if (Math.floor(amount / bit) % 2 === 1) {
            parts.push(bit);
        }
    }
    return parts;
}

function sumProofs(proofs: { amount: number }[]): number {
    return proofs.reduce((total, proof) => total + proof.amount, 0);
}

function feeFor(proofs: { id: string }[], keysets: MintKeyset[]): number {
    const ppk = proofs.reduce((total, proof) =>
        total + (keysets.find(keyset => keyset.id === proof.id)?.input_fee_ppk ?? 0), 0);
    return Math.ceil(ppk / 1000);
}

function newId(): string {
    return toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

// The spending conditions of a NUT-11 secret. A secret that is not JSON is an
// ordinary one, with none.
interface P2PKLock {
    keys: string[];
    refund: string[];
    locktime?: number;
    signatures: number;
    refundSignatures: number;
    sigAll: boolean;
}

export function p2pkLock(secret: string): P2PKLock | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(secret);
    }
    catch {
        return undefined;
    }
    if (!Array.isArray(parsed)) {
        return undefined;
    }
    const [kind, data] = parsed as [unknown, { data?: unknown; tags?: unknown } | undefined];
    if (kind !== 'P2PK' || typeof data?.data !== 'string') {
        throw new CashuMintUnsupportedError(`spending condition ${String(kind)}`);
    }
    const malformed = new CashuMintUnsupportedError('a malformed spending condition');
    if (data.tags !== undefined && data.tags !== null && !Array.isArray(data.tags)) {
        throw malformed;
    }
    const tags = new Map<string, string[]>();
    for (const tag of (data.tags ?? []) as unknown[]) {
        if (!Array.isArray(tag) || tag.length === 0 || !tag.every(value => typeof value === 'string')) {
            throw malformed;
        }
        tags.set(tag[0], tag.slice(1));
    }
    const integer = (name: string, fallback?: number): number | undefined => {
        const value = tags.get(name)?.[0];
        if (value === undefined) {
            return fallback;
        }
        if (!/^[0-9]+$/.test(value)) {
            throw malformed;
        }
        return Number(value);
    };
    const locktime = integer('locktime');
    return {
        keys: [data.data, ...(tags.get('pubkeys') ?? [])],
        refund: tags.get('refund') ?? [],
        ...(locktime !== undefined && { locktime }),
        signatures: integer('n_sigs', 1)!,
        refundSignatures: integer('n_sigs_refund', 1)!,
        sigAll: tags.get('sigflag')?.[0] === 'SIG_ALL',
    };
}

function plainProof(proof: CtsProof | CashuProof): CashuProof {
    return {
        id: proof.id,
        amount: typeof proof.amount === 'number' ? proof.amount : proof.amount.toNumber(),
        secret: proof.secret,
        C: proof.C,
        ...(proof.dleq && { dleq: proof.dleq as CashuProof['dleq'] }),
    };
}

export function hasCashuState(idInfo: IDInfo): boolean {
    const mints: Record<string, CashuMintEntry> = idInfo.cashu ?? {};
    return Object.values(mints).some(entry => entry.proofs.length > 0 || (entry.operations?.length ?? 0) > 0);
}

export interface CashuHost {
    gatekeeper: { url?: string; getCashuMint?: () => Promise<string | undefined> };
    mutateWallet(mutator: (wallet: WalletFile) => void | Promise<void>): Promise<void>;
    loadWallet(): Promise<WalletFile>;
    fetchIdInfo(name?: string, wallet?: WalletFile): Promise<IDInfo>;
    getSeed(wallet: WalletFile): Promise<Uint8Array>;
    getCapabilities(): Promise<Record<string, unknown> | null>;
    resolveDID(did: string, options?: { confirm?: boolean }): Promise<any>;
    updateDID(did: string, doc: any): Promise<boolean>;
    // The identity's compressed public key, and that of a DID document.
    ownPublicKey(name?: string): Promise<string>;
    documentPublicKey(doc: any): string;
    // The private key, as hex, of whichever of these public keys any derivation of
    // the identity holds: a token may be locked to one since rotated away.
    findPrivateKey(publicKeys: string[], name?: string): Promise<string | undefined>;
    // Refuses if a message could not be delivered, before value is locked for it.
    requireDidCommRoute(recipient: string, name?: string): Promise<void>;
    sendDidComm(message: Record<string, unknown>, to: string, options: { name?: string }): Promise<string[]>;
    receiveDidComm(options: { name?: string; ack: false }): Promise<DidCommReceivedMessage[]>;
    ackDidComm(ids: string[], options: { name?: string }): Promise<number>;
}

interface MintContext {
    name?: string;
    url: string;
    client: CashuMintClient;
}

function invoiceMsat(request: string): bigint | undefined {
    try {
        const section = decodeBolt11(request).sections.find(item => item.name === 'amount');
        return section ? BigInt(section.value as string) : undefined;
    }
    catch {
        return undefined;
    }
}

export class CashuWallet {
    // Operations with a request on the wire in this process. Settlement skips
    // them: the lock is not held across mint requests, so a concurrent operation
    // would otherwise resubmit a request that is still in flight.
    private active = new Set<string>();

    constructor(private readonly host: CashuHost, private readonly publicFetch: MintFetch = fetchPublicHttps) { }

    private nodeUrl(): string | undefined {
        return this.host.gatekeeper.url?.replace(/\/+$/, '');
    }

    private clientFor(url: string, entry?: CashuMintEntry): CashuMintClient {
        const node = this.nodeUrl();
        return entry?.node && entry.node === node
            ? new CashuMintClient(`${node}/cashu`, fetch.bind(globalThis))
            : new CashuMintClient(url, this.publicFetch);
    }

    private mints(idInfo: IDInfo): Record<string, CashuMintEntry> {
        return idInfo.cashu ?? {};
    }

    // The node's mint when the identity has it, else its only mint.
    private async context(mint: string | undefined, name?: string): Promise<MintContext> {
        const idInfo = await this.host.fetchIdInfo(name, await this.host.loadWallet());
        const mints = this.mints(idInfo);
        const urls = Object.keys(mints);
        if (urls.length === 0) {
            throw new CashuNotConfiguredError(`No Cashu mints configured for ${idInfo.did}`);
        }

        let url: string;
        if (mint) {
            url = normalizeMintUrl(mint);
            if (!mints[url]) {
                throw new CashuMintNotAddedError(url);
            }
        }
        else {
            const node = this.nodeUrl();
            const own = urls.find(candidate => mints[candidate].node && mints[candidate].node === node);
            if (!own && urls.length > 1) {
                throw new InvalidParameterError('mint is required: this identity uses several');
            }
            url = own ?? urls[0];
        }
        // By DID, not the name given: with none given it means the current identity,
        // which can change while a request is out, and proofs must not follow it.
        return { name: idInfo.did, url, client: this.clientFor(url, mints[url]) };
    }

    private async boundIdentity(name?: string): Promise<string> {
        return (await this.host.fetchIdInfo(name, await this.host.loadWallet())).did;
    }

    private async entryOf(wallet: WalletFile, ctx: MintContext): Promise<CashuMintEntry> {
        const idInfo = await this.host.fetchIdInfo(ctx.name, wallet);
        const entry = this.mints(idInfo)[ctx.url];
        if (!entry) {
            throw new CashuMintNotAddedError(ctx.url);
        }
        return entry;
    }

    private async readOp(ctx: MintContext, id: string): Promise<CashuOperation | undefined> {
        const entry = await this.entryOf(await this.host.loadWallet(), ctx);
        return entry.operations?.find(op => op.id === id);
    }

    private walletCounters(wallet: WalletFile): CashuCounters['counters'] {
        wallet.cashu ??= { counters: {} } as CashuCounters;
        return (wallet.cashu as CashuCounters).counters;
    }

    // Reserved counters are saved before the outputs they cover are sent, so a
    // crash can never reuse one the mint has signed. Released ranges go first.
    private reserve(wallet: WalletFile, keyset: string, count: number): number[] {
        const counters = this.walletCounters(wallet);
        const state = (counters[keyset] ??= { next: 0, free: [] });
        const reserved: number[] = [];
        while (reserved.length < count) {
            const range = state.free[0];
            if (range) {
                reserved.push(range[0]);
                if (range[0] === range[1]) {
                    state.free.shift();
                }
                else {
                    range[0] += 1;
                }
            }
            else {
                reserved.push(state.next);
                state.next += 1;
            }
        }
        return reserved;
    }

    private release(wallet: WalletFile, keyset: string, released: number[]): void {
        if (released.length === 0) {
            return;
        }
        const state = (this.walletCounters(wallet)[keyset] ??= { next: 0, free: [] });
        const merged: [number, number][] = [];
        const ranges = [...state.free, ...released.map((counter): [number, number] => [counter, counter])]
            .sort((a, b) => a[0] - b[0]);
        for (const [start, end] of ranges) {
            const last = merged[merged.length - 1];
            if (last && start <= last[1] + 1) {
                last[1] = Math.max(last[1], end);
            }
            else {
                merged.push([start, end]);
            }
        }
        state.free = merged;
    }

    private async outputData(op: Pick<CashuOperation, 'keyset' | 'outputs'>): Promise<{ data: OutputData[]; blinded: Blinded[] }> {
        const seed = await this.host.getSeed(await this.host.loadWallet());
        const data = op.outputs.map((output) => {
            // A locked output's secret is random, so the record holds it.
            if (output.secret !== undefined) {
                const secret = new TextEncoder().encode(output.secret);
                const r = BigInt(`0x${output.r}`);
                const { B_ } = blindMessage(secret, r);
                return new OutputData({ amount: Amount.from(output.amount), id: op.keyset, B_: B_.toHex(true) }, r, secret);
            }
            if (output.counter === undefined) {
                throw new KeymasterError('Cashu output has no counter');
            }
            return OutputData.createSingleDeterministicData(output.amount, seed, output.counter, op.keyset);
        });
        const blinded = data.map((item, i) => ({
            amount: op.outputs[i].amount,
            id: op.keyset,
            B_: item.blindedMessage.B_,
        }));
        return { data, blinded };
    }

    private async unblind(
        ctx: MintContext,
        signature: SerializedBlindedSignature,
        data: OutputData,
    ): Promise<CashuProof> {
        const keyset = await ctx.client.keys(signature.id);
        return plainProof(data.toProof(signature, keyset));
    }

    // No path adds a proof already held anywhere in the wallet, so restores,
    // retries and recoveries cannot count value twice.
    private knownYs(wallet: WalletFile): Set<string> {
        const known = new Set<string>();
        for (const idInfo of Object.values(wallet.ids)) {
            for (const entry of Object.values(this.mints(idInfo))) {
                const held = [...entry.proofs];
                for (const op of entry.operations ?? []) {
                    held.push(...op.inputs, ...(op.sent ?? []));
                }
                held.forEach(proof => known.add(proofY(proof.secret)));
            }
        }
        return known;
    }

    private credit(wallet: WalletFile, entry: CashuMintEntry, proofs: CashuProof[]): void {
        const known = this.knownYs(wallet);
        for (const proof of proofs) {
            const Y = proofY(proof.secret);
            if (!known.has(Y)) {
                entry.proofs.push(proof);
                known.add(Y);
            }
        }
    }

    private retire(entry: CashuMintEntry, id: string): void {
        entry.operations = entry.operations?.filter(op => op.id !== id);
        if (entry.operations?.length === 0) {
            delete entry.operations;
        }
    }

    private async activeKeyset(ctx: MintContext): Promise<{ keyset: MintKeyset; keysets: MintKeyset[] }> {
        const keysets = await ctx.client.keysets();
        const candidates = keysets.filter(keyset => keyset.active);
        if (candidates.length === 0) {
            throw new CashuUnavailableError(`${ctx.url} has no active ${UNIT} keyset`);
        }
        const keyset = candidates.reduce((best, candidate) =>
            (candidate.input_fee_ppk ?? 0) < (best.input_fee_ppk ?? 0) ? candidate : best);
        return { keyset, keysets };
    }

    // As little as covers the target and its own input fee, because a request that
    // goes pending locks what it selected for as long as the mint keeps it pending:
    // at each step the smallest proof that finishes the job, else the largest.
    // It runs inside the wallet's write, so totals are kept rather than recomputed.
    private select(proofs: CashuProof[], target: number, keysets: MintKeyset[]): CashuProof[] {
        const rates = new Map(keysets.map(keyset => [keyset.id, keyset.input_fee_ppk ?? 0]));
        const rate = (proof: CashuProof) => rates.get(proof.id) ?? 0;
        const pool = [...proofs].sort((a, b) => a.amount - b.amount);
        const selected: CashuProof[] = [];
        let value = 0;
        let ppk = 0;
        const finishes = (proof: CashuProof) =>
            value + proof.amount - Math.ceil((ppk + rate(proof)) / 1000) >= target;
        while (pool.length > 0) {
            // Fees only grow, so if the largest cannot finish even before its own fee,
            // none can, and the scan is skipped.
            const finishing = value + pool[pool.length - 1].amount - Math.ceil(ppk / 1000) >= target
                ? pool.find(finishes)
                : undefined;
            if (finishing) {
                return [...selected, finishing];
            }
            const largest = pool.pop()!;
            selected.push(largest);
            value += largest.amount;
            ppk += rate(largest);
        }
        throw new CashuInsufficientFundsError(
            `need ${target} ${UNIT} plus fees, have ${sumProofs(proofs)}`);
    }

    private removeFromEntry(entry: CashuMintEntry, proofs: CashuProof[]): void {
        const taken = new Set(proofs.map(proof => proof.secret));
        entry.proofs = entry.proofs.filter(proof => !taken.has(proof.secret));
    }

    // Saves a new record and runs it, marked active throughout. The record is
    // visible to settlement as soon as the write starts, before it is durable, so
    // the mark must come first.
    private journaled<T>(
        id: string,
        write: (wallet: WalletFile) => void | Promise<void>,
        work: () => Promise<T>,
    ): Promise<T> {
        return this.withActive(id, async () => {
            await this.host.mutateWallet(write);
            return work();
        });
    }

    private async withActive<T>(id: string, work: () => Promise<T>): Promise<T> {
        this.active.add(id);
        try {
            return await work();
        }
        finally {
            this.active.delete(id);
        }
    }

    // ---- settlement ----

    // After a mint refused a request whose outputs it had already signed, although
    // this request was never accepted: the counters are stale, as after recovering
    // a wallet. In one write, so the request's old outputs are no longer reserved
    // when what the scan found is credited.
    private async repairAndRenumber(ctx: MintContext, id: string, keysetId: string): Promise<void> {
        const { proofs, highest, signed } = await this.scanKeyset(ctx, keysetId);
        const spendable = await this.unspent(ctx, proofs);
        await this.host.mutateWallet(async (wallet) => {
            const counters = this.walletCounters(wallet);
            const state = (counters[keysetId] ??= { next: 0, free: [] });
            state.next = Math.max(state.next, highest + 1);
            state.free = state.free.flatMap(([start, end]): [number, number][] => {
                const open: [number, number][] = [];
                for (let counter = start; counter <= end; counter++) {
                    if (!signed.has(counter) && counter < state.next) {
                        open.push([counter, counter]);
                    }
                }
                return open;
            });
            const entry = await this.entryOf(wallet, ctx);
            const stored = entry.operations!.find(item => item.id === id)!;
            // A locked output has no counter, and its random secret cannot be stale.
            const derived = stored.outputs.filter(output => output.counter !== undefined);
            const fresh = this.reserve(wallet, stored.keyset, derived.length);
            derived.forEach((output, i) => { output.counter = fresh[i]; });
            this.credit(wallet, entry, await this.withoutReserved(wallet, spendable));
        });
    }

    // A scan finds every signed output of the seed, including those an unfinished
    // operation of any identity is waiting to collect. Those are that operation's.
    private async withoutReserved(wallet: WalletFile, proofs: CashuProof[]): Promise<CashuProof[]> {
        const seed = await this.host.getSeed(wallet);
        const reserved = new Set<string>();
        for (const idInfo of Object.values(wallet.ids)) {
            for (const entry of Object.values(this.mints(idInfo))) {
                for (const op of entry.operations ?? []) {
                    for (const { counter } of op.outputs) {
                        if (counter !== undefined) {
                            reserved.add(toHex(deriveSecretAndBlindingFactor(seed, op.keyset, counter).secret));
                        }
                    }
                }
            }
        }
        return proofs.filter(proof => !reserved.has(proof.secret));
    }

    // Each input's state, in order. A mint that leaves one out says nothing about
    // it, which must not read as unspent.
    private async inputStates(ctx: MintContext, inputs: CashuProof[]): Promise<string[]> {
        const states = await ctx.client.states(inputs.map(proof => proofY(proof.secret)));
        return inputs.map((proof) => {
            const state = states.get(proofY(proof.secret));
            if (!state) {
                throw new CashuUnavailableError(`${ctx.url} did not report the state of every proof`);
            }
            return state;
        });
    }

    private async unspent(ctx: MintContext, proofs: CashuProof[]): Promise<CashuProof[]> {
        const states = await ctx.client.states(proofs.map(proof => proofY(proof.secret)));
        return proofs.filter(proof => states.get(proofY(proof.secret)) === 'UNSPENT');
    }

    // NUT-13 recovery of one keyset: stops after three empty batches of 100.
    private async scanKeyset(ctx: MintContext, keysetId: string): Promise<{ proofs: CashuProof[]; highest: number; signed: Set<number> }> {
        const seed = await this.host.getSeed(await this.host.loadWallet());
        const proofs: CashuProof[] = [];
        const signed = new Set<number>();
        let highest = -1;
        let empty = 0;
        for (let start = 0; empty < RESTORE_EMPTY_BATCHES; start += RESTORE_BATCH) {
            const data = Array.from({ length: RESTORE_BATCH }, (_, i) =>
                OutputData.createSingleDeterministicData(0, seed, start + i, keysetId));
            const found = await ctx.client.restore(data.map(item => ({ amount: 0, id: keysetId, B_: item.blindedMessage.B_ })));
            if (found.size === 0) {
                empty += 1;
                continue;
            }
            empty = 0;
            for (let i = 0; i < data.length; i++) {
                const signature = found.get(data[i].blindedMessage.B_);
                if (signature) {
                    proofs.push(await this.unblind(ctx, signature, data[i]));
                    signed.add(start + i);
                    highest = Math.max(highest, start + i);
                }
            }
        }
        return { proofs, highest, signed };
    }

    // The outcome of a swap-shaped request the mint would not accept as sent.
    private async resolveRejected(
        ctx: MintContext,
        id: string,
        error: CashuMintError,
        retried: boolean,
        report?: SwapReport,
    ): Promise<OperationOutcome> {
        const op = (await this.readOp(ctx, id))!;
        if (error.code === OUTPUTS_PENDING) {
            return 'open';
        }
        const { data, blinded } = await this.outputData(op);
        const recovered = await ctx.client.restore(blinded);
        const inputStates = await this.inputStates(ctx, op.inputs);
        if (inputStates.includes('PENDING')) {
            return 'open';
        }
        const spent = inputStates.includes('SPENT');

        // An earlier attempt was signed and its response lost, which spends every
        // input and signs these outputs for these amounts. Anything less is someone
        // else's use of the proofs or counters, as with a stale copy of the wallet.
        if (inputStates.every(state => state === 'SPENT') && blinded.length > 0
            && blinded.every((output, i) => Number(recovered.get(output.B_)?.amount) === op.outputs[i].amount)) {
            const signatures = blinded.map(output => recovered.get(output.B_)!);
            await this.applySwap(ctx, id, signatures, data);
            return 'done';
        }
        if (!spent && recovered.size > 0 && !retried) {
            await this.repairAndRenumber(ctx, id, op.keyset);
            return this.runSwap(ctx, id, true, report);
        }

        // Settled and unable to sign: its unsigned counters are free again.
        const unsigned = op.outputs
            .filter((output, i) => output.counter !== undefined && !recovered.has(blinded[i].B_))
            .map(output => output.counter!);
        const retire = async (wallet: WalletFile) => {
            const entry = await this.entryOf(wallet, ctx);
            this.release(wallet, op.keyset, unsigned);
            // Refused, not spent: the message can be redeemed again.
            if (!spent && op.message) {
                delete (await this.host.fetchIdInfo(ctx.name, wallet)).cashuInbox?.[op.message];
            }
            // The recipient may still hold a token's proofs, so a refusal leaves it
            // outstanding rather than making it balance.
            if (!spent && op.token) {
                const stored = entry.operations!.find(item => item.id === id)!;
                stored.sent = stored.inputs;
                stored.inputs = [];
                stored.outputs = [];
                delete stored.token;
                return entry;
            }
            this.retire(entry, id);
            // Only what the identity owned goes back; a received token's proofs
            // were never its own.
            if (!spent && op.kind !== 'receive') {
                this.credit(wallet, entry, op.inputs);
            }
            return entry;
        };

        if (report) {
            report.redeemed += sumProofs(op.inputs.filter((_, i) => inputStates[i] === 'SPENT'));
        }
        // Spent only in part, the rest is still worth having: a token's other holder
        // may be slower, and a received token's proofs are as good as they were.
        const remainder = spent
            ? op.inputs.filter((_, i) => inputStates[i] === 'UNSPENT')
            : [];
        if (remainder.length > 0) {
            await this.swapRemainder(ctx, remainder, retire, report, op);
        }
        else {
            await this.host.mutateWallet(async (wallet) => { await retire(wallet); });
        }
        if (!spent) {
            throw error;
        }
        return 'spent';
    }

    // What is left of a partly spent operation. It is swapped rather than credited:
    // when reclaiming a token, the recipient still holds these proofs. If the mint
    // cannot be reached the new record is left for settlement; if it refuses, the
    // proofs stay outstanding.
    private async swapRemainder(
        ctx: MintContext,
        inputs: CashuProof[],
        retire: (wallet: WalletFile) => Promise<CashuMintEntry>,
        report?: SwapReport,
        from?: Pick<CashuOperation, 'kind' | 'token' | 'message' | 'delivery'>,
    ): Promise<void> {
        const { keyset, keysets } = await this.activeKeyset(ctx);
        const value = sumProofs(inputs) - feeFor(inputs, keysets);
        const swapId = newId();
        // Worth less than the fee to redeem it, it is not worth a record.
        if (value <= 0) {
            await this.host.mutateWallet(async (wallet) => { await retire(wallet); });
            return;
        }
        let outcome: OperationOutcome = 'open';
        try {
            outcome = await this.journaled(swapId, async (wallet) => {
                const entry = await retire(wallet);
                // A received token stays one: a refusal must not make its proofs balance.
                const received = from?.kind === 'receive';
                this.journalSwap(wallet, entry, swapId, received ? 'receive' : 'swap', inputs, keyset.id, value, from?.token);
                const journaled = entry.operations![entry.operations!.length - 1];
                if (from?.message) {
                    journaled.message = from.message;
                }
                // What a refusal leaves outstanding can still be delivered.
                if (from?.token && from.delivery) {
                    journaled.delivery = from.delivery;
                }
            }, () => this.runSwap(ctx, swapId, false, report));
        }
        catch (error) {
            if (!(error instanceof CashuMintError || error instanceof CashuUnavailableError)) {
                throw error;
            }
            if (report && from?.kind === 'receive' && error instanceof CashuMintError) {
                report.refused += sumProofs(inputs);
                return;
            }
        }
        if (report && outcome === 'done') {
            report.recovered += value;
        }
        else if (report && outcome === 'open') {
            report.pending += sumProofs(inputs);
        }
    }

    private journalSwap(
        wallet: WalletFile,
        entry: CashuMintEntry,
        id: string,
        kind: 'swap' | 'receive',
        inputs: CashuProof[],
        keyset: string,
        value: number,
        token?: boolean,
    ): void {
        const parts = splitAmount(value);
        const counters = this.reserve(wallet, keyset, parts.length);
        (entry.operations ??= []).push({
            id,
            kind,
            ...(token && { token }),
            inputs,
            keyset,
            outputs: parts.map((part, i) => ({ amount: part, role: 'keep' as const, counter: counters[i] })),
            created: new Date().toISOString(),
        });
    }

    private async applySwap(
        ctx: MintContext,
        id: string,
        signatures: SerializedBlindedSignature[],
        data: OutputData[],
    ): Promise<void> {
        const op = (await this.readOp(ctx, id))!;
        const proofs = await Promise.all(signatures.map((signature, i) => this.unblind(ctx, signature, data[i])));
        const keep = proofs.filter((_, i) => op.outputs[i].role === 'keep');
        const sent = proofs.filter((_, i) => op.outputs[i].role === 'send');
        await this.host.mutateWallet(async (wallet) => {
            const entry = await this.entryOf(wallet, ctx);
            const stored = entry.operations!.find(item => item.id === id)!;
            if (sent.length > 0) {
                // Outstanding until redeemed: not balance, and not in flight.
                stored.sent = sent;
                stored.inputs = [];
                stored.outputs = [];
            }
            else {
                this.retire(entry, id);
            }
            this.credit(wallet, entry, keep);
        });
    }

    private async runSwap(ctx: MintContext, id: string, retried = false, report?: SwapReport): Promise<OperationOutcome> {
        const op = (await this.readOp(ctx, id))!;
        const { data, blinded } = await this.outputData(op);
        try {
            const { signatures } = await ctx.client.swap(op.inputs, blinded);
            await this.applySwap(ctx, id, signatures, data);
            return 'done';
        }
        catch (error) {
            if (error instanceof CashuMintError) {
                return this.resolveRejected(ctx, id, error, retried, report);
            }
            throw error;
        }
    }

    private async dropOp(ctx: MintContext, id: string): Promise<void> {
        await this.host.mutateWallet(async (wallet) => {
            this.retire(await this.entryOf(wallet, ctx), id);
        });
    }

    private async settleSent(ctx: MintContext, op: CashuOperation): Promise<OperationOutcome> {
        const states = await this.inputStates(ctx, op.sent!);
        if (states.every(state => state === 'SPENT')) {
            await this.dropOp(ctx, op.id);
            return 'done';
        }
        return 'open';
    }

    private async runMint(ctx: MintContext, id: string, retried = false): Promise<OperationOutcome> {
        const op = (await this.readOp(ctx, id))!;
        const quote = await ctx.client.checkMintQuote(op.quote!);

        if (quote.state === 'ISSUED') {
            return this.recoverMint(ctx, id);
        }
        if (quote.state !== 'PAID') {
            const expiry = quote.expiry ?? op.expiry;
            if (expiry && expiry * 1000 < Date.now()) {
                await this.releaseUnsigned(ctx, id);
                return 'rejected';
            }
            return 'open';
        }

        if (op.outputs.length === 0) {
            const { keyset } = await this.activeKeyset(ctx);
            await this.host.mutateWallet(async (wallet) => {
                const stored = (await this.entryOf(wallet, ctx)).operations!.find(item => item.id === id)!;
                const parts = splitAmount(stored.amount!);
                const counters = this.reserve(wallet, keyset.id, parts.length);
                stored.keyset = keyset.id;
                stored.outputs = parts.map((amount, i) => ({ amount, role: 'keep' as const, counter: counters[i] }));
            });
        }

        const current = (await this.readOp(ctx, id))!;
        const { data, blinded } = await this.outputData(current);
        const signature = current.quoteKey
            ? signMintQuote(current.quoteKey, current.quote!, blinded as never)
            : undefined;
        try {
            const { signatures } = await ctx.client.mint(current.quote!, blinded, signature);
            const proofs = await Promise.all(signatures.map((sig: SerializedBlindedSignature, i: number) => this.unblind(ctx, sig, data[i])));
            await this.host.mutateWallet(async (wallet) => {
                const entry = await this.entryOf(wallet, ctx);
                this.retire(entry, id);
                this.credit(wallet, entry, proofs);
            });
            return 'done';
        }
        catch (error) {
            if (!(error instanceof CashuMintError)) {
                throw error;
            }
            if (error.code === OUTPUTS_PENDING) {
                return 'open';
            }
            const after = await ctx.client.checkMintQuote(current.quote!);
            if (after.state === 'ISSUED') {
                return this.recoverMint(ctx, id);
            }
            if (!retried && (await ctx.client.restore(blinded)).size > 0) {
                await this.repairAndRenumber(ctx, id, current.keyset);
                return this.runMint(ctx, id, true);
            }
            throw error;
        }
    }

    // The quote was issued: an earlier claim's response was lost, or another
    // copy of the wallet claimed it.
    private async recoverMint(ctx: MintContext, id: string): Promise<OperationOutcome> {
        const op = (await this.readOp(ctx, id))!;
        const { data, blinded } = await this.outputData(op);
        const recovered = await ctx.client.restore(blinded);
        const proofs: CashuProof[] = [];
        const unsigned: number[] = [];
        for (let i = 0; i < blinded.length; i++) {
            const signature = recovered.get(blinded[i].B_);
            if (signature) {
                proofs.push(await this.unblind(ctx, signature, data[i]));
            }
            else {
                unsigned.push(op.outputs[i].counter!);
            }
        }
        await this.host.mutateWallet(async (wallet) => {
            const entry = await this.entryOf(wallet, ctx);
            this.retire(entry, id);
            this.release(wallet, op.keyset, unsigned);
            this.credit(wallet, entry, proofs);
        });
        return 'done';
    }

    // Retires a record whose outputs were never signed, after confirming that.
    private async releaseUnsigned(ctx: MintContext, id: string): Promise<void> {
        const op = (await this.readOp(ctx, id))!;
        const { blinded } = await this.outputData(op);
        const recovered = await ctx.client.restore(blinded);
        const unsigned = op.outputs.filter((_, i) => !recovered.has(blinded[i].B_)).map(output => output.counter!);
        await this.host.mutateWallet(async (wallet) => {
            this.retire(await this.entryOf(wallet, ctx), id);
            this.release(wallet, op.keyset, unsigned);
        });
    }

    private async settleMelt(ctx: MintContext, id: string, known?: any): Promise<{ outcome: OperationOutcome; quote?: any; change: number }> {
        const op = (await this.readOp(ctx, id))!;
        const quote = known ?? await ctx.client.checkMeltQuote(op.quote!);

        if (quote.state === 'PENDING') {
            return { outcome: 'open', quote, change: 0 };
        }
        const { data, blinded } = await this.outputData(op);

        if (quote.state === 'PAID') {
            const change: SerializedBlindedSignature[] = quote.change ?? [];
            const proofs: CashuProof[] = [];
            for (let i = 0; i < change.length; i++) {
                proofs.push(await this.unblind(ctx, change[i], data[i]));
            }
            // NUT-08 lets the mint sign fewer change outputs than were sent. The
            // tail is free once NUT-09 confirms it holds no signature for it.
            const tail = blinded.slice(change.length);
            const recovered = await ctx.client.restore(tail);
            const unsigned: number[] = [];
            for (let i = 0; i < tail.length; i++) {
                const signature = recovered.get(tail[i].B_);
                if (signature) {
                    proofs.push(await this.unblind(ctx, signature, data[change.length + i]));
                }
                else {
                    unsigned.push(op.outputs[change.length + i].counter!);
                }
            }
            await this.host.mutateWallet(async (wallet) => {
                const entry = await this.entryOf(wallet, ctx);
                this.retire(entry, id);
                this.release(wallet, op.keyset, unsigned);
                this.credit(wallet, entry, proofs);
            });
            return { outcome: 'done', quote, change: sumProofs(proofs) };
        }

        // Unpaid: the inputs come back once the mint shows them unspent.
        const states = await this.inputStates(ctx, op.inputs);
        if (states.includes('PENDING')) {
            return { outcome: 'open', quote, change: 0 };
        }
        if (states.includes('SPENT')) {
            // A mint marks a melt's inputs spent no earlier than it marks the quote
            // paid, so an input spent under a quote still unpaid when read again was
            // spent by something else, such as another copy of the wallet. This melt
            // cannot complete. Its change counters stay used, in case this is wrong
            // for some mint: a restore can still find the change.
            const again = await ctx.client.checkMeltQuote(op.quote!);
            if (again.state === 'PAID') {
                return this.settleMelt(ctx, id, again);
            }
            if (again.state !== 'UNPAID') {
                return { outcome: 'open', quote: again, change: 0 };
            }
            const retire = async (wallet: WalletFile) => {
                const entry = await this.entryOf(wallet, ctx);
                this.retire(entry, id);
                return entry;
            };
            const remainder = op.inputs.filter((_, i) => states[i] === 'UNSPENT');
            if (remainder.length > 0) {
                await this.swapRemainder(ctx, remainder, retire);
            }
            else {
                await this.host.mutateWallet(async (wallet) => { await retire(wallet); });
            }
            return { outcome: 'rejected', quote: again, change: 0 };
        }
        const recovered = await ctx.client.restore(blinded);
        const unsigned = op.outputs.filter((_, i) => !recovered.has(blinded[i].B_)).map(output => output.counter!);
        await this.host.mutateWallet(async (wallet) => {
            const entry = await this.entryOf(wallet, ctx);
            this.retire(entry, id);
            this.release(wallet, op.keyset, unsigned);
            this.credit(wallet, entry, op.inputs);
        });
        return { outcome: 'rejected', quote, change: 0 };
    }

    private async submitMelt(ctx: MintContext, id: string, retried = false): Promise<{ response?: any; refusal?: CashuMintError }> {
        const op = (await this.readOp(ctx, id))!;
        const { blinded } = await this.outputData(op);
        try {
            return { response: await ctx.client.melt(op.quote!, op.inputs, blinded) };
        }
        catch (error) {
            if (!(error instanceof CashuMintError)) {
                throw error;
            }
            if (!retried && (await ctx.client.restore(blinded)).size > 0) {
                const quote = await ctx.client.checkMeltQuote(op.quote!);
                if (quote.state === 'UNPAID') {
                    await this.repairAndRenumber(ctx, id, op.keyset);
                    return this.submitMelt(ctx, id, true);
                }
            }
            return { refusal: error };
        }
    }

    private async settleOp(ctx: MintContext, op: CashuOperation): Promise<OperationOutcome> {
        switch (op.kind) {
        case 'mint':
            return this.runMint(ctx, op.id);
        case 'melt':
            return (await this.settleMelt(ctx, op.id)).outcome;
        default: {
            if (op.sent) {
                await this.deliver(ctx, op.id);
                return this.settleSent(ctx, op);
            }
            const outcome = await this.runSwap(ctx, op.id);
            if (outcome === 'done') {
                await this.deliver(ctx, op.id);
            }
            return outcome;
        }
        }
    }

    // Settles the mint's open records for the identity. Unpaid mint quotes stay
    // open without counting against anything. One record's failure does not block
    // the rest, or the operation that asked for settlement.
    private async settle(ctx: MintContext): Promise<CashuCheckResult> {
        const entry = await this.entryOf(await this.host.loadWallet(), ctx);
        let settled = 0;
        let remaining = 0;
        for (const { id } of entry.operations ?? []) {
            // Checked per record: earlier records take time to settle, during which
            // a concurrent operation can start or finish this one.
            if (this.active.has(id)) {
                remaining += 1;
                continue;
            }
            let outcome: OperationOutcome | undefined;
            try {
                outcome = await this.withActive(id, async () => {
                    const op = await this.readOp(ctx, id);
                    return op && this.settleOp(ctx, op);
                });
            }
            catch (error) {
                if (!(error instanceof CashuMintError || error instanceof CashuUnavailableError)) {
                    throw error;
                }
                outcome = await this.readOp(ctx, id) ? 'open' : 'rejected';
            }
            if (outcome === 'open') {
                remaining += 1;
            }
            else if (outcome) {
                settled += 1;
            }
        }
        return { settled, open: remaining };
    }

    // ---- enabling and mint trust ----

    private async requireNuts(client: CashuMintClient, url: string): Promise<any> {
        const info = await client.info();
        const missing = REQUIRED_NUTS.filter(nut => !info?.nuts?.[nut]?.supported);
        if (missing.length > 0) {
            throw new CashuMintUnsupportedError(`${url} does not support NUT-${missing.join(', NUT-')}`);
        }
        return info;
    }

    async addCashu(name?: string): Promise<CashuMintInfo> {
        const identity = await this.boundIdentity(name);
        const node = this.nodeUrl();
        const capabilities = await this.host.getCapabilities();
        const url = capabilities?.cashu === false ? undefined : await this.host.gatekeeper.getCashuMint?.();
        if (!node || !url) {
            throw new CashuUnavailableError('this node offers no Cashu mint; use addCashuMint to add another');
        }
        const normalized = normalizeMintUrl(url);
        const client = new CashuMintClient(`${node}/cashu`, fetch.bind(globalThis));
        await this.requireNuts(client, normalized);
        const listed = new Set((await client.keysets()).map(keyset => keyset.id));

        await this.host.mutateWallet(async (wallet) => {
            const idInfo = await this.host.fetchIdInfo(identity, wallet);
            const mints = (idInfo.cashu ??= {}) as Record<string, CashuMintEntry>;
            if (mints[normalized]) {
                return;
            }
            // The public host changed: the same mint keeps its entry. Keyset ids
            // tell whether it is the same mint, so a different one is never
            // relabelled.
            const previous = Object.keys(mints).find((candidate) => {
                const entry = mints[candidate];
                const used = [
                    ...entry.proofs,
                    ...(entry.operations ?? []).flatMap(op => [...op.inputs, ...(op.sent ?? [])]),
                ];
                return entry.node === node && used.every(proof => listed.has(proof.id));
            });
            if (previous) {
                mints[normalized] = mints[previous];
                delete mints[previous];
            }
            else {
                mints[normalized] = { added: new Date().toISOString(), node, proofs: [] };
            }
        });
        return this.describe(normalized, client, true);
    }

    async addCashuMint(url: string, name?: string): Promise<CashuMintInfo> {
        const identity = await this.boundIdentity(name);
        const normalized = normalizeMintUrl(url);
        const client = new CashuMintClient(normalized, this.publicFetch);
        await this.requireNuts(client, normalized);
        // Read before saving, so that a mint this wallet cannot use is not left behind.
        const described = await this.describe(normalized, client, false);
        await this.host.mutateWallet(async (wallet) => {
            const idInfo = await this.host.fetchIdInfo(identity, wallet);
            const mints = (idInfo.cashu ??= {}) as Record<string, CashuMintEntry>;
            mints[normalized] ??= { added: new Date().toISOString(), proofs: [] };
        });
        return described;
    }

    private async describe(url: string, client: CashuMintClient, isNodeMint: boolean): Promise<CashuMintInfo> {
        const [info, keysets] = await Promise.all([client.info(), client.keysets()]);
        return { url, name: info?.name, nuts: info?.nuts ?? {}, keysets, isNodeMint };
    }

    async removeCashuMint(url: string, force = false, name?: string): Promise<boolean> {
        const normalized = normalizeMintUrl(url);
        await this.host.mutateWallet(async (wallet) => {
            const idInfo = await this.host.fetchIdInfo(name, wallet);
            const entry = this.mints(idInfo)[normalized];
            if (!entry) {
                throw new CashuMintNotAddedError(normalized);
            }
            if (force !== true && (entry.proofs.length > 0 || (entry.operations?.length ?? 0) > 0)) {
                throw new CashuStateError(`${normalized} holds ecash or open operations; use force to discard them`);
            }
            delete idInfo.cashu[normalized];
            if (Object.keys(idInfo.cashu).length === 0) {
                delete idInfo.cashu;
            }
        });
        return true;
    }

    async removeCashu(force = false, name?: string): Promise<boolean> {
        await this.host.mutateWallet(async (wallet) => {
            const idInfo = await this.host.fetchIdInfo(name, wallet);
            if (force !== true && hasCashuState(idInfo)) {
                throw new CashuStateError('this identity holds ecash or open operations; use force to discard them');
            }
            delete idInfo.cashu;
        });
        return true;
    }

    async listCashuMints(name?: string): Promise<CashuMintInfo[]> {
        const idInfo = await this.host.fetchIdInfo(name, await this.host.loadWallet());
        const node = this.nodeUrl();
        const mints = this.mints(idInfo);
        return Promise.all(Object.keys(mints).map(async (url) => {
            const isNodeMint = !!mints[url].node && mints[url].node === node;
            try {
                return await this.describe(url, this.clientFor(url, mints[url]), isNodeMint);
            }
            catch (error: any) {
                return { url, nuts: {}, keysets: [], isNodeMint, error: error?.message ?? String(error) };
            }
        }));
    }

    // ---- read methods: never settle or send anything ----

    private entryTotals(entry: CashuMintEntry) {
        const operations = entry.operations ?? [];
        return {
            spendable: sumProofs(entry.proofs),
            inFlight: operations.reduce((total, op) => total + sumProofs(op.inputs), 0),
            outstanding: operations.reduce((total, op) => total + sumProofs(op.sent ?? []), 0),
        };
    }

    async getCashuBalance(mint?: string, name?: string): Promise<CashuBalance> {
        const idInfo = await this.host.fetchIdInfo(name, await this.host.loadWallet());
        const mints = this.mints(idInfo);
        const urls = Object.keys(mints);
        if (urls.length === 0) {
            throw new CashuNotConfiguredError(`No Cashu mints configured for ${idInfo.did}`);
        }
        if (mint) {
            const url = normalizeMintUrl(mint);
            if (!mints[url]) {
                throw new CashuMintNotAddedError(url);
            }
            return this.entryTotals(mints[url]);
        }
        if (urls.length === 1) {
            return this.entryTotals(mints[urls[0]]);
        }
        const breakdown: NonNullable<CashuBalance['mints']> = {};
        const total = { spendable: 0, inFlight: 0, outstanding: 0 };
        for (const url of urls) {
            const totals = this.entryTotals(mints[url]);
            breakdown[url] = totals;
            total.spendable += totals.spendable;
            total.inFlight += totals.inFlight;
            total.outstanding += totals.outstanding;
        }
        return { ...total, mints: breakdown };
    }

    private async scopedEntries(mint: string | undefined, name?: string): Promise<[string, CashuMintEntry][]> {
        const idInfo = await this.host.fetchIdInfo(name, await this.host.loadWallet());
        const mints = this.mints(idInfo);
        if (mint) {
            const url = normalizeMintUrl(mint);
            if (!mints[url]) {
                throw new CashuMintNotAddedError(url);
            }
            return [[url, mints[url]]];
        }
        return Object.entries(mints);
    }

    async listCashuQuotes(mint?: string, name?: string): Promise<CashuQuoteRecord[]> {
        return (await this.scopedEntries(mint, name)).flatMap(([url, entry]) =>
            (entry.operations ?? [])
                .filter(op => op.kind === 'mint' || op.kind === 'melt')
                .map(op => ({
                    operationId: op.id,
                    kind: op.kind as 'mint' | 'melt',
                    quote: op.quote!,
                    mint: url,
                    amount: op.amount,
                    request: op.request,
                    expiry: op.expiry,
                    created: op.created,
                })));
    }

    async listCashuSends(mint?: string, name?: string): Promise<CashuSendRecord[]> {
        return (await this.scopedEntries(mint, name)).flatMap(([url, entry]) =>
            (entry.operations ?? [])
                .filter(op => op.sent)
                .map((op) => {
                    const locktime = op.sent!.length > 0 ? p2pkLock(op.sent![0].secret)?.locktime : undefined;
                    return {
                        operationId: op.id,
                        mint: url,
                        amount: sumProofs(op.sent!),
                        created: op.created,
                        ...(op.delivery && {
                            recipient: op.delivery.recipient,
                            delivered: op.delivery.delivered,
                            ...(op.delivery.memo && { memo: op.delivery.memo }),
                        }),
                        ...(locktime !== undefined && { locktime }),
                    };
                }));
    }

    // ---- operations ----

    async createCashuMintQuote(amount: number, mint?: string, name?: string): Promise<CashuMintQuote> {
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw new InvalidParameterError('amount');
        }
        const ctx = await this.context(mint, name);
        await this.settle(ctx);

        // NUT-04 warns that anyone who learns a quote id can otherwise claim its
        // tokens, and quote ids appear in URLs that proxies log. The key is
        // random per quote so the mint cannot link quotes to an identity.
        const info = await ctx.client.info();
        const secret = info?.nuts?.['20']?.supported ? createRandomSecretKey() : undefined;
        const quote = await ctx.client.createMintQuote(amount, secret && toHex(getPubKeyFromPrivKey(secret)));
        // The invoice is the mint's to choose, and paying it may be automatic.
        // quote.amount proves nothing, since it only echoes the request.
        if (invoiceMsat(quote.request) !== BigInt(amount) * 1000n) {
            throw new CashuMintUnsupportedError(`the mint's invoice is not for the ${amount} sats requested`);
        }

        await this.host.mutateWallet(async (wallet) => {
            const entry = await this.entryOf(wallet, ctx);
            (entry.operations ??= []).push({
                id: newId(),
                kind: 'mint',
                quote: quote.quote,
                ...(secret && { quoteKey: toHex(secret) }),
                request: quote.request,
                ...(quote.expiry && { expiry: quote.expiry }),
                amount,
                inputs: [],
                keyset: '',
                outputs: [],
                created: new Date().toISOString(),
            });
        });
        return { quote: quote.quote, request: quote.request, amount, state: quote.state, expiry: quote.expiry ?? undefined };
    }

    async claimCashuMintQuote(quoteId: string, mint?: string, name?: string): Promise<CashuClaimResult> {
        const ctx = await this.context(mint, name);
        const entry = await this.entryOf(await this.host.loadWallet(), ctx);
        const op = entry.operations?.find(item => item.kind === 'mint' && item.quote === quoteId);
        if (!op) {
            throw new InvalidParameterError('quote');
        }
        if (this.active.has(op.id)) {
            throw new CashuUnavailableError(`quote ${quoteId} is already being claimed`);
        }
        const outcome = await this.withActive(op.id, () => this.runMint(ctx, op.id));
        if (outcome !== 'done') {
            throw new CashuQuoteUnpaidError(quoteId);
        }
        return { amount: op.amount!, mint: ctx.url };
    }

    async meltCashu(bolt11: string, mint?: string, name?: string): Promise<CashuMeltResult> {
        if (typeof bolt11 !== 'string' || !bolt11) {
            throw new InvalidParameterError('bolt11');
        }
        // The wallet never sends the amountless option, so an invoice must say what it
        // costs, and the mint's own figure is checked against that.
        const msat = invoiceMsat(bolt11);
        if (msat === undefined) {
            throw new InvalidParameterError('bolt11 must be an invoice with an amount');
        }
        const ctx = await this.context(mint, name);
        await this.settle(ctx);
        const quote = await ctx.client.createMeltQuote(bolt11);
        if (BigInt(quote.amount) !== (msat + 999n) / 1000n) {
            throw new CashuMintUnsupportedError(`the mint quoted ${quote.amount} sats for an invoice of ${msat} msat`);
        }
        const { keyset, keysets } = await this.activeKeyset(ctx);
        const target = quote.amount + quote.fee_reserve;
        const id = newId();
        let spent = 0;

        return this.journaled(id, async (wallet) => {
            const entry = await this.entryOf(wallet, ctx);
            const inputs = this.select(entry.proofs, target, keysets);
            this.removeFromEntry(entry, inputs);
            spent = sumProofs(inputs);
            // NUT-08: enough blank outputs for whatever the mint returns.
            const overpaid = spent - feeFor(inputs, keysets) - quote.amount;
            const blanks = Math.max(Math.ceil(Math.log2(Math.max(overpaid, 1))), 1);
            const counters = this.reserve(wallet, keyset.id, blanks);
            (entry.operations ??= []).push({
                id,
                kind: 'melt',
                quote: quote.quote,
                request: bolt11,
                amount: quote.amount,
                inputs,
                keyset: keyset.id,
                outputs: counters.map(counter => ({ amount: 0, role: 'keep' as const, counter })),
                created: new Date().toISOString(),
            });
        }, async () => {
            // On a refusal the quote says what actually happened.
            const { response, refusal } = await this.submitMelt(ctx, id);
            const { outcome, quote: final, change } = await this.settleMelt(ctx, id, response?.state ? response : undefined);
            if (outcome === 'rejected' && refusal) {
                throw refusal;
            }
            const paid = outcome === 'done';
            return {
                paid,
                ...(outcome === 'open' && { pending: true }),
                ...(final?.payment_preimage && { preimage: final.payment_preimage }),
                ...(paid && { fee: spent - quote.amount - change }),
                change,
            };
        });
    }

    // The recipient must net the amount after the fee on redeeming the sent proofs.
    // That fee follows the number of parts, which does not grow with the value, so
    // this finds the smallest gross that nets enough rather than solving for an
    // exact one that may not exist.
    private grossFor(amount: number, keyset: MintKeyset): number {
        const ppk = keyset.input_fee_ppk ?? 0;
        let gross = amount;
        while (gross - Math.ceil(splitAmount(gross).length * ppk / 1000) < amount) {
            gross += 1;
        }
        return gross;
    }

    async sendCashu(amount: number, mint?: string, name?: string): Promise<CashuSendResult> {
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw new InvalidParameterError('amount');
        }
        const ctx = await this.context(mint, name);
        await this.settle(ctx);
        const { keyset, keysets } = await this.activeKeyset(ctx);

        const gross = this.grossFor(amount, keyset);

        const id = newId();
        const outcome = await this.journaled(id, async (wallet) => {
            const entry = await this.entryOf(wallet, ctx);
            const inputs = this.select(entry.proofs, gross, keysets);
            this.removeFromEntry(entry, inputs);
            const send = splitAmount(gross);
            const keep = splitAmount(sumProofs(inputs) - feeFor(inputs, keysets) - gross);
            const counters = this.reserve(wallet, keyset.id, send.length + keep.length);
            (entry.operations ??= []).push({
                id,
                kind: 'send',
                inputs,
                keyset: keyset.id,
                outputs: [
                    ...send.map((part, i) => ({ amount: part, role: 'send' as const, counter: counters[i] })),
                    ...keep.map((part, i) => ({ amount: part, role: 'keep' as const, counter: counters[send.length + i] })),
                ],
                created: new Date().toISOString(),
            });
        }, () => this.runSwap(ctx, id));
        if (outcome === 'spent') {
            throw new CashuTokenSpentError('some selected proofs were already spent; the rest were kept, so try again');
        }
        if (outcome !== 'done') {
            throw new CashuUnavailableError(`${ctx.url} has the send pending; run cashu-check`);
        }
        const op = (await this.readOp(ctx, id))!;
        const token = getEncodedToken({ mint: ctx.url, unit: UNIT, proofs: op.sent as never });
        return { token, amount, fee: gross - amount, operationId: id };
    }

    private tokenMint(token: string): string {
        try {
            return normalizeMintUrl(getTokenMetadata(token).mint);
        }
        catch {
            throw new InvalidParameterError('token');
        }
    }

    async receiveCashu(token: string, name?: string): Promise<CashuReceiveResult> {
        // Refused before any request: a token cannot point Keymaster at a host.
        const ctx = await this.context(this.tokenMint(token), name);
        await this.settle(ctx);
        return this.redeem(ctx, token);
    }

    // The key this identity would sign a locked proof with now, if it holds one.
    private async lockKey(lock: P2PKLock, expired: boolean, name?: string): Promise<string | undefined> {
        const key = await this.host.findPrivateKey(lock.keys, name);
        return key ?? (expired && lock.refundSignatures === 1
            ? this.host.findPrivateKey(lock.refund, name)
            : undefined);
    }

    // Locked proofs get their witnesses here, and the signed inputs are what the
    // record keeps, so a resubmission sends exactly the same request.
    private async signLocked(ctx: MintContext, proofs: CashuProof[]): Promise<CashuProof[]> {
        const now = Math.floor(Date.now() / 1000);
        const signed: CashuProof[] = [];
        for (const proof of proofs) {
            const lock = p2pkLock(proof.secret);
            if (!lock) {
                signed.push(proof);
                continue;
            }
            if (lock.sigAll || lock.signatures !== 1) {
                throw new CashuMintUnsupportedError('a token needing SIG_ALL or several signatures');
            }
            // NUT-11: past its locktime a proof with no refund key needs no signature,
            // and one with a refund key can be spent by either that key or the main one.
            const expired = lock.locktime !== undefined && lock.locktime <= now;
            if (expired && lock.refund.length === 0) {
                signed.push(proof);
                continue;
            }
            const key = await this.lockKey(lock, expired, ctx.name);
            if (!key) {
                throw new CashuTokenLockedError(lock.locktime !== undefined && lock.refund.length > 0 && !expired
                    ? `locked until ${new Date(lock.locktime * 1000).toISOString()}, and to a key this identity does not hold`
                    : 'locked to a key this identity does not hold');
            }
            const [witnessed] = signP2PKProofs([{ ...proof, witness: undefined } as never], key);
            const witness = witnessed.witness;
            signed.push({ ...proof, witness: typeof witness === 'string' ? witness : JSON.stringify(witness) });
        }
        return signed;
    }

    private async redeem(ctx: MintContext, token: string, message?: string): Promise<CashuReceiveResult> {
        const { keyset, keysets } = await this.activeKeyset(ctx);

        let proofs: CashuProof[];
        try {
            const decoded = getDecodedToken(token, keysets.map(item => item.id));
            if (decoded.unit && decoded.unit !== UNIT) {
                throw new Error('unit');
            }
            for (const proof of decoded.proofs) {
                if (!hasValidDleq(proof, await ctx.client.keys(proof.id), { require: false })) {
                    throw new Error('dleq');
                }
            }
            proofs = decoded.proofs.map(plainProof);
        }
        catch (error) {
            // An unreachable mint says nothing about the token.
            if (error instanceof CashuUnavailableError) {
                throw error;
            }
            throw new InvalidParameterError('token');
        }

        const amount = sumProofs(proofs) - feeFor(proofs, keysets);
        if (amount <= 0) {
            throw new InvalidParameterError('token amount does not cover its fee');
        }
        const inputs = await this.signLocked(ctx, proofs);

        const id = newId();
        const report: SwapReport = { redeemed: 0, recovered: 0, pending: 0, refused: 0 };
        const outcome = await this.journaled(id, async (wallet) => {
            const entry = await this.entryOf(wallet, ctx);
            const held = new Set(entry.proofs.map(proof => proof.secret));
            if (proofs.some(proof => held.has(proof.secret))) {
                throw new CashuTokenSpentError('this token is already in the wallet');
            }
            // Checked in the same write that claims it, so a concurrent accept of the
            // same message waits rather than submitting its proofs a second time.
            const idInfo = await this.host.fetchIdInfo(ctx.name, wallet);
            if (message && idInfo.cashuInbox?.[message]) {
                throw new CashuUnavailableError('this message is already being redeemed');
            }
            this.journalSwap(wallet, entry, id, 'receive', inputs, keyset.id, amount);
            if (message) {
                entry.operations![entry.operations!.length - 1].message = message;
                this.rememberMessage(idInfo, message);
            }
        }, () => this.runSwap(ctx, id, false, report));
        if (outcome === 'spent') {
            if (report.refused > 0) {
                throw new CashuUnavailableError(`${ctx.url} refused the part of this token still unspent`);
            }
            if (report.pending > 0) {
                throw new CashuUnavailableError(`${ctx.url} has the token pending; run cashu-check`);
            }
            if (report.recovered === 0) {
                throw new CashuTokenSpentError();
            }
            return { amount: report.recovered, mint: ctx.url, spent: report.redeemed };
        }
        if (outcome === 'open') {
            throw new CashuUnavailableError(`${ctx.url} has the token pending; run cashu-check`);
        }
        return { amount, mint: ctx.url };
    }

    // ---- DID-locked sends over DIDComm ----

    private rememberMessage(idInfo: IDInfo, key: string): void {
        const cutoff = Date.now() - INBOX_MEMORY_MS;
        const inbox: Record<string, string> = idInfo.cashuInbox ?? {};
        for (const [known, seen] of Object.entries(inbox)) {
            if (Date.parse(seen) < cutoff) {
                delete inbox[known];
            }
        }
        inbox[key] = new Date().toISOString();
        idInfo.cashuInbox = inbox;
    }

    async sendCashuTo(recipient: string, amount: number, options: CashuSendToOptions = {}): Promise<CashuSendToResult> {
        // A JSON caller may send null for what it does not set.
        const memo = options.memo ?? undefined;
        const locktime = options.locktime ?? LOCKTIME_DEFAULT_SECONDS;
        const { mint, name } = options;
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw new InvalidParameterError('amount');
        }
        if (!Number.isSafeInteger(locktime) || locktime <= 0 || locktime > LOCKTIME_MAX_SECONDS) {
            throw new InvalidParameterError(`locktime must be from 1 to ${LOCKTIME_MAX_SECONDS} seconds`);
        }
        if (memo !== undefined && typeof memo !== 'string') {
            throw new InvalidParameterError('memo');
        }
        if (typeof recipient !== 'string' || !recipient) {
            throw new InvalidParameterError('recipient');
        }
        const identity = await this.boundIdentity(name);
        const doc = await this.host.resolveDID(recipient);
        const recipientDid: string = doc.didDocument.id;
        const ctx = await this.context(mint, identity);

        // A mint without NUT-11 may treat locked proofs as bearer tokens, so there is
        // no falling back to an unlocked token.
        const info = await ctx.client.info();
        if (!info?.nuts?.['11']?.supported) {
            throw new CashuMintUnsupportedError(`${ctx.url} does not support NUT-11`);
        }
        await this.host.requireDidCommRoute(recipientDid, identity);
        await this.settle(ctx);

        const { keyset, keysets } = await this.activeKeyset(ctx);
        const gross = this.grossFor(amount, keyset);
        const expiry = Math.floor(Date.now() / 1000) + locktime;
        // The anchored key, as for encrypting to a DID, while the mints above come from
        // the latest document: a service just published need not be anchored yet.
        const pubkey = this.host.documentPublicKey(await this.host.resolveDID(recipientDid, { confirm: true }));
        const refundKey = await this.host.ownPublicKey(identity);
        const send = splitAmount(gross).map((part) => {
            const data = OutputData.createSingleP2PKData(
                { pubkey, locktime: expiry, refundKeys: [refundKey], sigFlag: 'SIG_INPUTS' },
                part as never,
                keyset.id,
            );
            return {
                amount: part,
                role: 'send' as const,
                secret: new TextDecoder().decode(data.secret),
                r: data.blindingFactor.toString(16).padStart(64, '0'),
            };
        });

        const id = newId();
        const messageId = newId();
        let deliveryError: string | undefined;
        const outcome = await this.journaled(id, async (wallet) => {
            const entry = await this.entryOf(wallet, ctx);
            const inputs = this.select(entry.proofs, gross, keysets);
            this.removeFromEntry(entry, inputs);
            const keep = splitAmount(sumProofs(inputs) - feeFor(inputs, keysets) - gross);
            const counters = this.reserve(wallet, keyset.id, keep.length);
            (entry.operations ??= []).push({
                id,
                kind: 'locked-send',
                inputs,
                keyset: keyset.id,
                outputs: [
                    ...send,
                    ...keep.map((part, i) => ({ amount: part, role: 'keep' as const, counter: counters[i] })),
                ],
                delivery: { recipient: recipientDid, ...(memo && { memo }), messageId, delivered: false },
                created: new Date().toISOString(),
            });
        }, async () => {
            const swapped = await this.runSwap(ctx, id);
            if (swapped === 'done') {
                deliveryError = await this.deliver(ctx, id);
            }
            return swapped;
        });
        if (outcome === 'spent') {
            throw new CashuTokenSpentError('some selected proofs were already spent; the rest were kept, so try again');
        }
        if (outcome !== 'done') {
            throw new CashuUnavailableError(`${ctx.url} has the send pending; run cashu-check`);
        }
        const op = (await this.readOp(ctx, id))!;
        return {
            token: this.encodeSent(ctx, op),
            amount,
            fee: gross - amount,
            operationId: id,
            mint: ctx.url,
            recipient: recipientDid,
            messageId,
            locktime: expiry,
            delivered: op.delivery!.delivered,
            ...(deliveryError && { error: deliveryError }),
        };
    }

    private encodeSent(ctx: MintContext, op: CashuOperation): string {
        const proofs = op.sent!.map(({ witness: _witness, ...proof }) => proof);
        return getEncodedToken({ mint: ctx.url, unit: UNIT, proofs: proofs as never });
    }

    // Sends a locked token not yet delivered, with the same message id each time,
    // which the recipient deduplicates. A failure leaves it for the next check, and
    // says why.
    private async deliver(ctx: MintContext, id: string): Promise<string | undefined> {
        const op = await this.readOp(ctx, id);
        if (!op?.delivery || op.delivery.delivered || !op.sent) {
            return undefined;
        }
        const { recipient, memo, messageId } = op.delivery;
        try {
            const message = cashuToken(this.encodeSent(ctx, op), { memo, id: messageId });
            await this.host.sendDidComm(message, recipient, { name: ctx.name });
        }
        catch (error: any) {
            return error?.message ?? String(error);
        }
        await this.host.mutateWallet(async (wallet) => {
            const stored = (await this.entryOf(wallet, ctx)).operations?.find(item => item.id === id);
            if (stored?.delivery) {
                stored.delivery.delivered = true;
            }
        });
        return undefined;
    }

    private async tokenMessages(name?: string): Promise<DidCommReceivedMessage[]> {
        const received = await this.host.receiveDidComm({ name, ack: false });
        return received.filter(item => isCashuTokenMessage(item.message));
    }

    private static messageSender(item: DidCommReceivedMessage): string | undefined {
        return item.metadata.authenticated ? item.metadata.sender?.split('#')[0] : undefined;
    }

    // A resend carries the same id. Keyed by sender too, so nobody can use a known
    // id to get someone else's message skipped.
    private static messageKey(item: DidCommReceivedMessage): string {
        return `${CashuWallet.messageSender(item) ?? ''}|${item.message?.id ?? item.id}`;
    }

    async listCashuMessages(name?: string): Promise<CashuMessage[]> {
        const identity = await this.boundIdentity(name);
        const idInfo = await this.host.fetchIdInfo(identity, await this.host.loadWallet());
        const mints = this.mints(idInfo);
        const result: CashuMessage[] = [];
        for (const item of await this.tokenMessages(identity)) {
            const key = CashuWallet.messageKey(item);
            const pending = Object.values(mints).some(entry => entry.operations?.some(op => op.message === key));
            if (idInfo.cashuInbox?.[key] && !pending) {
                continue;
            }
            const sender = CashuWallet.messageSender(item);
            const memo = typeof item.message?.body?.memo === 'string' ? item.message.body.memo : undefined;
            const base = { id: item.id, ...(sender && { sender }), ...(memo && { memo }) };
            try {
                const token = item.message?.body?.token;
                const metadata = getTokenMetadata(token);
                const mint = normalizeMintUrl(metadata.mint);
                if (metadata.unit && metadata.unit !== UNIT) {
                    result.push({ ...base, mint, redeemable: false, reason: `a token in ${metadata.unit}, and this wallet holds only ${UNIT}` });
                    continue;
                }
                const amount = Number(metadata.amount);
                const described = { ...base, amount, mint };
                if (pending) {
                    result.push({ ...described, redeemable: false, reason: 'its redemption is still pending at the mint' });
                    continue;
                }
                result.push(!mints[mint]
                    ? { ...described, redeemable: false, reason: `the mint ${mint} is not added` }
                    : { ...described, ...await this.redeemableBy(metadata.incompleteProofs, identity) });
            }
            catch {
                result.push({ ...base, redeemable: false, reason: 'not a valid token' });
            }
        }
        return result;
    }

    private async redeemableBy(proofs: { secret: string }[], identity: string): Promise<{ redeemable: boolean; reason?: string }> {
        const now = Math.floor(Date.now() / 1000);
        for (const { secret } of proofs) {
            const lock = p2pkLock(secret);
            if (!lock) {
                continue;
            }
            if (lock.sigAll || lock.signatures !== 1) {
                return { redeemable: false, reason: 'needs SIG_ALL or several signatures' };
            }
            const expired = lock.locktime !== undefined && lock.locktime <= now;
            if (!(expired && lock.refund.length === 0) && !await this.lockKey(lock, expired, identity)) {
                return { redeemable: false, reason: 'locked to a key this identity does not hold' };
            }
        }
        return { redeemable: true };
    }

    async receiveCashuMessages(name?: string): Promise<CashuAcceptResult> {
        const identity = await this.boundIdentity(name);
        const result: CashuAcceptResult = { redeemed: [], failed: [] };
        const acknowledge: string[] = [];
        const settled = new Set<string>();
        const settleOnce = async (ctx: MintContext) => {
            if (!settled.has(ctx.url)) {
                settled.add(ctx.url);
                await this.settle(ctx);
            }
        };

        for (const item of await this.tokenMessages(identity)) {
            const sender = CashuWallet.messageSender(item);
            const key = CashuWallet.messageKey(item);
            const token = item.message?.body?.token;
            const memo = typeof item.message?.body?.memo === 'string' ? item.message.body.memo : undefined;
            const fail = (reason: string, mint?: string, acknowledged = false) => {
                result.failed.push({ id: item.id, ...(sender && { sender }), ...(mint && { mint }), reason, acknowledged });
                if (acknowledged) {
                    acknowledge.push(item.id);
                }
            };
            let mint: string | undefined;
            try {
                if (typeof token !== 'string') {
                    throw new InvalidParameterError('token');
                }
                mint = this.tokenMint(token);
                const ctx = await this.context(mint, identity);
                await settleOnce(ctx);

                // Seen before: a resend, or a redemption from an earlier call. Settling
                // above has finished it if it can be, and otherwise its record holds it.
                const idInfo = await this.host.fetchIdInfo(identity, await this.host.loadWallet());
                if (idInfo.cashuInbox?.[key]) {
                    const entry = await this.entryOf(await this.host.loadWallet(), ctx);
                    if (entry.operations?.some(op => op.message === key)) {
                        fail('still pending at the mint', mint);
                    }
                    else {
                        acknowledge.push(item.id);
                    }
                    continue;
                }

                const { amount, spent } = await this.redeem(ctx, token, key);
                result.redeemed.push({
                    id: item.id,
                    ...(sender && { sender }),
                    amount,
                    mint,
                    ...(memo && { memo }),
                    ...(spent !== undefined && { spent }),
                });
                acknowledge.push(item.id);
            }
            catch (error: any) {
                fail(error?.message ?? String(error), mint, error instanceof CashuTokenSpentError);
            }
        }

        if (acknowledge.length > 0) {
            // A failure here only repeats the messages, which are then seen before.
            await this.host.ackDidComm(acknowledge, { name: identity }).catch(() => undefined);
        }
        return result;
    }

    async checkCashu(mint?: string, name?: string): Promise<CashuCheckResult> {
        const identity = await this.boundIdentity(name);
        const entries = await this.scopedEntries(mint, identity);
        const total: CashuCheckResult = { settled: 0, open: 0 };
        let dropped = 0;
        let rotated = 0;
        for (const [url] of entries) {
            const ctx = await this.context(url, identity);
            const result = await this.settle(ctx);
            total.settled += result.settled;
            total.open += result.open;
            dropped += await this.dropSpent(ctx);
            rotated += await this.rotateKeysets(ctx);
        }
        return {
            ...total,
            ...(dropped > 0 && { dropped }),
            ...(rotated > 0 && { rotated }),
        };
    }

    // Mints retire keysets, and may eventually stop honouring them, so proofs under
    // an inactive one move to the active one while they still can. A failure leaves
    // them spendable, or a record for settlement, and the next check tries again.
    private async rotateKeysets(ctx: MintContext): Promise<number> {
        try {
            const { keyset, keysets } = await this.activeKeyset(ctx);
            const inactive = new Set(keysets.filter(item => !item.active).map(item => item.id));
            const { proofs } = await this.entryOf(await this.host.loadWallet(), ctx);
            const inputs = proofs.filter(proof => inactive.has(proof.id));
            const value = sumProofs(inputs) - feeFor(inputs, keysets);
            // Worth no more than the fee to move them, they stay where they are.
            if (value <= 0) {
                return 0;
            }
            const id = newId();
            const outcome = await this.journaled(id, async (wallet) => {
                const entry = await this.entryOf(wallet, ctx);
                this.removeFromEntry(entry, inputs);
                this.journalSwap(wallet, entry, id, 'swap', inputs, keyset.id, value);
            }, () => this.runSwap(ctx, id));
            return outcome === 'done' ? value : 0;
        }
        catch (error) {
            if (error instanceof CashuMintError || error instanceof CashuUnavailableError) {
                return 0;
            }
            throw error;
        }
    }

    // Proofs spent elsewhere, as by another copy of the wallet, otherwise stay in the
    // balance until an operation selects them and fails.
    private async dropSpent(ctx: MintContext): Promise<number> {
        const { proofs } = await this.entryOf(await this.host.loadWallet(), ctx);
        let states: Map<string, string>;
        try {
            states = await ctx.client.states(proofs.map(proof => proofY(proof.secret)));
        }
        catch (error) {
            if (error instanceof CashuMintError || error instanceof CashuUnavailableError) {
                return 0;
            }
            throw error;
        }
        const spent = proofs.filter(proof => states.get(proofY(proof.secret)) === 'SPENT');
        if (spent.length > 0) {
            await this.host.mutateWallet(async (wallet) => {
                this.removeFromEntry(await this.entryOf(wallet, ctx), spent);
            });
        }
        return sumProofs(spent);
    }

    async restoreCashu(mint?: string, name?: string): Promise<CashuRestoreResult> {
        const ctx = await this.context(mint, name);
        await this.settle(ctx);
        const totals: CashuRestoreResult = { restored: 0, amount: 0 };
        // Every keyset, inactive included: proofs minted under a rotated keyset
        // are still redeemable.
        for (const keyset of await ctx.client.keysets()) {
            const found = await this.restoreKeyset(ctx, keyset.id);
            totals.restored += found.restored;
            totals.amount += found.amount;
        }
        return totals;
    }

    private async restoreKeyset(ctx: MintContext, keysetId: string): Promise<CashuRestoreResult> {
        const { proofs, highest } = await this.scanKeyset(ctx, keysetId);
        const spendable = await this.unspent(ctx, proofs);
        const found: CashuRestoreResult = { restored: 0, amount: 0 };
        await this.host.mutateWallet(async (wallet) => {
            const state = (this.walletCounters(wallet)[keysetId] ??= { next: 0, free: [] });
            state.next = Math.max(state.next, highest + 1);
            const entry = await this.entryOf(wallet, ctx);
            const before = entry.proofs.length;
            const value = sumProofs(entry.proofs);
            this.credit(wallet, entry, await this.withoutReserved(wallet, spendable));
            found.restored = entry.proofs.length - before;
            found.amount = sumProofs(entry.proofs) - value;
        });
        return found;
    }

    async reclaimCashu(operationId: string, name?: string): Promise<CashuReclaimResult> {
        const identity = await this.boundIdentity(name);
        const entries = await this.scopedEntries(undefined, identity);
        const found = entries.find(([, entry]) => entry.operations?.some(op => op.id === operationId && op.sent));
        if (!found) {
            throw new InvalidParameterError('operationId');
        }
        const ctx = await this.context(found[0], identity);
        const { keyset, keysets } = await this.activeKeyset(ctx);

        if (this.active.has(operationId)) {
            throw new CashuUnavailableError(`send ${operationId} is being settled; try again`);
        }

        // Reserved before anything is awaited, and held through the mint request, so a
        // concurrent call or settlement cannot get in, or clear the mark by failing.
        return this.withActive(operationId, async () => {
            // A locked token is signed before the record changes: a lock still in force
            // refuses here and leaves the send outstanding.
            const held = (await this.readOp(ctx, operationId))?.sent ?? [];
            const signed = await this.signLocked(ctx, held);

            // The token becomes an ordinary swap's inputs, in one write, so the record
            // can be finished after a crash and the value never appears twice. It keeps
            // its id: a refusal puts the token back, to be reclaimed again.
            let amount = 0;
            const report: SwapReport = { redeemed: 0, recovered: 0, pending: 0, refused: 0 };
            await this.host.mutateWallet(async (wallet) => {
                const entry = await this.entryOf(wallet, ctx);
                const op = entry.operations?.find(item => item.id === operationId && item.sent);
                if (!op) {
                    throw new InvalidParameterError('operationId');
                }
                const inputs = signed;
                amount = sumProofs(inputs) - feeFor(inputs, keysets);
                const { delivery } = op;
                this.retire(entry, operationId);
                this.journalSwap(wallet, entry, operationId, 'swap', inputs, keyset.id, amount, true);
                // A refusal puts the send back as it was, still to be delivered.
                if (delivery) {
                    entry.operations![entry.operations!.length - 1].delivery = delivery;
                }
            });
            const outcome = await this.runSwap(ctx, operationId, false, report);
            if (outcome === 'spent') {
                if (report.recovered === 0 && report.pending === 0) {
                    throw new CashuTokenSpentError('the recipient already redeemed this token');
                }
                return {
                    amount: report.recovered,
                    mint: ctx.url,
                    redeemed: report.redeemed,
                    ...(report.pending > 0 && { pending: report.pending }),
                };
            }
            if (outcome !== 'done') {
                throw new CashuUnavailableError(`${ctx.url} has the reclaim pending; run cashu-check`);
            }
            return { amount, mint: ctx.url };
        });
    }
}
