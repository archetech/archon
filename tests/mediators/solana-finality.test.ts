import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

it.each(['processed', 'confirmed', 'finalized'])('imports only finalized evidence with configured commitment %s', async commitment => {
    const connection = {
        getSlot: jest.fn(async (_finality: string) => 200),
        getBlockHeight: jest.fn(async (_finality: string) => 100),
        getSignaturesForAddress: jest.fn(async (_address: string, _options: object, _finality: string) => [{ signature: 'sig', slot: 150 }]),
        getParsedTransaction: jest.fn(async (_signature: string, _options: object) => ({ transaction: { message: { instructions: [] } } })),
        getBlock: jest.fn(async (_slot: number, _options: object) => ({ blockhash: 'hash', blockHeight: 90, blockTime: 1000 })),
    };
    const db = { height: 0, hash: '', txnsScanned: 0 };
    const source = ts.createSourceFile('solana', readFileSync('services/mediators/solana/src/solana-mediator.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const functions = source.statements.filter(ts.isFunctionDeclaration)
        .filter(fn => ['scanSignatures', 'getSlotBlock'].includes(fn.name?.text ?? ''));
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
});
