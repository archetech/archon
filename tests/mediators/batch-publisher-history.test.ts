import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import Gatekeeper from '@didcid/gatekeeper';
import Db from '@didcid/gatekeeper/db/json-memory';
import MemoryClient from '@didcid/ipfs/memory';
import type { Operation } from '@didcid/clients/gatekeeper-types';

// Shared with Rust's HTTP regression. All proofs are real Data Integrity signatures;
// the publisher's earlier rotation invalidates the batch, but not its contents.
const fixture = JSON.parse(readFileSync('tests/fixtures/batch-publisher-history.json', 'utf8'));
const hint = (operation: Operation) => ({ operation, registry: 'hyperswarm', time: operation.proof!.created!, ordinal: [0] });

function importer(name: string, gatekeeper: Gatekeeper) {
    const source = ts.createSourceFile(name, readFileSync(`services/mediators/${name}/src/${name}-mediator.ts`, 'utf8'), ts.ScriptTarget.Latest, true);
    const functions = source.statements.filter(ts.isFunctionDeclaration)
        .filter(fn => ['isFullyProcessed', 'batchHashForDid', 'importBatch'].includes(fn.name?.text ?? ''));
    const code = ts.transpileModule(functions.map(fn => fn.getText(source)).join('\n') + '\nimportBatch', {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    return runInNewContext(code, {
        gatekeeper, createHash, REGISTRY: fixture.metadata.registry,
        console: { log() {}, warn() {}, error() {} },
        formatError: (error: unknown) => String(error),
        [`${name}ImportBatchDuration`]: { startTimer: () => () => {} },
        [`${name}ImportErrors`]: { inc() {} },
    });
}

it.each(['satoshi', 'zcash', 'ethereum', 'solana'])('%s interprets batch content independently of publisher history', async name => {
    const results = [];
    for (const rotationFirst of [false, true]) {
        const db = new Db(`${name}-${rotationFirst}`);
        const ipfs = new MemoryClient();
        let gatekeeper = new Gatekeeper({ db, ipfs });
        const operations = [fixture.publisher, fixture.owner, fixture.target, ...fixture.successors.map((entry: { op: Operation }) => entry.op), fixture.batch];
        for (const operation of [...operations, fixture.rotation]) await ipfs.addJSON(operation, { canonical: true });
        await gatekeeper.importBatch(operations.map(hint));
        await gatekeeper.processEvents();
        const rotate = async () => {
            await gatekeeper.importBatch([hint(fixture.rotation)]);
            await gatekeeper.processEvents();
        };
        if (rotationFirst) await rotate();
        const anchor = async () => {
            const result = await importer(name, gatekeeper)({
                ...fixture.metadata.registration, did: fixture.batchDid, time: fixture.metadata.time,
                batchHash: `0x${createHash('sha256').update(fixture.batchDid).digest('hex')}`,
            });
            expect(result.error).toBeUndefined();
            expect(result.processed.pending).toBe(0);
        };
        await anchor();
        if (!rotationFirst) await rotate();
        for (const restart of [false, true]) {
            if (restart) {
                gatekeeper = new Gatekeeper({ db, ipfs });
                await gatekeeper.getDIDs();
                await anchor();
            }
            expect((await gatekeeper.resolveDID(fixture.batchDid, { versionSequence: 1 })).didResolutionMetadata?.error).toBe('notFound');
            const resolved = await gatekeeper.resolveDID(fixture.targetDid);
            expect(resolved.didDocumentData).toEqual(fixture.successors[1].op.doc.didDocumentData);
            expect(resolved.didDocumentMetadata?.confirmed).toBe(true);
            const receipts = (await db.getCandidates())[fixture.targetDid].filter(event => event.registry === fixture.metadata.registry);
            expect(receipts).toHaveLength(1);
            expect(receipts[0].registration?.opidx).toBe(0);
            delete resolved.didResolutionMetadata?.retrieved;
            results.push(resolved);
        }
    }
    for (const result of results) expect(result).toEqual(results[0]);
});
