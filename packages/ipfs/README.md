# Archon IPFS

Archon utilities for integrating with IPFS.

## Installation

```bash
npm install @didcid/ipfs
```

## Usage

### basic use

```js
// Import using subpaths
import MemoryClient from '@didcid/ipfs/memory';

// Non-subpath import
import { MemoryClient } from '@didcid/ipfs';

const ipfs = new MemoryClient();

await ipfs.start();

const data = { data: 'whatever' };
const cid = await ipfs.addJSON(data);
const retrieve = await ipfs.getJSON(cid); // retrieve == data

await ipfs.stop();
```

`MemoryClient` keeps blocks in a `Map`, for tests and for anything that wants
content addressing without a node. It addresses JSON exactly as `KuboClient`
does, so a DID minted against it is the DID a node would mint for the same
operation. Text and binary are stored whole, where a node chunks them through
unixfs and arrives at a different CID. `stop()` discards everything.

For a real node, use `KuboClient` against a kubo daemon:

```js
import KuboClient from '@didcid/ipfs/kubo';

const ipfs = await KuboClient.create({ url: 'http://localhost:5001' });
```
