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
