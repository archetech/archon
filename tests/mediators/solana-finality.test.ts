import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const { Connection } = createRequire(new URL('../../services/mediators/solana/package.json', import.meta.url))('@solana/web3.js');

it.each(['processed', 'confirmed', 'finalized'])('imports only finalized evidence with configured commitment %s', async commitment => {
    const connection = {
        getSlot: jest.fn(async (_finality: string) => 200n),
        getBlockHeight: jest.fn(async (_finality: string) => 100n),
        getSignaturesForAddress: jest.fn(async (_address: string, _options: object, _finality: string) => [{ signature: 'sig', slot: 150n }]),
        getParsedTransaction: jest.fn(async (_signature: string, _options: object) => ({ transaction: { message: { instructions: [] } } })),
        getBlock: jest.fn(async (_slot: number, _options: object) => ({ blockhash: 'hash', blockHeight: 90n, blockTime: 1000n })),
    };
    const db = { height: 0, hash: '', txnsScanned: 0 };
    const source = ts.createSourceFile('solana', readFileSync('services/mediators/solana/src/solana-mediator.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const functions = source.statements.filter(ts.isFunctionDeclaration)
        .filter(fn => ['scanSignatures', 'getSlotBlock', 'rpcNumber'].includes(fn.name?.text ?? ''));
    const program = functions.map(fn => fn.getText(source)).join('\n') + '\nscanSignatures';
    const scan = runInNewContext(ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
        connection, registryAddress: 'registry', SLOT_OVERLAP: 10,
        config: { commitment, startBlock: 1, signaturePageMax: 1, signaturePageLimit: 10 },
        loadDb: async () => db, jsonPersister: { updateDb: async (mutate: (data: typeof db) => void) => mutate(db) },
        formatSyncProgress: () => '100', console: { log() {} },
    });

    await scan();
    expect(connection.getSlot).toHaveBeenCalledWith('finalized');
    expect(connection.getBlockHeight).toHaveBeenCalledWith('finalized');
    expect(connection.getSignaturesForAddress).toHaveBeenCalledWith('registry', expect.anything(), 'finalized');
    expect(connection.getParsedTransaction).toHaveBeenCalledWith('sig', expect.objectContaining({ commitment: 'finalized' }));
    expect(connection.getBlock).toHaveBeenCalledWith(150, expect.objectContaining({ commitment: 'finalized' }));
    expect(db).toMatchObject({ height: 150, blockCount: 200, currentBlockHeight: 100, blocksPending: 50 });
    expect(() => JSON.stringify(db)).not.toThrow();
});

it('converts real v3 block metadata and produced slots without leaking bigint or losing precision', async () => {
    let height = 90;
    const connection = new Connection('http://localhost:8899', {
        fetch: async (_url: string, options: { body: string }) => {
            const rpc = JSON.parse(options.body);
            return new Response(JSON.stringify({
                jsonrpc: '2.0', id: rpc.id,
                result: rpc.method === 'getBlocks' ? [150, 151]
                    : { blockhash: '1'.repeat(32), previousBlockhash: '1'.repeat(32), parentSlot: 149, blockHeight: height, blockTime: 1000 },
            }));
        },
    });
    const source = ts.createSourceFile('solana', readFileSync('services/mediators/solana/src/solana-mediator.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const functions = source.statements.filter(ts.isFunctionDeclaration)
        .filter(fn => ['rpcNumber', 'getSlotBlock', 'getBlocksOrPause'].includes(fn.name?.text ?? ''));
    const api = runInNewContext(ts.transpileModule(
        functions.map(fn => fn.getText(source)).join('\n') + '\n({getSlotBlock, getBlocksOrPause})',
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText, { connection, isRateLimitError: () => false });
    expect(await api.getSlotBlock(150)).toEqual({ height: 90, hash: '1'.repeat(32), time: 1000 });
    expect(await api.getBlocksOrPause(150, 151, 'finalized')).toEqual([150, 151]);
    height = Number.MAX_SAFE_INTEGER + 1;
    await expect(api.getSlotBlock(150)).rejects.toThrow('safe number range');
});

it('discovers batches from parsed and base58 memo instructions through the real v3 Connection', async () => {
    const serviceRequire = createRequire(new URL('../../services/mediators/solana/package.json', import.meta.url));
    const { PublicKey } = serviceRequire('@solana/web3.js');
    const bs58 = serviceRequire('bs58').default;
    const { isValidDID } = await import('@didcid/ipfs/utils');

    const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
    const REGISTRY = '95hRcJGhvVEKDDmbT4oizWLJkjfHdAmdFVLzWtE9wKys';
    const PAYER = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
    const SYSTEM = '11111111111111111111111111111111';
    const signature = '1'.repeat(64);
    const blockhash = '1'.repeat(32);
    const blockTime = 1700000000;
    const didA = 'did:cid:bagaaiera2zveaodz3akwumibuyshyj7u6f5hodnjruqa4c4miwdzrh6gdg3a';
    const didB = 'did:cid:bagaaierajtgq72olbu3uxzwo3kxnjxkvewiilqqbhsuv4wshh4vzaofvkmda';
    const memo = (did: string, fill: string, opCount: number) =>
        'ARCHON_BATCH_V1:' + JSON.stringify({ batchHash: '0x' + fill.repeat(32), batchDid: did, opCount });

    // Responses in the shape a node returns for jsonParsed requests: the memo
    // program parses to a string when the node knows it and is left as base58
    // data when it does not.
    const results: Record<string, unknown> = {
        getSlot: 200,
        getBlockHeight: 100,
        getSignaturesForAddress: [{ signature, slot: 150, err: null, memo: null, blockTime, confirmationStatus: 'finalized' }],
        getBlock: { blockhash, previousBlockhash: blockhash, parentSlot: 149, blockHeight: 90, blockTime },
        getTransaction: {
            slot: 150, blockTime, version: 'legacy',
            meta: {
                err: null, fee: 5000, preBalances: [10, 0, 0, 0], postBalances: [5, 0, 0, 0], innerInstructions: [], logMessages: [],
                preTokenBalances: [], postTokenBalances: [], rewards: [], status: { Ok: null }, computeUnitsConsumed: 100,
            },
            transaction: {
                signatures: [signature],
                message: {
                    accountKeys: [
                        { pubkey: PAYER, signer: true, writable: true, source: 'transaction' },
                        { pubkey: REGISTRY, signer: true, writable: false, source: 'transaction' },
                        { pubkey: SYSTEM, signer: false, writable: false, source: 'transaction' },
                        { pubkey: MEMO, signer: false, writable: false, source: 'transaction' },
                    ],
                    recentBlockhash: blockhash,
                    instructions: [
                        {
                            program: 'system', programId: SYSTEM, stackHeight: null,
                            parsed: { type: 'transfer', info: { source: PAYER, destination: REGISTRY, lamports: 1 } },
                        },
                        { program: 'spl-memo', programId: MEMO, parsed: memo(didA, 'ab', 2), stackHeight: null },
                        { programId: MEMO, accounts: [REGISTRY], data: bs58.encode(Buffer.from(memo(didB, 'cd', 3))), stackHeight: null },
                        { program: 'spl-memo', programId: MEMO, parsed: 'not an Archon memo', stackHeight: null },
                    ],
                },
            },
        },
    };
    const methods: string[] = [];
    const connection = new Connection('http://localhost:8899', {
        fetch: async (_url: string, options: { body: string }) => {
            const rpc = JSON.parse(options.body);
            methods.push(rpc.method);
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: results[rpc.method] }));
        },
    });

    const db = { height: 0, hash: '', time: '', txnsScanned: 0, discovered: [] as object[] };
    const blocks: object[] = [];
    const source = ts.createSourceFile('solana', readFileSync('services/mediators/solana/src/solana-mediator.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const names = ['scanSignatures', 'getSlotBlock', 'rpcNumber', 'memoFromInstruction', 'parseArchonMemo', 'discoveredKey'];
    const functions = source.statements.filter(ts.isFunctionDeclaration).filter(fn => names.includes(fn.name?.text ?? ''));
    const scan = runInNewContext(ts.transpileModule(
        functions.map(fn => fn.getText(source)).join('\n') + '\nscanSignatures',
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText, {
        connection, registryAddress: new PublicKey(REGISTRY), SLOT_OVERLAP: 10, ARCHON_MEMO_PREFIX: 'ARCHON_BATCH_V1:', REGISTRY: 'SOL:mainnet-beta',
        config: { startBlock: 1, signaturePageMax: 1, signaturePageLimit: 10, memoProgramId: MEMO },
        loadDb: async () => db, jsonPersister: { updateDb: async (mutate: (data: typeof db) => void) => mutate(db) },
        addBlock: async (height: number, hash: string, time: number) => { blocks.push({ height, hash, time }); },
        formatSyncProgress: () => '100', console: { log() {} }, isValidDID, bs58, Buffer,
    });

    await scan();

    expect(methods).toEqual(expect.arrayContaining(['getSignaturesForAddress', 'getTransaction', 'getBlock']));
    const common = { height: 90, slot: 150, time: new Date(blockTime * 1000).toISOString(), txid: signature, blockHash: blockhash };
    expect(db.discovered).toEqual([
        { ...common, index: 1, did: didA, batchHash: `0x${'ab'.repeat(32)}`, opCount: 2 },
        { ...common, index: 2, did: didB, batchHash: `0x${'cd'.repeat(32)}`, opCount: 3 },
    ]);
    expect(blocks).toEqual([{ height: 90, hash: blockhash, time: blockTime }, { height: 90, hash: blockhash, time: blockTime }]);
    expect(db).toMatchObject({ height: 150, hash: blockhash, txnsScanned: 2, blockCount: 200, currentBlockHeight: 100 });
    expect(() => JSON.stringify(db)).not.toThrow();
});
