import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Gatekeeper from '@didcid/gatekeeper';
import DbJson from '@didcid/gatekeeper/db/json.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';
type Stage = { name: string; evidence: number[]; orders: number[][]; expected: number[]; components: object | null; deactivated: boolean };
type Vector = { legacy: boolean; mode: string; did: string; ids: string[]; events: GatekeeperEvent[]; stages: Stage[]; transitions: string[];
    blocks: { registry: string; block: { height: number; hash: string; time: number } }[] };
const vectors: Vector[] = JSON.parse(readFileSync('tests/convergence/asset-vectors.json', 'utf8'));
for (const vector of vectors) {
    it.each([...vector.stages.map(stage => ({ name: stage.name, stages: [stage] })),
        { name: 'late-controller-recovery', stages: vector.transitions.map(name => vector.stages.find(stage => stage.name === name)!) }])(
        `reconciles assets ($name, ${vector.mode}, legacy=${vector.legacy})`, async ({ stages }) => {
            for (let order = 0; order < 3; order++) {
                const folder = mkdtempSync(join(tmpdir(), 'archon-asset-'));
                let db = new DbJson('asset', folder);
                const ipfs = new MemoryClient();
                let gatekeeper = new Gatekeeper({ db, ipfs });
                await db.start();
                try {
                    for (const { registry, block } of vector.blocks) await gatekeeper.addBlock(registry, block);
                    for (const stage of stages) {
                        for (const index of stage.orders[order]) {
                            await gatekeeper.importBatch([structuredClone(vector.events[index])]);
                            await gatekeeper.processEvents();
                        }
                        for (const phase of ['initial', 'repeat', 'restart']) {
                            if (phase === 'repeat') {
                                await gatekeeper.importBatch(stage.orders[order].slice().reverse().map(i => structuredClone(vector.events[i])));
                                await gatekeeper.processEvents();
                            }
                            if (phase === 'restart') {
                                await db.stop(); db = new DbJson('asset', folder); await db.start();
                                gatekeeper = new Gatekeeper({ db, ipfs });
                            }
                            const resolved = await gatekeeper.resolveDID(vector.did, { verify: true });
                            const history = await db.getEvents(vector.did);
                            expect(history.map(e => e.opid)).toEqual(stage.expected.map(i => vector.ids[i]));
                            if (stage.components) {
                                expect({ didDocument: resolved.didDocument, didDocumentData: resolved.didDocumentData,
                                    didDocumentRegistration: resolved.didDocumentRegistration }).toEqual(stage.components);
                                expect(!!resolved.didDocumentMetadata?.deactivated).toBe(stage.deactivated);
                            } else expect(resolved.didResolutionMetadata?.error).toBe('notFound');
                            const candidates = (await db.getCandidates())[vector.did] ?? [];
                            for (const index of stage.evidence) {
                                const op = vector.events[index].operation;
                                if (op.did === vector.did || (op.type === 'create' && op.registration?.type === 'asset')) {
                                    // Rejected and deferred source operations survive actual storage reopen.
                                    expect(candidates.map(e => e.operation)).toContainEqual(op);
                                }
                            }
                        }
                    }
                } finally { await db.stop(); rmSync(folder, { recursive: true, force: true }); }
            }
        }, 120000);
}
