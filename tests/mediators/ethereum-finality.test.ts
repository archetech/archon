import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { rescanStart } from '../../services/mediators/ethereum/src/rewind.ts';

function harness(initial: Record<string, any> = {}) {
    let finalized: number | null = 100;
    let state: any = {
        height: 90, hash: 'block90', time: '', finalizedImports: true,
        discovered: [], blocksScanned: 1, txnsScanned: 0, blockCount: 90, blocksPending: 0,
        ...initial,
    };
    const provider = {
        getBlockNumber: jest.fn(async () => 150),
        getBlock: jest.fn(async (tag: string | number): Promise<any> => {
            if (tag === 'finalized' && finalized === null) return null;
            const number = tag === 'finalized' ? finalized : tag;
            return { number, hash: `block${number}`, timestamp: 1700000000 };
        }),
        getLogs: jest.fn(async (): Promise<any[]> => []),
    };
    const gatekeeper = {
        getBlock: jest.fn(async (_registry: string, height?: number): Promise<any> =>
            ({ height: height ?? 90, hash: `block${height ?? 90}`, time: 1700000000 })),
        rewindRegistry: jest.fn(async () => true),
        addBlock: jest.fn(async () => true),
        getGenesis: jest.fn(async () => ({ didDocumentData: {} })),
    };
    const source = ts.createSourceFile('ethereum.ts',
        readFileSync('services/mediators/ethereum/src/ethereum-mediator.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const names = ['getFinalizedHeight', 'resolveScanStart', 'scanBlocks', 'syncBlocks', 'importBatch',
        'importBatches', 'retryFailedImports', 'isFullyProcessed', 'sameItem', 'updateDiscoveredItems',
        'shouldRecordBlockCheckpoint', 'addBlock', 'formatSyncProgress', 'parseArchonLog', 'discoveredKey'];
    const functions = source.statements.filter(ts.isFunctionDeclaration).filter(fn => names.includes(fn.name?.text ?? ''));
    expect(functions).toHaveLength(names.length);
    const api = runInNewContext(ts.transpileModule(
        functions.map(fn => fn.getText(source)).join('\n') +
        '\n({getFinalizedHeight, resolveScanStart, scanBlocks, syncBlocks, importBatch, importBatches, retryFailedImports})',
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
    ).outputText, {
        provider, gatekeeper, rescanStart, Number, REGISTRY: 'ETH:mainnet', CHECKPOINT_BLOCK_INTERVAL: 10,
        config: { startBlock: 90, logChunkSize: 20, contractAddress: 'registry' },
        loadDb: async () => structuredClone(state),
        jsonPersister: { updateDb: async (mutate: (db: any) => void) => { mutate(state); } },
        registryInterface: { getEvent: () => ({ topicHash: 'topic' }), parseLog: (log: any) => log.parsed },
        isValidDID: () => true,
        console: { log() {}, warn() {}, error() {} }, formatError: String,
        ethereumImportErrors: { inc() {} },
    });
    return { api, provider, gatekeeper, state: () => structuredClone(state),
        setFinalized: (height: number | null) => { finalized = height; },
        restart: () => { state = JSON.parse(JSON.stringify(state)); } };
}

it('scans only finalized logs and checkpoints, then follows advancing finality', async () => {
    const h = harness();
    h.provider.getLogs.mockResolvedValueOnce([{
        blockNumber: 95, blockHash: 'block95', index: 2, transactionHash: 'tx',
        parsed: { name: 'ArchonBatch', args: { batchDid: 'did:cid:test', batchHash: 'hash', sender: 'sender', opCount: 1 } },
    }]);
    await h.api.scanBlocks();
    expect(h.provider.getBlockNumber).not.toHaveBeenCalled();
    expect(h.provider.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 91, toBlock: 100 }));
    expect(h.gatekeeper.addBlock.mock.calls.map(call => (call as any)[1].height)).toEqual([95, 100]);
    expect(h.state()).toMatchObject({ height: 100, blockCount: 100, blocksPending: 0 });
    expect(h.state().discovered[0]).toMatchObject({ height: 95, index: 2, txid: 'tx', blockHash: 'block95' });
    h.setFinalized(110);
    await h.api.scanBlocks();
    expect(h.provider.getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: 101, toBlock: 110 }));
});

it.each(['null', 'unsupported'])('does not advance or import when finalized RPC is %s', async failure => {
    const h = harness({ finalizedImports: undefined });
    const before = h.state();
    if (failure === 'null') h.setFinalized(null);
    else h.provider.getBlock.mockRejectedValue(new Error('unsupported'));
    await expect(h.api.scanBlocks()).rejects.toThrow();
    await expect(h.api.importBatch({ height: 99 })).rejects.toThrow();
    await h.api.syncBlocks();
    expect(h.state()).toEqual(before);
    expect(h.gatekeeper.rewindRegistry).not.toHaveBeenCalled();
    expect(h.gatekeeper.addBlock).not.toHaveBeenCalled();
    expect(h.gatekeeper.getGenesis).not.toHaveBeenCalled();
});

it('bounds startup checkpoint sync by finality', async () => {
    const h = harness();
    await h.api.syncBlocks();
    expect(h.gatekeeper.addBlock.mock.calls.map(call => (call as any)[1].height)).toEqual([100]);
    expect(h.provider.getBlockNumber).not.toHaveBeenCalled();
});

it('defers persisted discoveries and failed retries above finality across restart', async () => {
    const h = harness({ discovered: [{ did: 'did:cid:new', height: 110 }, { did: 'did:cid:retry', height: 111, error: 'unavailable' }] });
    h.restart();
    await h.api.importBatches();
    await h.api.retryFailedImports();
    expect(h.gatekeeper.getGenesis).not.toHaveBeenCalled();
    h.setFinalized(111);
    await h.api.importBatches();
    await h.api.retryFailedImports();
    expect(h.gatekeeper.getGenesis.mock.calls.map(call => (call as any)[0])).toEqual(['did:cid:new', 'did:cid:retry']);
});

it('withdraws legacy receipts above finality before lowering the cursor and pruning discoveries', async () => {
    const h = harness({ finalizedImports: undefined, height: 120, hash: 'block120',
        discovered: [{ height: 99 }, { height: 110, imported: { queued: 1 } }] });
    h.gatekeeper.rewindRegistry.mockRejectedValueOnce(new Error('offline'));
    await expect(h.api.scanBlocks()).rejects.toThrow('offline');
    expect(h.state()).toMatchObject({ height: 120, finalizedImports: undefined });
    expect(h.state().discovered).toHaveLength(2);
    await h.api.scanBlocks();
    expect(h.gatekeeper.rewindRegistry).toHaveBeenLastCalledWith('ETH:mainnet', 101);
    expect(h.state()).toMatchObject({ height: 100, hash: 'block100', finalizedImports: true, discovered: [{ height: 99 }] });
    h.restart();
    await h.api.scanBlocks();
    expect(h.gatekeeper.rewindRegistry).toHaveBeenCalledTimes(2);
});

it('rewinds an orphaned legacy suffix below finality to a surviving checkpoint', async () => {
    const h = harness({ finalizedImports: undefined, height: 95, hash: 'orphan', discovered: [{ height: 95 }] });
    h.gatekeeper.getBlock.mockImplementation(async (_registry: string, height?: number) =>
        height === 90 ? { height, hash: 'block90', time: 1700000000 } : { height, hash: 'orphan', time: 1700000000 });
    await h.api.scanBlocks();
    expect(h.gatekeeper.rewindRegistry).toHaveBeenCalledWith('ETH:mainnet', 91);
    expect(h.state().discovered).toEqual([]);
    expect(h.state().height).toBe(100);
});

it('halts on a finalized-history change instead of applying ordinary reorg recovery', async () => {
    const h = harness({ hash: 'different' });
    await expect(h.api.scanBlocks()).rejects.toThrow('automatic rollback is unsupported');
    expect(h.gatekeeper.rewindRegistry).not.toHaveBeenCalled();
    expect(h.provider.getLogs).not.toHaveBeenCalled();
});

it('halts when the finalized RPC head falls behind the persisted finalized cursor', async () => {
    const h = harness({ height: 110, hash: 'block110' });
    await expect(h.api.scanBlocks()).rejects.toThrow('behind the scan cursor');
    expect(h.gatekeeper.rewindRegistry).not.toHaveBeenCalled();
});

it('records finalized backlog before a failed log fetch', async () => {
    const h = harness();
    h.provider.getLogs.mockRejectedValue(new Error('offline'));
    await expect(h.api.scanBlocks()).rejects.toThrow('offline');
    expect(h.state()).toMatchObject({ height: 90, blockCount: 100, blocksPending: 10 });
});

it('retains finalized legacy discoveries and withdraws the higher Gatekeeper suffix even with a lagging cursor', async () => {
    const h = harness({ finalizedImports: undefined, discovered: [{ height: 95, error: 'unavailable' }, { height: 110 }] });
    await h.api.scanBlocks();
    expect(h.gatekeeper.rewindRegistry).toHaveBeenCalledWith('ETH:mainnet', 101);
    expect(h.state().discovered).toEqual([{ height: 95, error: 'unavailable' }]);
});

it('updates metrics when the configured start is above finality without scanning', async () => {
    const h = harness({ height: 0, hash: '', finalizedImports: undefined });
    h.setFinalized(80);
    await h.api.scanBlocks();
    expect(h.state()).toMatchObject({ height: 0, blockCount: 80, blocksPending: 0 });
    expect(h.provider.getLogs).not.toHaveBeenCalled();
    expect(h.gatekeeper.addBlock).not.toHaveBeenCalled();
});

it('does not commit a scanned range when a finalized checkpoint is unavailable', async () => {
    const h = harness();
    const getBlock = h.provider.getBlock.getMockImplementation()!;
    h.provider.getBlock.mockImplementation(async tag => tag === 100 ? null : getBlock(tag));
    await expect(h.api.scanBlocks()).rejects.toThrow('Finalized block unavailable');
    expect(h.state().height).toBe(90);
});

it('withdraws the complete unfinalized legacy suffix even when finality is below the configured start', async () => {
    const h = harness({ finalizedImports: undefined, height: 120, hash: 'block120', discovered: [{ height: 85 }] });
    h.setFinalized(80);
    await h.api.scanBlocks();
    expect(h.gatekeeper.rewindRegistry).toHaveBeenCalledWith('ETH:mainnet', 81);
    expect(h.state()).toMatchObject({ height: 80, hash: '', finalizedImports: true, discovered: [] });
    expect(h.provider.getLogs).not.toHaveBeenCalled();
});
