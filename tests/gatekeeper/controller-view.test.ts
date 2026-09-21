import { readFileSync } from 'node:fs';
import Gatekeeper from '@didcid/gatekeeper';
import DbMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import type { GatekeeperEvent, ResolveDIDOptions } from '@didcid/gatekeeper/types';
type Vector = { legacy: boolean; mode: string; did: string; assetDid: string; events: GatekeeperEvent[];
    controllerIds: string[]; confirmedVersions: string; assetAccepted: boolean; orders: number[][];
    blocks: { registry: string; block: { height: number; hash: string; time: number } }[] };
const vectors: Vector[] = JSON.parse(readFileSync('tests/convergence/controller-view-vectors.json', 'utf8'));
it.each(vectors)('uses confirmed controller history ($mode, legacy=$legacy)', async vector => {
    const results = [];
    for (const order of vector.orders) {
        const db = new DbMemory('controller-view');
        const ipfs = new MemoryClient();
        let gatekeeper = new Gatekeeper({ db, ipfs });
        for (const { registry, block } of vector.blocks) await gatekeeper.addBlock(registry, block);
        for (const i of order) {
            await gatekeeper.importBatch([structuredClone(vector.events[i])]);
            await gatekeeper.processEvents();
        }
        for (const phase of ['initial', 'repeat', 'restart']) {
            if (phase === 'repeat') {
                await gatekeeper.importBatch(structuredClone(vector.events.slice().reverse()));
                await gatekeeper.processEvents();
            }
            if (phase === 'restart') gatekeeper = new Gatekeeper({ db, ipfs });
            // Compare complete bounded views, including confirmation and timestamp metadata.
            const accepted = await db.getEvents(vector.did);
            for (const event of accepted) {
                for (const confirm of [false, true]) {
                    const bounds: (ResolveDIDOptions & { versionOrdinal?: { registry: string; ordinal: number[] } })[] = [
                        { versionSequence: accepted.indexOf(event) + 1, confirm },
                        { versionTime: event.time, confirm },
                    ];
                    if (event.ordinal) bounds.push({ versionTime: event.time, confirm,
                        versionOrdinal: { registry: event.registry, ordinal: event.ordinal } });
                    for (const options of bounds) {
                        const ordinary = await gatekeeper.resolveDID(vector.did, options);
                        const verified = await gatekeeper.resolveDID(vector.did, { ...options, verify: true });
                        delete ordinary.didResolutionMetadata?.retrieved;
                        delete verified.didResolutionMetadata?.retrieved;
                        expect(ordinary).toEqual(verified);
                    }
                }
            }
            const agent = await gatekeeper.resolveDID(vector.did, { verify: true });
            const confirmed = await gatekeeper.resolveDID(vector.did, { confirm: true, verify: true });
            const asset = await gatekeeper.resolveDID(vector.assetDid, { verify: true });
            expect((await db.getEvents(vector.did)).map(e => e.opid)).toEqual(vector.controllerIds);
            expect(confirmed.didDocumentMetadata?.versionSequence).toBe(vector.confirmedVersions);
            if (vector.assetAccepted) expect(asset.didDocument?.controller).toBe(vector.did);
            else expect(asset.didResolutionMetadata?.error).toBe('notFound');
            results.push({ agent: agent.didDocument, data: agent.didDocumentData,
                registration: agent.didDocumentRegistration, confirmed: confirmed.didDocument, asset: asset.didDocument });
        }
    }
    for (const result of results) expect(result).toEqual(results[0]);
}, 30000);
