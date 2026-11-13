import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import express from 'express';
import request from 'supertest';
import ts from 'typescript';

const walletRequire = createRequire(new URL('../../services/mediators/solana-wallet/package.json', import.meta.url));
const sdk = walletRequire('@solana/web3.js');
const { derivePath } = await import(walletRequire.resolve('ed25519-hd-key'));
const { mnemonicToSeedSync } = walletRequire('bip39');
const mnemonic = 'abandon '.repeat(11) + 'about';
const memoProgramId = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const registryAddress = 'BxFUuKEhYMrKYB1vDngAvN8d21zU8jGptpnUMs6kjYxr';
const walletAddress = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';

function source(service: string, file: string) {
    return ts.createSourceFile(file, readFileSync(`services/mediators/${service}/src/${file}.ts`, 'utf8'), ts.ScriptTarget.Latest, true);
}

function evaluate(code: string, globals: Record<string, unknown>) {
    return runInNewContext(ts.transpileModule(code, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText, { Buffer, ...globals });
}

function deriveKeypair() {
    const file = source('solana-wallet', 'derivation');
    const fn = file.statements.find(ts.isFunctionDeclaration)!;
    return evaluate(fn.getText(file).replace('export ', '') + '\nderiveKeypair',
        { Keypair: sdk.Keypair, mnemonicToSeedSync, derivePath });
}

it.each(['solana', 'solana-wallet'])('%s keeps deterministic registry addresses with async keys', async service => {
    const file = source(service, 'config');
    const code = file.statements.filter(node => ts.isFunctionDeclaration(node) || ts.isVariableStatement(node))
        .map(node => node.getText(file)).join('\n');
    const config = await evaluate(`(async () => { ${code}; return config; })()`, {
        ...sdk, createHash, process: { env: { ARCHON_SOL_NETWORK: 'devnet' } },
    });
    expect(config.registryAddress).toBe(registryAddress);
});

it('derives the existing wallet address and produces a usable async signer', async () => {
    const keypair = await deriveKeypair()(mnemonic, "m/44'/501'/0'/0'");
    expect(keypair.publicKey.toBase58()).toBe(walletAddress);
    const message = Buffer.from('Archon Solana v3 regression');
    const signature = await keypair.signBytes(message);
    expect(await keypair.verifySignature(signature, message)).toBe(true);
});

async function wallet() {
    const wireTransactions: string[] = [];
    const calls: { method: string; params: any[] }[] = [];
    let slot = 150;
    let transactionAvailable = false;
    let statusAvailable = true;
    let blockTime: number | null = 1700000000;
    let transactionError: unknown = null;
    const signature = '1'.repeat(64);
    const config = {
        network: 'devnet', chain: 'SOL:devnet', commitment: 'confirmed',
        memoProgramId, registryAddress, derivationPath: "m/44'/501'/0'/0'",
        rpcUrl: 'http://localhost:8899', keymasterURL: 'http://localhost:4226',
        adminApiKey: 'test-admin', port: 0, metricsPort: 0,
    };
    class Connection extends sdk.Connection {
        constructor(url: string, commitment: string) {
            super(url, {
                commitment,
                fetch: async (_url: string, options: { body: string }) => {
                    const rpc = JSON.parse(options.body);
                    calls.push(rpc);
                    let result: unknown;
                    switch (rpc.method) {
                    case 'getVersion':
                        result = { 'solana-core': '3.0.0', 'feature-set': 1 };
                        break;
                    case 'getBalance':
                        result = { context: { slot }, value: 1234567890 };
                        break;
                    case 'getSlot':
                        result = slot;
                        break;
                    case 'getLatestBlockhash':
                        result = { context: { slot }, value: { blockhash: '1'.repeat(32), lastValidBlockHeight: 200 } };
                        break;
                    case 'sendTransaction':
                        wireTransactions.push(rpc.params[0]);
                        result = signature;
                        break;
                    case 'getSignatureStatuses':
                        result = { context: { slot }, value: [statusAvailable ? {
                            slot, confirmations: null, err: transactionError, confirmationStatus: 'finalized',
                        } : null] };
                        break;
                    case 'getTransaction':
                        result = transactionAvailable ? {
                            slot, blockTime, meta: null,
                            transaction: {
                                signatures: [signature],
                                message: {
                                    accountKeys: [walletAddress], recentBlockhash: '1'.repeat(32), instructions: [],
                                    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
                                },
                            },
                        } : null;
                        break;
                    default:
                        throw new Error(`Unexpected RPC method: ${rpc.method}`);
                    }
                    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
                },
            });
        }
    }
    const apps: express.Express[] = [];
    const makeApp = Object.assign(() => {
        const app = express();
        app.listen = (() => ({ close() {} })) as any;
        apps.push(app);
        return app;
    }, express);
    const metric = { set() {}, inc() {}, observe() {} };
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const file = source('solana-wallet', 'wallet-api');
    const code = file.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(file).replace('export ', '')).join('\n');
    await evaluate(code + '\nmain()', {
        ...sdk, Connection, config, createHash,
        deriveKeypair: deriveKeypair(),
        axios: { get: async () => ({ data: { mnemonic } }) },
        express: makeApp, cors: () => (_req: unknown, _res: unknown, next: () => void) => next(),
        morgan: () => (_req: unknown, _res: unknown, next: () => void) => next(),
        process: { ...process, on() {} }, setInterval: () => ({ unref() {} }),
        logger, ARCHON_ADMIN_HEADER: 'x-archon-admin-key', ARCHON_MEMO_PREFIX: 'ARCHON_BATCH_V1:',
        timingSafeEqual: (a: Buffer, b: Buffer) => a.equals(b),
        serviceVersion: 'test', serviceCommit: 'test', register: {},
        walletVersionInfo: metric, walletSetupStatus: metric, walletBalanceConfirmed: metric,
        walletSlotHeight: metric, walletSendsTotal: metric, httpRequestsTotal: metric, httpRequestDuration: metric,
    });
    const api = request(apps[0]);
    return {
        get: (path: string) => api.get(`/api/v1/wallet/${path}`).set('X-Archon-Admin-Key', config.adminApiKey),
        post: (path: string, body: object) => api.post(`/api/v1/wallet/${path}`).set('X-Archon-Admin-Key', config.adminApiKey).send(body),
        wireTransactions, calls, signature, setSlot: (value: number) => { slot = value; },
        setTransaction: (time: number | null) => { transactionAvailable = true; statusAvailable = false; blockTime = time; },
        setError: (error: unknown) => { transactionError = error; },
    };
}

it('preserves wallet JSON contracts for bigint RPC responses', async () => {
    const h = await wallet();
    expect((await h.get('info').expect(200)).body).toMatchObject({
        address: walletAddress, balance: 1.23456789, balanceLamports: '1234567890', slot: 150,
    });
    expect((await h.get('balance').expect(200)).body).toMatchObject({ balanceLamports: '1234567890' });
    expect((await h.get(`transaction/${h.signature}`).expect(200)).body).toMatchObject({
        slot: 150, confirmations: 1, confirmationStatus: 'finalized',
    });
    h.setError({ InstructionError: [0, { Custom: 1 }] });
    expect((await h.get(`transaction/${h.signature}`).expect(200)).body.err).toEqual({
        InstructionError: [0, { Custom: 1 }],
    });
    h.setTransaction(1700000000);
    expect((await h.get(`transaction/${h.signature}`).expect(200)).body).toMatchObject({
        slot: 150, blockTime: 1700000000,
    });
    h.setTransaction(null);
    expect((await h.get(`transaction/${h.signature}`).expect(200)).body.blockTime).toBeNull();
    h.setSlot(Number.MAX_SAFE_INTEGER + 1);
    expect((await h.get('info').expect(500)).body.error).toMatch(/safe number range/);
});

it('signs and submits transfers and registry-attested memos through the real v3 SDK', async () => {
    const h = await wallet();
    await h.post('send', { to: registryAddress, amount: 0.001 }).expect(200);
    const batchDid = 'did:cid:test';
    const anchor = await h.post('anchor', { batchDid, opCount: 2 }).expect(200);
    expect(anchor.body.txid).toBe(h.signature);
    expect(h.wireTransactions).toHaveLength(2);
    const [transfer, memo] = h.wireTransactions.map(wire => sdk.Transaction.from(Buffer.from(wire, 'base64')));
    expect(await transfer.verifySignatures()).toBe(true);
    expect(await memo.verifySignatures()).toBe(true);
    expect(transfer.feePayer.toBase58()).toBe(walletAddress);
    expect(sdk.SystemInstruction.decodeTransfer(transfer.instructions[0])).toMatchObject({ lamports: 1000000n });
    expect(memo.instructions[0].programId.toBase58()).toBe(memoProgramId);
    expect(memo.instructions[0].keys).toEqual([
        { pubkey: new sdk.PublicKey(registryAddress), isSigner: true, isWritable: false },
    ]);
    expect(Buffer.from(memo.instructions[0].data).toString('utf8')).toBe(
        `ARCHON_BATCH_V1:${JSON.stringify({ batchHash: anchor.body.batchHash, batchDid, opCount: 2 })}`,
    );
    expect(h.calls.filter(call => call.method === 'sendTransaction').every(call =>
        call.params[1].preflightCommitment === 'confirmed')).toBe(true);
});
