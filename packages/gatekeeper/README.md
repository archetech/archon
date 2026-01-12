# Archon Gatekeeper

Gatekeeper is a node library for Archon.
It manages a local database of DIDs on the Archon network.
Gatekeeper functions are used to Create, Read, Update, and Delete DIDs (CRUD).

## Installation

```bash
npm install @didcid/gatekeeper
```
## Usage

### Library

The library must be configured by calling the start function with one of the supported databases:
- JSON - @didcid/gatekeeper/db/json
- JSON with memory cache - @didcid/gatekeeper/db/json-cache
- sqlite - @didcid/gatekeeper/db/sqlite
- mongodb - @didcid/gatekeeper/db/mongodb
- redis - @didcid/gatekeeper/db/redis

```js
// Import using subpaths
import Gatekeeper from '@didcid/gatekeeper';
import DbRedis from '@didcid/gatekeeper/db/redis';

// Non-subpath imports
import Gatekeeper, { DbRedis } from '@didcid/gatekeeper';

const db_redis = new DbRedis('archon-test');
await db_redis.start();

const gatekeeper = new Gatekeeper({ db: db_redis });
const did = 'did:test:z3v8AuaTV5VKcT9MJoSHkSTRLpXDoqcgqiKkwGBNSV4nVzb6kLk';
const docs = await gatekeeper.resolveDID(did);
console.log(JSON.stringify(docs, null, 4));
```

### Client

The GatekeeperClient is used to communicate with a Gatekeeper REST API service.

```js
// Import using subpaths
import GatekeeperClient from '@didcid/gatekeeper/client';

// Non-subpath imports
import { GatekeeperClient } from '@didcid/gatekeeper';

// Try connecting to the gatekeeper service every second,
// and start reporting (chatty) if not connected after 5 attempts
const gatekeeper = new GatekeeperClient();
await gatekeeper.connect({
    url: 'http://gatekeeper-host:4224',
    waitUntilReady: true,
    intervalSeconds: 1,
    chatty: false,
    becomeChattyAfter: 5
});

const did = 'did:test:z3v8AuaTV5VKcT9MJoSHkSTRLpXDoqcgqiKkwGBNSV4nVzb6kLk';
const docs = await gatekeeper.resolveDID(did);
console.log(JSON.stringify(docs, null, 4));
```
