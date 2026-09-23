import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Gatekeeper from '@didcid/gatekeeper';
import MemoryClient from '@didcid/ipfs/memory';
import DbJson from '@didcid/gatekeeper/db/json';
import DbSqlite from '@didcid/gatekeeper/db/sqlite';
import DbRedis from '@didcid/gatekeeper/db/redis';
import DbMongo from '@didcid/gatekeeper/db/mongo';
import type { GatekeeperDb, Operation } from '@didcid/gatekeeper/types';

const vector = JSON.parse(readFileSync('tests/fixtures/chain-reorg.json', 'utf8'));
const backends = ['json', 'sqlite'];
if (process.env.ARCHON_TEST_REDIS_URL) backends.push('redis');
if (process.env.ARCHON_TEST_MONGODB_URL) backends.push('mongodb');

it.each(backends)('%s removes suffix blocks and persists withdrawn receipts', async backend => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-rewind-'));
    const name = `rewind-${process.pid}`;
    const previousRedis = process.env.ARCHON_REDIS_URL;
    const previousMongo = process.env.ARCHON_MONGODB_URL;
    if (process.env.ARCHON_TEST_REDIS_URL) process.env.ARCHON_REDIS_URL = process.env.ARCHON_TEST_REDIS_URL;
    if (process.env.ARCHON_TEST_MONGODB_URL) process.env.ARCHON_MONGODB_URL = process.env.ARCHON_TEST_MONGODB_URL;
    const makeDb = (): GatekeeperDb => backend === 'redis' ? new DbRedis(name)
        : backend === 'mongodb' ? new DbMongo(name) : backend === 'sqlite' ? new DbSqlite(name, dir) : new DbJson(name, dir);
    let db = makeDb();
    const ipfs = new MemoryClient();
    try {
        await db.start();
        let g = new Gatekeeper({ db, ipfs });
        const operations = [vector.publisher, vector.owner, vector.target, ...vector.successors.map((x: { op: Operation }) => x.op)];
        for (const operation of operations) await ipfs.addJSON(operation, { canonical: true });
        await g.importBatch(operations.map((operation: Operation) => ({ operation, registry: 'hyperswarm', time: operation.proof!.created!, ordinal: [0] })));
        await g.processEvents();
        for (const [height, hash] of [[99, 'common'], [100, 'orphan-a'], [100, 'orphan-b']] as const) {
            await g.addBlock('BTC:signet', { height, hash, time: 1000 });
        }
        await g.addBlock('ZEC:testnet', { height: 100, hash: 'other-chain', time: 1000 });
        await g.importBatchByCids([vector.successors[1].cid], vector.metadata);
        await g.processEvents();
        expect((await g.resolveDID(vector.targetDid)).didDocumentMetadata?.confirmed).toBe(true);
        await g.rewindRegistry('BTC:signet', 100);
        await g.rewindRegistry('BTC:signet', 100); // Idempotent retry.
        await g.addBlock('BTC:signet', { height: 100, hash: 'replacement', time: 1001 });
        await db.stop();
        db = makeDb();
        await db.start();
        g = new Gatekeeper({ db, ipfs });
        expect((await g.resolveDID(vector.targetDid)).didDocumentData).toEqual(vector.successors[0].op.doc.didDocumentData);
        expect((await g.resolveDID(vector.targetDid)).didDocumentMetadata?.confirmed).toBe(false);
        expect(await g.getBlock('BTC:signet', 'orphan-a')).toBeNull();
        expect(await g.getBlock('BTC:signet', 'orphan-b')).toBeNull();
        expect(await g.getBlock('BTC:signet', 99)).toMatchObject({ hash: 'common' });
        expect(await g.getBlock('BTC:signet')).toMatchObject({ hash: 'replacement' });
        expect(await g.getBlock('ZEC:testnet', 100)).toMatchObject({ hash: 'other-chain' });
        await g.rewindRegistry('BTC:signet', 0);
        expect(await g.getBlock('BTC:signet')).toBeNull();
    } finally {
        await db.resetDb();
        await db.stop();
        rmSync(dir, { recursive: true, force: true });
        if (previousRedis === undefined) delete process.env.ARCHON_REDIS_URL;
        else process.env.ARCHON_REDIS_URL = previousRedis;
        if (previousMongo === undefined) delete process.env.ARCHON_MONGODB_URL;
        else process.env.ARCHON_MONGODB_URL = previousMongo;
    }
});
