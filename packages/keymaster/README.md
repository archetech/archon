# Archon Keymaster

Keymaster is a client library for Archon.
It manages a wallet with any number of identities.

## Installation

```bash
npm install @didcid/keymaster
```

## Usage

### Library

The library must be configured by calling the start function with 3 dependencies:
- a configured gatekeeper instance
- a wallet database
- a cipher library (@didcid/cipher/node for servers or @didcid/cipher/web for web browsers)

#### Node application

```js
// Import using subpaths
import GatekeeperClient from '@didcid/gatekeeper/client';
import WalletJson from '@didcid/keymaster/wallet/json';
import CipherNode from '@didcid/cipher/node';
import Keymaster from '@didcid/keymaster';

// Non-subpath imports
import { GatekeeperClient } from '@didcid/gatekeeper';
import Keymaster, { WalletJson } from '@didcid/keymaster';
import CipherNode from '@didcid/cipher';

const gatekeeper = new GatekeeperClient();
await gatekeeper.connect({
    url: 'http://gatekeeper-host:4224',
    waitUntilReady: true,
    intervalSeconds: 5,
    chatty: true,
});
const wallet = new WalletJson();
const cipher = new CipherNode();
const passphrase = 'SuperSecurePassphrase';
const keymaster = new Keymaster({
    gatekeeper,
    wallet,
    cipher,
    passphrase
});

const newId = await keymaster.createId('Bob');
```

#### Browser wallet

```js
// Import using subpaths
import GatekeeperClient from '@didcid/gatekeeper/client';
import WalletWeb from '@didcid/keymaster/wallet/web';
import CipherWeb from '@didcid/cipher/web';
import Keymaster from '@didcid/keymaster';

// Non-subpath imports
import { GatekeeperClient } from '@didcid/gatekeeper';
import Keymaster, { WalletWeb } from '@didcid/keymaster';
import CipherWeb from '@didcid/cipher';

const gatekeeper = new GatekeeperClient();
await gatekeeper.connect({
    url: 'http://gatekeeper-host:4224',
    waitUntilReady: true,
    intervalSeconds: 5,
    chatty: true
});
const wallet = new WalletWeb();
const cipher = new CipherWeb();
const passphrase = 'SuperSecurePassphrase';
const keymaster = new Keymaster({
    gatekeeper,
    wallet,
    cipher,
    passphrase
});

const newId = await keymaster.createId('Bob');
```

### Client

The KeymasterClient is used to communicate with a keymaster REST API service.

```js
// Import using subpaths
import KeymasterClient from '@didcid/keymaster/client';

// Non-subpath imports
import { KeymasterClient } from '@didcid/keymaster';

const keymaster = new KeymasterClient();
await keymaster.connect({
    url: 'http://keymaster-host:4226',
    waitUntilReady: true,
    intervalSeconds: 5,
    chatty: true
});

const newId = await keymaster.createId('Bob');
```
