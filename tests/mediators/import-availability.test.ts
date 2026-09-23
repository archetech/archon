import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { generateCID } from '@didcid/ipfs/utils';

type Item = {
    did: string; height: number; index: number; txid: string; time: string; batchHash: string;
    error?: string; imported?: { queued: number }; processed?: { pending?: number; busy?: boolean; pendingBatches?: string[] };
};
type Failure = 'batch' | 'operation' | 'processing';
const names = ['satoshi', 'zcash', 'ethereum', 'solana'] as const;
const cid = 'bagaaiera2zveaodz3akwumibuyshyj7u6f5hodnjruqa4c4miwdzrh6gdg3a';

const dids = new Map<number, string>();
beforeAll(async () => {
    for (const height of [100, 200]) {
        dids.set(height, `did:cid:${await generateCID({ batch: height })}`);
    }
});

function item(height: number): Item {
    const did = dids.get(height)!;
    return { did, height, index: 0, txid: `tx${height}`, time: '2026-09-16T00:00:00Z',
        batchHash: `0x${createHash('sha256').update(did).digest('hex')}` };
}

// These entry modules start servers/chain clients at module load. Compile their
// actual import functions with fake I/O rather than starting production services
// or copying the loop logic into the test. Missing/renamed functions fail setup.
function harness(name: typeof names[number], initial: Item[], failure: Failure) {
    let persisted = JSON.stringify({ discovered: initial });
    let available = false;
    let processingHeight = 0;
    const attempts: number[] = [];
    const applied: number[] = [];
    const logs: Record<string, any>[] = [];
    const keymaster = { resolveDID: jest.fn<() => Promise<unknown>>() };
    const gatekeeper = {
        getJSON: jest.fn(async (batchCid: string) => {
            if (!available && failure === 'batch' && batchCid === item(100).did.slice('did:cid:'.length)) throw new Error('Content unavailable');
            return { type: 'create', registration: { type: 'asset' }, data: { batch: { version: 1, ops: [cid] } } };
        }),
        importBatchByCids: jest.fn(async (_cids: string[], metadata: { ordinal: number[] }) => {
            const height = metadata.ordinal[0];
            attempts.push(height);
            processingHeight = height;
            if (!available && height === 100 && failure === 'operation') throw new Error('Operation unavailable');
            return { queued: 1, processed: 0, rejected: 0, total: 3 };
        }),
        processEvents: jest.fn(async () => {
            if (!available && processingHeight === 100 && failure === 'processing') throw new Error('Processing unavailable');
            applied.push(processingHeight);
            return { pending: 0 } as { pending?: number; busy?: boolean; pendingBatches?: string[] };
        }),
    };
    const source = ts.createSourceFile(`${name}.ts`, readFileSync(`services/mediators/${name}/src/${name}-mediator.ts`, 'utf8'), ts.ScriptTarget.Latest, true);
    const required = ['isFullyProcessed', 'sameItem', 'updateDiscoveredItems', 'importBatch', 'importBatches', 'retryFailedImports'];
    const functions = source.statements.filter(ts.isFunctionDeclaration);
    for (const requiredName of required) {
        expect(functions.some(fn => fn.name?.text === requiredName)).toBe(true);
    }
    const selected = functions.filter(fn => required.includes(fn.name?.text ?? '') || fn.name?.text === 'batchHashForDid');
    const program = selected.map(fn => fn.getText(source)).join('\n') + '\n({ importBatches, retryFailedImports })';
    const code = ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const api = runInNewContext(code, {
        keymaster, gatekeeper, createHash, REGISTRY: `${name}:test`,
        console: { log(message: string) {
            try { logs.push(JSON.parse(message)); } catch { /* Other log messages are not JSON. */ }
        }, warn() {}, error() {} },
        formatError: (error: unknown) => String(error),
        [`${name}ImportBatchDuration`]: { startTimer: () => () => {} },
        [`${name}ImportErrors`]: { inc() {} },
        loadDb: async () => JSON.parse(persisted),
        jsonPersister: { updateDb: async (update: (db: { discovered: Item[] }) => void) => {
            const db = JSON.parse(persisted);
            update(db);
            persisted = JSON.stringify(db);
        } },
    }) as { importBatches(): Promise<boolean>; retryFailedImports(): Promise<void> };
    return { ...api, attempts, applied, logs, keymaster, gatekeeper,
        snapshot: () => (JSON.parse(persisted) as { discovered: Item[] }).discovered,
        recover: () => { available = true; },
    };
}

describe.each(names)('%s unavailable batches', (name) => {
    it('finishes batches despite unrelated pending work, including after restart', async () => {
        const h = harness(name, [item(100), item(200)], 'batch');
        h.recover();
        h.gatekeeper.processEvents.mockResolvedValue({ pending: 2, pendingBatches: ['other-batch'] });
        await h.importBatches();
        for (let pass = 0; pass < 3; pass++) {
            await h.importBatches();
            await h.retryFailedImports();
        }
        expect(h.attempts).toEqual([100, 200]);
        const log = h.logs.find(record => record.did === item(100).did && record.batchImport);
        expect(log).toMatchObject({
            batchComplete: true,
            batchImport: { queued: 1, alreadySeen: 0, rejected: 0 },
            gatekeeperQueueAfterImport: 3,
            gatekeeperProcessing: { pending: 2, pendingBatches: ['other-batch'] },
        });
        expect(log).not.toHaveProperty('imported');
        expect(log).not.toHaveProperty('processed');
        const restarted = harness(name, h.snapshot(), 'batch');
        await restarted.importBatches();
        await restarted.retryFailedImports();
        expect(restarted.attempts).toEqual([]);
    });

    it('retries its own pending batch but leaves completed batches alone', async () => {
        const h = harness(name, [item(100), item(200)], 'batch');
        h.recover();
        h.gatekeeper.processEvents.mockResolvedValue({ pending: 2, pendingBatches: [item(100).did] });
        await h.importBatches();
        await h.importBatches();
        await h.retryFailedImports();
        expect(h.attempts).toEqual([100, 200, 100]);
        expect(h.logs.find(record => record.did === item(100).did && record.batchImport)?.batchComplete).toBe(false);
        h.gatekeeper.processEvents.mockResolvedValue({ pending: 1, pendingBatches: ['other-batch'] });
        await h.importBatches();
        await h.importBatches();
        expect(h.attempts).toEqual([100, 200, 100, 100]);
    });

    it.each([{ busy: true }, { pending: 2 }])('keeps busy or legacy unscoped results retryable: %j', async (result) => {
        const h = harness(name, [item(100)], 'batch');
        h.recover();
        h.gatekeeper.processEvents.mockResolvedValue(result);
        await h.importBatches();
        await h.importBatches();
        expect(h.attempts).toEqual([100, 100]);
    });

    it('repairs persisted global-stall errors in one retry', async () => {
        const h = harness(name, [{ ...item(100), error: 'No progress: 2 pending event(s) unresolved',
            imported: { queued: 0 }, processed: { pending: 2 } }], 'batch');
        h.recover();
        h.gatekeeper.processEvents.mockResolvedValue({ pending: 2, pendingBatches: [] });
        await h.retryFailedImports();
        await h.importBatches();
        await h.retryFailedImports();
        expect(h.attempts).toEqual([100]);
        expect(h.snapshot()[0].error).toBeUndefined();
    });

    it('retries incomplete CID fetches even when unrelated pending work is identified', async () => {
        const h = harness(name, [item(100)], 'batch');
        h.recover();
        h.gatekeeper.getJSON.mockResolvedValue({ type: 'create', registration: { type: 'asset' }, data: { batch: { version: 1, ops: [cid, 'missing-cid'] } } });
        h.gatekeeper.processEvents.mockResolvedValue({ pending: 2, pendingBatches: [] });
        await h.importBatches();
        expect(h.snapshot()[0].error).toMatch(/Incomplete batch: 1\/2/);
        await h.retryFailedImports();
        expect(h.attempts).toEqual([100, 100]);
        expect(h.snapshot()[0].error).toBeTruthy();
    });

    it.each(['batch', 'operation', 'processing'] as const)('continues after a %s failure and retains the gap across restart', async (failure) => {
        const first = harness(name, [item(100), item(200)], failure);
        await first.importBatches();
        expect(first.applied).toEqual([200]);
        expect(first.snapshot()[0].error).toBeTruthy();
        expect(first.snapshot()[0].processed).toBeUndefined();
        expect(first.snapshot()[1].processed).toEqual({ pending: 0 });

        const restarted = harness(name, first.snapshot(), failure);
        await restarted.importBatches();
        expect(restarted.applied).toEqual([]);
        restarted.recover();
        await restarted.retryFailedImports();
        expect(restarted.applied).toEqual([100]);
        expect(restarted.gatekeeper.importBatchByCids).toHaveBeenLastCalledWith([cid], expect.objectContaining({
            time: item(100).time,
            ordinal: [100, 0],
            registration: { height: 100, index: 0, txid: 'tx100', batch: item(100).did },
        }));
        expect(restarted.snapshot()[0].error).toBeUndefined();
        expect(restarted.snapshot()[0].processed).toEqual({ pending: 0 });
        expect(restarted.snapshot()[1]).toEqual(first.snapshot()[1]);
    });

    it('reads the ordered CID list from the batch DID genesis', async () => {
        const h = harness(name, [item(100)], 'batch');
        h.recover();
        const secondCid = await generateCID({ second: true });
        h.keymaster.resolveDID.mockRejectedValue(new Error('Invalid DID: unknown'));
        h.gatekeeper.getJSON.mockResolvedValue({ type: 'create', registration: { type: 'asset' }, data: {
            batch: { version: 1, ops: [cid, secondCid] },
        } });
        h.gatekeeper.importBatchByCids.mockResolvedValue({ queued: 2, processed: 0, rejected: 0, total: 2 });
        await h.importBatches();
        expect(h.gatekeeper.getJSON).toHaveBeenCalledWith(item(100).did.slice('did:cid:'.length));
        expect(h.keymaster.resolveDID).not.toHaveBeenCalled();
        expect(h.gatekeeper.importBatchByCids).toHaveBeenCalledWith([cid, secondCid], expect.objectContaining({
            ordinal: [100, 0],
            registration: expect.objectContaining({ batch: item(100).did }),
        }));
    });

    it('does not let a reference that stays unavailable block newly discovered batches', async () => {
        const h = harness(name, [{ ...item(100), error: 'Still unavailable' }, item(200)], 'batch');
        await h.importBatches();
        expect(h.applied).toEqual([200]);
        for (let pass = 0; pass < 3; pass++) {
            await h.retryFailedImports();
            expect(h.applied).toEqual([200]);
            expect(h.snapshot()[0].error).toBeTruthy();
            expect(h.snapshot()[0].processed).toBeUndefined();
        }
    });

    it.each(['batch', 'operation', 'processing'] as const)('continues retrying later entries after another %s failure', async (failure) => {
        const h = harness(name, [100, 200].map(height => ({ ...item(height), error: 'Previous failure' })), failure);
        await h.retryFailedImports();
        expect(h.applied).toEqual([200]);
        expect(h.snapshot()[0].error).toBeTruthy();
        expect(h.snapshot()[1].error).toBeUndefined();
        expect(h.snapshot()[1].processed).toEqual({ pending: 0 });
        h.recover();
        await h.retryFailedImports();
        expect(h.applied).toEqual([200, 100]);
    });
});
