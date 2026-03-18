#!/usr/bin/env node
/**
 * reanchor-opid.js <opid> [registry]
 *
 * Re-queues an operation (identified by its IPFS CID / opid) for anchoring
 * on the specified registry (default: BTC:mainnet).
 *
 * Use this to recover a DID version whose transaction was dropped from the
 * mempool before confirmation, leaving an unconfirmed gap in the version chain.
 *
 * The script connects directly to the gatekeeper DB and IPFS using the same
 * environment variables as the gatekeeper server. Run it on the same host
 * (or with the same .env) as the gatekeeper.
 *
 * Usage:
 *   node scripts/reanchor-opid.js <opid> [registry]
 *
 * Example:
 *   node scripts/reanchor-opid.js bagaaieralof6xsi4jfox3znvqyr2bksd23vkoixoqimxgrv6gr2cyvurnm5a BTC:mainnet
 */

import dotenv from 'dotenv';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonCache from '@didcid/gatekeeper/db/json-cache';
import DbRedis from '@didcid/gatekeeper/db/redis';
import DbSqlite from '@didcid/gatekeeper/db/sqlite';
import DbMongo from '@didcid/gatekeeper/db/mongo';
import KuboClient from '@didcid/ipfs/kubo';

dotenv.config();

const opid = process.argv[2];
const registry = process.argv[3] || 'BTC:mainnet';

if (!opid) {
    console.error('Usage: node scripts/reanchor-opid.js <opid> [registry]');
    process.exit(1);
}

const dbType = process.env.ARCHON_GATEKEEPER_DB || 'redis';
const dbName = process.env.ARCHON_GATEKEEPER_DB_NAME || 'archon';
const ipfsURL = process.env.ARCHON_IPFS_URL || 'http://localhost:5001/api/v0';
const didPrefix = process.env.ARCHON_GATEKEEPER_DID_PREFIX || 'did:cid';

const db = (() => {
    switch (dbType) {
    case 'sqlite':   return new DbSqlite(dbName);
    case 'mongodb':  return new DbMongo(dbName);
    case 'redis':    return new DbRedis(dbName);
    case 'json':
    case 'json-cache': return new DbJsonCache(dbName);
    default: throw new Error(`Unsupported DB type: ${dbType}`);
    }
})();

await db.start();

const ipfs = new KuboClient();
await ipfs.connect({ url: ipfsURL });

const gatekeeper = new Gatekeeper({ db, ipfs, didPrefix });

console.log(`Fetching operation ${opid} from IPFS...`);
const operation = await gatekeeper.getJSON(opid);

if (!operation) {
    console.error(`Operation not found in IPFS: ${opid}`);
    process.exit(1);
}

console.log(`Operation: ${JSON.stringify(operation, null, 2)}`);
console.log(`Queuing for registry: ${registry}`);

await gatekeeper.queueOperation(registry, operation);

const queue = await gatekeeper.getQueue(registry);
console.log(`Done. Queue length for ${registry}: ${queue.length}`);

await db.stop();
