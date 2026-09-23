import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import Gatekeeper from '@didcid/gatekeeper';
import Db from '@didcid/gatekeeper/db/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import Keymaster from '@didcid/keymaster';
import Wallet from '@didcid/keymaster/wallet/json-memory';
import Cipher from '@didcid/cipher/node';
import type { Operation } from '@didcid/clients/gatekeeper-types';
import { rescanStart } from '../../services/mediators/satoshi/src/rewind.ts';
import { planScanStart } from '../../services/mediators/satoshi/src/reorg.ts';

const fixture = JSON.parse(readFileSync('tests/fixtures/chain-reorg.json', 'utf8'));
const registry = fixture.metadata.registry;
const hint = (operation: Operation) => ({ operation, registry: 'hyperswarm', time: operation.proof!.created!, ordinal: [0] });

async function setup(orphan = true) {
    const db = new Db('reorg');
    const ipfs = new MemoryClient();
    const gatekeeper = new Gatekeeper({ db, ipfs });
    const operations = [fixture.publisher, fixture.owner, fixture.target, ...fixture.successors.map((x: { op: Operation }) => x.op), fixture.batch];
    for (const op of operations) await ipfs.addJSON(op, { canonical: true });
    await gatekeeper.importBatch(operations.map(hint));
    await gatekeeper.processEvents();
    await gatekeeper.addBlock(registry, { height: 99, hash: 'canonical99', time: 1000 });
    if (orphan) await gatekeeper.addBlock(registry, { height: 100, hash: 'orphan', time: 1001 });
    return { db, ipfs, gatekeeper };
}

function mediator(name: string, gatekeeper: Gatekeeper, persisted: any) {
    const source = ts.createSourceFile(name, readFileSync(`services/mediators/${name}/src/${name}-mediator.ts`, 'utf8'), ts.ScriptTarget.Latest, true);
    const selected = ['resolveScanStart', 'isFullyProcessed', 'batchHashForDid', 'importBatch'];
    const functions = source.statements.filter(ts.isFunctionDeclaration).filter(fn => selected.includes(fn.name?.text ?? ''));
    const program = functions.map(fn => fn.getText(source)).join('\n') + '\n({ resolveScanStart, importBatch })';
    const keymaster = new Keymaster({ gatekeeper, wallet: new Wallet(), cipher: new Cipher(), passphrase: 'test' });
    return runInNewContext(ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, {
        getFinalizedHeight: async () => Number.MAX_SAFE_INTEGER,
        gatekeeper, keymaster, createHash, REGISTRY: registry, planScanStart, rescanStart,
        config: { startBlock: 1, reorgDepth: 1, confirmations: 1 },
        chain: { header: async (hash: string) => ({ confirmations: hash === 'orphan' ? -1 : 1, time: 1000 }),
            hashAt: async (height: number) => `canonical${height}`, txCount: async () => 1 },
        provider: { getBlock: async (height: number) => ({ hash: `canonical${height}`, timestamp: 1000 }) },
        loadDb: async () => persisted,
        jsonPersister: { updateDb: async (mutate: (db: any) => void) => mutate(persisted) },
        console: { log() {}, warn() {}, error() {} }, formatError: String,
        [`${name}ImportBatchDuration`]: { startTimer: () => () => {} },
        [`${name}ImportErrors`]: { inc() {} }, [`${name}Reorgs`]: { inc() {} },
        [`${name}ScanErrors`]: { inc() {} },
    });
}

it.each(['satoshi', 'zcash', 'ethereum'])('%s withdraws orphaned anchors before committing a rescan', async name => {
    const { db, ipfs, gatekeeper } = await setup();
    const item = { ...fixture.metadata.registration, did: fixture.batchDid, time: fixture.metadata.time,
        batchHash: `0x${createHash('sha256').update(fixture.batchDid).digest('hex')}` };
    const persisted = { height: 100, hash: 'orphan', txnsScanned: 1, discovered: [item] };
    const api = mediator(name, gatekeeper, persisted);
    await api.importBatch(item);
    expect((await gatekeeper.resolveDID(fixture.targetDid)).didDocumentData).toEqual(fixture.successors[1].op.doc.didDocumentData);
    const fail = jest.spyOn(gatekeeper, 'rewindRegistry').mockRejectedValueOnce(new Error('offline'));
    await expect(api.resolveScanStart(101)).rejects.toThrow('offline');
    expect(persisted.height).toBe(100);
    expect(persisted.discovered).toHaveLength(1);
    fail.mockRestore();
    expect(await api.resolveScanStart(101)).toBe(100);
    expect(persisted.discovered).toEqual([]);
    expect(persisted.height).toBe(99);
    await gatekeeper.addBlock(registry, { height: 100, hash: 'canonical100', time: 1002 });
    const fresh = (await setup(false)).gatekeeper;
    await fresh.addBlock(registry, { height: 100, hash: 'canonical100', time: 1002 });
    const expected = await fresh.resolveDID(fixture.targetDid);
    for (const current of [gatekeeper, new Gatekeeper({ db, ipfs })]) {
        const resolved = await current.resolveDID(fixture.targetDid);
        // Retrieval time belongs to this response, not the converged DID state.
        expect({ ...resolved, didResolutionMetadata: undefined })
            .toEqual({ ...expected, didResolutionMetadata: undefined });
        expect(resolved.didDocumentData).toEqual(fixture.successors[0].op.doc.didDocumentData);
        expect(resolved.didDocumentMetadata?.confirmed).toBe(false);
        expect(await current.getBlock(registry, 100)).toMatchObject({ hash: 'canonical100' });
        expect(await current.getBlock(registry, 'orphan')).toBeNull();
        expect(await current.getBlock(registry, 99)).toMatchObject({ hash: 'canonical99' });
        expect((await db.getCandidates())[fixture.targetDid].some(event => event.registry === registry)).toBe(false);
    }
    // The same signed operation may be anchored again, even at its old position.
    await api.importBatch(item);
    expect((await gatekeeper.resolveDID(fixture.targetDid)).didDocumentMetadata?.confirmed).toBe(true);
});

it('retains other anchors of an operation and other registries', async () => {
    const { gatekeeper, db } = await setup();
    for (const [chain, height] of [[registry, 90], [registry, 100], ['ZEC:testnet', 100]] as const) {
        await gatekeeper.importBatchByCids([fixture.successors[1].cid], {
            ...fixture.metadata, registry: chain, ordinal: [height, 0],
            registration: { ...fixture.metadata.registration, height },
        });
        await gatekeeper.processEvents();
    }
    await gatekeeper.rewindRegistry(registry, 100);
    expect((await gatekeeper.resolveDID(fixture.targetDid)).didDocumentMetadata?.confirmed).toBe(true);
    const receipts = (await db.getCandidates())[fixture.targetDid];
    expect(receipts.some(event => event.registry === registry && event.registration?.height === 90)).toBe(true);
    expect(receipts.some(event => event.registry === 'ZEC:testnet')).toBe(true);
    expect(receipts.some(event => event.registry === registry && event.registration?.height === 100)).toBe(false);
});

it('does not restore withdrawn receipts from stale projections after interrupted publication', async () => {
    const { gatekeeper, db, ipfs } = await setup();
    await gatekeeper.importBatchByCids([fixture.successors[1].cid], fixture.metadata);
    await gatekeeper.processEvents();
    const fail = jest.spyOn(db, 'removeBlocks').mockRejectedValueOnce(new Error('storage failure'));
    await expect(gatekeeper.rewindRegistry(registry, 100)).rejects.toThrow('storage failure');
    fail.mockRestore();
    const restarted = new Gatekeeper({ db, ipfs });
    await restarted.rewindRegistry(registry, 100);
    expect((await restarted.resolveDID(fixture.targetDid)).didDocumentData).toEqual(fixture.successors[0].op.doc.didDocumentData);
    expect((await db.getCandidates())[fixture.targetDid].some(event => event.registry === registry)).toBe(false);
});

it('replays dependent assets when a controller receipt is withdrawn', async () => {
    const vector = JSON.parse(readFileSync('tests/fixtures/chain-reorg-controller.json', 'utf8'));
    const db = new Db('controller-reorg');
    const ipfs = new MemoryClient();
    const gatekeeper = new Gatekeeper({ db, ipfs });
    for (const { operation, cid, height } of vector.entries) {
        expect(await ipfs.addJSON(operation, { canonical: true })).toBe(cid);
        if (height === 20 || height === 90) {
            await gatekeeper.importBatch([hint(operation)]);
        } else {
            await gatekeeper.importBatchByCids([cid], {
                ...fixture.metadata, time: operation.proof.created, ordinal: [height, 0],
                registration: { ...fixture.metadata.registration, height },
            });
        }
        await gatekeeper.processEvents();
    }
    expect((await gatekeeper.resolveDID(vector.targetDid)).didDocumentData).toEqual({ message: 'original' });
    await gatekeeper.rewindRegistry(registry, 100);
    expect((await gatekeeper.resolveDID(vector.targetDid)).didDocumentData).toEqual({ message: 'updated' });
});

it('searches below the configured rewind range for a surviving checkpoint', async () => {
    const result = await rescanStart(100, 1,
        async height => ({ hash: height > 95 ? `orphan${height}` : `canonical${height}` }),
        async height => `canonical${height}`);
    expect(result).toBe(96);
    expect(await rescanStart(4, 1, async () => null, async () => 'canonical')).toBe(1);
});

it('keeps the queue intact when rewind races with active event processing', async () => {
    const { gatekeeper } = await setup();
    await gatekeeper.importBatchByCids([fixture.successors[1].cid], fixture.metadata);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const original = gatekeeper.importEvents.bind(gatekeeper);
    jest.spyOn(gatekeeper, 'importEvents').mockImplementationOnce(async () => {
        entered();
        await resume;
        return original();
    });
    const processing = gatekeeper.processEvents();
    await started;
    try {
        await expect(gatekeeper.rewindRegistry(registry, 100)).rejects.toThrow('processing events');
    } finally {
        release();
        await processing;
    }
    expect((await gatekeeper.resolveDID(fixture.targetDid)).didDocumentMetadata?.confirmed).toBe(true);
    await gatekeeper.rewindRegistry(registry, 100);
    expect((await gatekeeper.resolveDID(fixture.targetDid)).didDocumentMetadata?.confirmed).toBe(false);
});

function barrier() {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    return { entered, release, started, resume };
}

it('rejects raw and CID imports throughout rewind publication', async () => {
    const { db, gatekeeper } = await setup();
    await gatekeeper.importBatchByCids([fixture.successors[1].cid], fixture.metadata);
    await gatekeeper.processEvents();
    const pause = barrier();
    const remove = db.removeBlocks.bind(db);
    jest.spyOn(db, 'removeBlocks').mockImplementationOnce(async (...args) => {
        pause.entered();
        await pause.resume;
        return remove(...args);
    });
    const rewind = gatekeeper.rewindRegistry(registry, 100);
    await pause.started;
    try {
        await expect(gatekeeper.importBatch([hint(fixture.successors[1].op)]))
            .rejects.toThrow('rewinding');
        await expect(gatekeeper.importBatchByCids([fixture.successors[1].cid], fixture.metadata))
            .rejects.toThrow('rewinding');
    } finally {
        pause.release();
        await rewind;
    }
    await gatekeeper.processEvents();
    expect((await gatekeeper.resolveDID(fixture.targetDid)).didDocumentMetadata?.confirmed).toBe(false);
    // Admission reopens for the mediator's replacement-chain imports.
    await gatekeeper.importBatchByCids([fixture.successors[1].cid], fixture.metadata);
    await gatekeeper.processEvents();
    expect((await gatekeeper.resolveDID(fixture.targetDid)).didDocumentMetadata?.confirmed).toBe(true);
});

it.each(['raw', 'CID'])('rejects rewind while a %s import is in flight', async kind => {
    const { db, gatekeeper } = await setup();
    const pause = barrier();
    if (kind === 'CID') {
        const get = db.getOperation.bind(db);
        jest.spyOn(db, 'getOperation').mockImplementationOnce(async cid => {
            pause.entered();
            await pause.resume;
            return get(cid);
        });
    } else {
        const verify = gatekeeper.verifyEvent.bind(gatekeeper);
        jest.spyOn(gatekeeper, 'verifyEvent').mockImplementationOnce(async event => {
            pause.entered();
            await pause.resume;
            return verify(event);
        });
    }
    const importing = kind === 'CID'
        ? gatekeeper.importBatchByCids([fixture.successors[1].cid], fixture.metadata)
        : gatekeeper.importBatch([{ ...fixture.metadata, ordinal: [...fixture.metadata.ordinal, 0],
            registration: { ...fixture.metadata.registration, opidx: 0 }, operation: fixture.successors[1].op }]);
    await pause.started;
    try {
        await expect(gatekeeper.rewindRegistry(registry, 100)).rejects.toThrow('importing events');
    } finally {
        pause.release();
        await importing;
    }
    await gatekeeper.rewindRegistry(registry, 100);
    await gatekeeper.processEvents();
    expect((await gatekeeper.resolveDID(fixture.targetDid)).didDocumentMetadata?.confirmed).toBe(false);
});

it('Ethereum waits for finality before recovering a demonstrated legacy reorg', async () => {
    const { db, ipfs, gatekeeper } = await setup();
    const item = { ...fixture.metadata.registration, did: fixture.batchDid, time: fixture.metadata.time,
        batchHash: `0x${createHash('sha256').update(fixture.batchDid).digest('hex')}` };
    const persisted: any = { height: 100, hash: 'orphan', txnsScanned: 1, discovered: [item] };
    const api = mediator('ethereum', gatekeeper, persisted);
    await api.importBatch(item);
    expect((await gatekeeper.resolveDID(fixture.targetDid)).didDocumentMetadata?.confirmed).toBe(true);
    await expect(api.resolveScanStart(99)).rejects.toThrow('Waiting for Ethereum finality');
    expect((await gatekeeper.resolveDID(fixture.targetDid)).didDocumentMetadata?.confirmed).toBe(true);
    expect(persisted.height).toBe(100);
    expect(await api.resolveScanStart(100)).toBe(100);
    expect(persisted).toMatchObject({ height: 99, finalizedImports: true, discovered: [] });
    for (const current of [gatekeeper, new Gatekeeper({ db, ipfs })]) {
        const resolved = await current.resolveDID(fixture.targetDid);
        expect(resolved.didDocumentMetadata?.confirmed).toBe(false);
        expect(resolved.didDocumentData).toEqual(fixture.successors[0].op.doc.didDocumentData);
    }
});
