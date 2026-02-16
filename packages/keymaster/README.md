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

### CLI

The package includes a command-line interface for managing wallets and identities directly.

#### Installation

```bash
npm install -g @didcid/keymaster
```

#### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ARCHON_GATEKEEPER_URL` | No | `http://localhost:4224` | Gatekeeper service URL |
| `ARCHON_PASSPHRASE` | Yes | - | Passphrase for wallet encryption |
| `ARCHON_WALLET_PATH` | No | `./wallet.json` | Path to wallet file |
| `ARCHON_WALLET_TYPE` | No | `json` | Wallet type (`json` or `sqlite`) |
| `ARCHON_DEFAULT_REGISTRY` | No | `hyperswarm` | Default DID registry |

#### Quick Start

```bash
# Set required environment variables
export ARCHON_GATEKEEPER_URL=http://localhost:4224
export ARCHON_PASSPHRASE=your-secure-passphrase

# Create a new wallet
keymaster create-wallet

# Create an identity
keymaster create-id MyBot

# List identities
keymaster list-ids
```

#### Commands

##### Wallet Management

| Command | Description |
|---------|-------------|
| `create-wallet` | Create a new wallet (or show existing) |
| `new-wallet` | Create a new wallet |
| `show-wallet` | Display wallet contents |
| `check-wallet` | Validate DIDs in wallet |
| `fix-wallet` | Remove invalid DIDs from wallet |
| `import-wallet <phrase>` | Create wallet from recovery phrase |
| `show-mnemonic` | Show recovery phrase |
| `backup-wallet-file <file>` | Backup wallet to file |
| `restore-wallet-file <file>` | Restore wallet from file |
| `backup-wallet-did` | Backup wallet to encrypted DID |
| `recover-wallet-did [did]` | Recover wallet from DID |

##### Identity Management

| Command | Description |
|---------|-------------|
| `create-id <name>` | Create a new identity |
| `list-ids` | List all identities |
| `use-id <name>` | Set current identity |
| `remove-id <name>` | Delete an identity |
| `rename-id <old> <new>` | Rename an identity |
| `resolve-id` | Resolve current identity |
| `rotate-keys` | Generate new keys for current ID |
| `backup-id` | Backup current ID to registry |
| `recover-id <did>` | Recover ID from DID |

##### DID Operations

| Command | Description |
|---------|-------------|
| `resolve-did <did>` | Resolve a DID document |
| `resolve-did-version <did> <ver>` | Resolve specific version |
| `revoke-did <did>` | Permanently revoke a DID |

##### Encryption & Signing

| Command | Description |
|---------|-------------|
| `encrypt-message <msg> <did>` | Encrypt message for recipient |
| `encrypt-file <file> <did>` | Encrypt file for recipient |
| `decrypt-did <did>` | Decrypt an encrypted message |
| `decrypt-json <did>` | Decrypt encrypted JSON |
| `sign-file <file>` | Sign a JSON file |
| `verify-file <file>` | Verify signature in file |

##### Credentials

| Command | Description |
|---------|-------------|
| `bind-credential <schema> <subject>` | Create bound credential |
| `issue-credential <file>` | Issue a credential |
| `list-issued` | List issued credentials |
| `revoke-credential <did>` | Revoke a credential |
| `accept-credential <did>` | Accept a credential |
| `list-credentials` | List held credentials |
| `get-credential <did>` | Get credential by DID |
| `publish-credential <did>` | Publish credential existence |
| `reveal-credential <did>` | Reveal credential publicly |
| `unpublish-credential <did>` | Remove from manifest |

##### Challenges & Responses

| Command | Description |
|---------|-------------|
| `create-challenge [file]` | Create a challenge |
| `create-challenge-cc <did>` | Create challenge from credential |
| `create-response <challenge>` | Respond to a challenge |
| `verify-response <response>` | Verify a response |

##### Aliases

| Command | Description |
|---------|-------------|
| `add-alias <alias> <did>` | Add alias for DID |
| `get-alias <alias>` | Get DID by alias |
| `remove-alias <alias>` | Remove alias |
| `list-aliases` | List all aliases |

##### Groups

| Command | Description |
|---------|-------------|
| `create-group <name>` | Create a group |
| `list-groups` | List owned groups |
| `get-group <did>` | Get group details |
| `add-group-member <group> <member>` | Add member to group |
| `remove-group-member <group> <member>` | Remove member |
| `test-group <group> [member]` | Test group membership |

##### Schemas

| Command | Description |
|---------|-------------|
| `create-schema <file>` | Create schema from file |
| `list-schemas` | List owned schemas |
| `get-schema <did>` | Get schema by DID |
| `create-schema-template <schema>` | Generate template |

##### Assets

| Command | Description |
|---------|-------------|
| `create-asset` | Create empty asset |
| `create-asset-json <file>` | Create from JSON file |
| `create-asset-image <file>` | Create from image |
| `create-asset-file <file>` | Create from file |
| `get-asset <id>` | Get asset by ID |
| `update-asset-json <id> <file>` | Update with JSON |
| `update-asset-image <id> <file>` | Update with image |
| `update-asset-file <id> <file>` | Update with file |
| `transfer-asset <id> <controller>` | Transfer ownership |
| `clone-asset <id>` | Clone an asset |
| `set-property <id> <key> [value]` | Set asset property |
| `list-assets` | List owned assets |

##### Polls

| Command | Description |
|---------|-------------|
| `create-poll-template` | Create poll template |
| `create-poll <file>` | Create poll from file |
| `view-poll <poll>` | View poll details |
| `vote-poll <poll> <vote>` | Vote in poll |
| `update-poll <ballot>` | Add ballot to poll |
| `publish-poll <poll>` | Publish results (hidden) |
| `reveal-poll <poll>` | Publish results (revealed) |
| `unpublish-poll <poll>` | Remove results |

##### Vaults

| Command | Description |
|---------|-------------|
| `create-vault` | Create a vault |
| `list-vault-items <id>` | List vault items |
| `add-vault-member <id> <member>` | Add vault member |
| `remove-vault-member <id> <member>` | Remove member |
| `list-vault-members <id>` | List members |
| `add-vault-item <id> <file>` | Add file to vault |
| `remove-vault-item <id> <item>` | Remove item |
| `get-vault-item <id> <item> <file>` | Download item |

#### Command Options

Many commands support these options:

| Option | Description |
|--------|-------------|
| `-a, --alias <alias>` | Assign an alias to created DID |
| `-r, --registry <registry>` | Specify DID registry |

Example:
```bash
keymaster create-id MyBot -r hyperswarm
keymaster create-schema schema.json -a my-schema -r local
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
