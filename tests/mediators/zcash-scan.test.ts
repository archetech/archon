import { jest } from '@jest/globals';
import nock from 'nock';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import ZecRpcClient from '../../services/mediators/zcash/src/rpc.ts';
import { rescanStart } from '../../services/mediators/zcash/src/rewind.ts';
import { planScanStart } from '../../services/mediators/zcash/src/reorg.ts';
import { BlockVerbosity, type MediatorDb } from '../../services/mediators/zcash/src/types.ts';

const height = 3484340;
const tip = height + 2;
const did = 'did:cid:bagaaiera2zveaodz3akwumibuyshyj7u6f5hodnjruqa4c4miwdzrh6gdg3a';
const initial = (): MediatorDb => ({ height, hash: 'orphan', time: '', blockCount: height,
    blocksPending: 0, blocksScanned: 101, txnsScanned: 1000, discovered: [], registered: [] });

// Exercise the actual entrypoint functions without starting services, as in
// import-availability.test.ts; RPC decoding still goes through the real client.
function harness(db = initial()) {
    const zecClient = new ZecRpcClient({ host: 'zcash-rpc.test', port: 8232 });
    const config = { startBlock: height - 100, reorgDepth: 6 };
    const counters = { scan: 0, reorg: 0 };
    const addBlock = jest.fn(async (_height: number, _hash: string, _time: number) => {});
    const source = ts.createSourceFile('zcash.ts', readFileSync('services/mediators/zcash/src/zcash-mediator.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const required = ['resolveScanStart', 'discoveredKey', 'fetchBlock', 'observeChainTip', 'scanBlocks', 'updateGauges'];
    const functions = source.statements.filter(ts.isFunctionDeclaration).filter(fn => required.includes(fn.name?.text ?? ''));
    expect(functions).toHaveLength(required.length);
    const program = functions.map(fn => fn.getText(source)).join('\n') + '\n({ scanBlocks, updateGauges })';
    const gauges: Record<string, number> = {};
    const metrics = Object.fromEntries(['BlockHeight', 'BlockCount', 'BlocksPending', 'BlocksScanned', 'TxnsScanned',
        'DidsDiscovered', 'DidsRegistered', 'PendingTxs', 'ImportLoopRunning', 'ExportLoopRunning']
        .map(name => [`zcash${name}`, { set: (value: number) => { gauges[name] = value; } }]));
    const api = runInNewContext(ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
        zecClient, config, planScanStart, BlockVerbosity, Buffer, addBlock,
        rescanStart, gatekeeper: { rewindRegistry: async () => true, getBlock: async (_registry: string, h: number) => ({ hash: `canonical-${h}` }) }, REGISTRY: 'ZEC:mainnet',
        chain: { header: (hash: string) => zecClient.getBlockHeader(hash), hashAt: (h: number) => zecClient.getBlockHash(h),
            txCount: async () => 1 },
        loadDb: async () => structuredClone(db),
        jsonPersister: { updateDb: async (update: (value: MediatorDb) => void) => { update(db); } },
        zcashScanErrors: { inc: () => { counters.scan++; } },
        zcashReorgs: { inc: () => { counters.reorg++; } },
        console: { log() {}, warn() {}, error() {} },
        isValidDID: (value: string) => value === did, formatSyncProgress: () => '0',
        importRunning: false, exportRunning: false, ...metrics,
    }) as { scanBlocks(): Promise<void>; updateGauges(): Promise<void> };
    return { ...api, db, counters, gauges, addBlock, zecClient };
}

function rpc(reply: (method: string, params: unknown[]) => unknown) {
    return nock('http://zcash-rpc.test:8232').persist().post('/').reply(200, (_uri, body) => {
        const { method, params } = body as unknown as { method: string; params: unknown[] };
        return reply(method, params);
    });
}

function canonical(method: string, params: unknown[]): unknown {
    switch (method) {
    case 'getblockcount': return { result: tip };
    case 'getblockhash': return { result: `canonical-${params[0]}` };
    case 'getblockheader': return { result: { confirmations: 1, time: 1789482502 } };
    case 'getblock': return { result: { time: 1789482502, tx: [{ txid: `tx-${params[0]}`,
        vout: [{ scriptPubKey: { asm: `OP_RETURN ${Buffer.from(did).toString('hex')}` } }] }] } };
    default: throw new Error(`Unexpected RPC ${method}`);
    }
}

afterEach(() => { nock.cleanAll(); });

it('recovers the production orphaned checkpoint through HTTP-200 RPC decoding, scan, and restart', async () => {
    rpc((method, params) => method === 'getblockheader' && params[0] === 'orphan'
        ? { error: { code: -5, message: 'block height not in best chain' } } : canonical(method, params));
    const h = harness();
    await h.scanBlocks();
    expect(h.counters).toEqual({ scan: 0, reorg: 1 });
    expect(h.db).toMatchObject({ height: tip, hash: `canonical-${tip}`, blockCount: tip, blocksPending: 0 });
    expect(h.addBlock).toHaveBeenCalledTimes(8);
    expect(h.addBlock.mock.calls[0][0]).toBe(height - 5);
    const recovered = structuredClone(h.db);
    const restarted = harness(recovered);
    await restarted.scanBlocks();
    expect(restarted.addBlock).not.toHaveBeenCalled();
    expect(recovered).toEqual(h.db);
    // Re-reading the rewind window must not duplicate discovered operations.
    const replay = harness({ ...structuredClone(h.db), height, hash: 'orphan' });
    await replay.scanBlocks();
    expect(replay.db.discovered).toEqual(h.db.discovered);
});

it.each(['ECONNREFUSED', 'ETIMEDOUT'])('holds the checkpoint on %s while exposing fresh backlog and a scan error', async code => {
    rpc(canonical);
    const h = harness();
    // Nock's replyWithError can emit a second socket error after rejection.
    // Inject transport rejection at the client boundary; RPC-envelope decoding
    // remains covered by the HTTP-200 orphaned-checkpoint regression above.
    jest.spyOn(h.zecClient, 'getBlockHeader').mockRejectedValue(Object.assign(new Error(code), { code }));
    await h.scanBlocks();
    await h.updateGauges();
    expect(h.db).toMatchObject({ height, hash: 'orphan', blockCount: tip, blocksPending: 2 });
    expect(h.counters).toEqual({ scan: 1, reorg: 0 });
    expect(h.gauges).toMatchObject({ BlockHeight: height, BlockCount: tip, BlocksPending: 2 });
    expect(h.addBlock).not.toHaveBeenCalled();
});

it('stops at a failed block and resumes it on the next pass', async () => {
    let unavailable = true;
    rpc((method, params) => method === 'getblock' && params[0] === `canonical-${height + 1}` && unavailable
        ? { error: { code: -1, message: 'temporary read failure' } } : canonical(method, params));
    const h = harness({ ...initial(), hash: `canonical-${height}` });
    await h.scanBlocks();
    expect(h.db.height).toBe(height);
    expect(h.counters.scan).toBe(1);
    expect(h.addBlock).not.toHaveBeenCalled();
    unavailable = false;
    await h.scanBlocks();
    expect(h.db.height).toBe(tip);
    expect(h.addBlock).toHaveBeenCalledTimes(2);
});

it('counts a failed tip query without inventing a new tip or moving the checkpoint', async () => {
    rpc(() => ({ error: { code: -1, message: 'temporarily unavailable' } }));
    const h = harness();
    await h.scanBlocks();
    expect(h.db).toEqual(initial());
    expect(h.counters).toEqual({ scan: 1, reorg: 0 });
    expect(h.addBlock).not.toHaveBeenCalled();
});

it('persists a tip discovered mid-pass before the next block fails', async () => {
    let tipReads = 0;
    rpc((method, params) => {
        if (method === 'getblockcount') return { result: ++tipReads === 1 ? height + 1 : tip };
        if (method === 'getblock' && params[0] === `canonical-${tip}`) {
            return { error: { code: -1, message: 'new block temporarily unavailable' } };
        }
        return canonical(method, params);
    });
    const h = harness({ ...initial(), hash: `canonical-${height}` });
    await h.scanBlocks();
    await h.updateGauges();
    expect(h.db).toMatchObject({ height: height + 1, hash: `canonical-${height + 1}`,
        blockCount: tip, blocksPending: 1 });
    expect(h.gauges).toMatchObject({ BlockHeight: height + 1, BlockCount: tip, BlocksPending: 1 });
    expect(h.counters).toEqual({ scan: 1, reorg: 0 });
    expect(h.addBlock).toHaveBeenCalledTimes(1);
});
