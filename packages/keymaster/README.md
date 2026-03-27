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

Or use the guided installer:

```bash
curl -fsSL https://archon.technology/install | bash
```

#### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ARCHON_NODE_URL` | No | `http://localhost:4224` | Node URL for the Gatekeeper/Drawbridge entry point |
| `ARCHON_GATEKEEPER_URL` | No | - | Legacy fallback for `ARCHON_NODE_URL` |
| `ARCHON_PASSPHRASE` | Yes | - | Passphrase for wallet encryption |
| `ARCHON_WALLET_PATH` | No | `./wallet.json` | Path to wallet file |
| `ARCHON_WALLET_TYPE` | No | `json` | Wallet type (`json` or `sqlite`) |
| `ARCHON_DEFAULT_REGISTRY` | No | `hyperswarm` | Default DID registry |

#### Quick Start

```bash
# Guided install and onboarding
curl -fsSL https://archon.technology/install | bash

# Set required environment variables
export ARCHON_NODE_URL=http://localhost:4224
export ARCHON_PASSPHRASE=your-secure-passphrase

# Create a new wallet
keymaster create-wallet

# Create an identity
keymaster create-id MyBot

# List identities
keymaster list-ids
```

The installer checks for Node.js and npm before prompting, asks for:

- an ID name with no default
- a passphrase with no default
- a Node URL with default `https://archon.technology`

It then uses `ARCHON_NODE_URL` and `ARCHON_PASSPHRASE` during setup, creates the ID, and prints optional shell-profile snippets for persistence in future shells. `ARCHON_GATEKEEPER_URL` is still accepted as a legacy fallback. Persisting the passphrase is convenient but less secure because it stores the secret in plaintext.

#### Commands

| Category | Command | Description |
|----------|---------|-------------|
| Wallet | `create-wallet` | Create a new wallet (or show existing) |
| Wallet | `new-wallet` | Create a new wallet |
| Wallet | `show-wallet` | Display wallet contents |
| Wallet | `check-wallet` | Validate DIDs in wallet |
| Wallet | `fix-wallet` | Remove invalid DIDs from wallet |
| Wallet | `import-wallet <phrase>` | Create wallet from recovery phrase |
| Wallet | `show-mnemonic` | Show recovery phrase |
| Wallet | `backup-wallet-file <file>` | Backup wallet to file |
| Wallet | `restore-wallet-file <file>` | Restore wallet from file |
| Wallet | `backup-wallet-did` | Backup wallet to encrypted DID |
| Wallet | `recover-wallet-did [did]` | Recover wallet from DID |
| Wallet | `change-passphrase <new>` | Re-encrypt wallet with a new passphrase |
| Identity | `create-id <name>` | Create a new identity |
| Identity | `list-ids` | List all identities |
| Identity | `use-id <name>` | Set current identity |
| Identity | `remove-id <name>` | Delete an identity |
| Identity | `rename-id <old> <new>` | Rename an identity |
| Identity | `resolve-id` | Resolve current identity |
| Identity | `rotate-keys` | Generate new keys for current ID |
| Identity | `backup-id` | Backup current ID to registry |
| Identity | `recover-id <did>` | Recover ID from DID |
| DID | `resolve-did <did>` | Resolve a DID document |
| DID | `resolve-did-version <did> <ver>` | Resolve specific version |
| DID | `revoke-did <did>` | Permanently revoke a DID |
| Encryption | `encrypt-message <msg> <did>` | Encrypt message for recipient |
| Encryption | `encrypt-file <file> <did>` | Encrypt file for recipient |
| Encryption | `decrypt-did <did>` | Decrypt an encrypted message |
| Encryption | `decrypt-json <did>` | Decrypt encrypted JSON |
| Encryption | `sign-file <file>` | Sign a JSON file |
| Encryption | `verify-file <file>` | Verify signature in file |
| Credentials | `bind-credential <schema> <subject>` | Create bound credential |
| Credentials | `issue-credential <file>` | Issue a credential |
| Credentials | `list-issued` | List issued credentials |
| Credentials | `revoke-credential <did>` | Revoke a credential |
| Credentials | `accept-credential <did>` | Accept a credential |
| Credentials | `list-credentials` | List held credentials |
| Credentials | `get-credential <did>` | Get credential by DID |
| Credentials | `publish-credential <did>` | Publish credential existence |
| Credentials | `reveal-credential <did>` | Reveal credential publicly |
| Credentials | `unpublish-credential <did>` | Remove from manifest |
| Challenges | `create-challenge [file]` | Create a challenge |
| Challenges | `create-challenge-cc <did>` | Create challenge from credential |
| Challenges | `create-response <challenge>` | Respond to a challenge |
| Challenges | `verify-response <response>` | Verify a response |
| Aliases | `add-alias <alias> <did>` | Add alias for DID |
| Aliases | `get-alias <alias>` | Get DID by alias |
| Aliases | `remove-alias <alias>` | Remove alias |
| Aliases | `list-aliases` | List all aliases |
| Groups | `create-group <name>` | Create a group |
| Groups | `list-groups` | List owned groups |
| Groups | `get-group <did>` | Get group details |
| Groups | `add-group-member <group> <member>` | Add member to group |
| Groups | `remove-group-member <group> <member>` | Remove member |
| Groups | `test-group <group> [member]` | Test group membership |
| Schemas | `create-schema <file>` | Create schema from file |
| Schemas | `list-schemas` | List owned schemas |
| Schemas | `get-schema <did>` | Get schema by DID |
| Schemas | `create-schema-template <schema>` | Generate template |
| Assets | `create-asset` | Create empty asset |
| Assets | `create-asset-json <file>` | Create from JSON file |
| Assets | `create-asset-image <file>` | Create from image |
| Assets | `create-asset-file <file>` | Create from file |
| Assets | `get-asset <id>` | Get asset by ID |
| Assets | `update-asset-json <id> <file>` | Update with JSON |
| Assets | `update-asset-image <id> <file>` | Update with image |
| Assets | `update-asset-file <id> <file>` | Update with file |
| Assets | `transfer-asset <id> <controller>` | Transfer ownership |
| Assets | `clone-asset <id>` | Clone an asset |
| Assets | `set-property <id> <key> [value]` | Set asset property |
| Assets | `list-assets` | List owned assets |
| Polls | `create-poll-template` | Create poll template |
| Polls | `create-poll <file>` | Create poll from file |
| Polls | `view-poll <poll>` | View poll details |
| Polls | `vote-poll <poll> <vote>` | Vote in poll |
| Polls | `update-poll <ballot>` | Add ballot to poll |
| Polls | `publish-poll <poll>` | Publish results (hidden) |
| Polls | `reveal-poll <poll>` | Publish results (revealed) |
| Polls | `unpublish-poll <poll>` | Remove results |
| Vaults | `create-vault` | Create a vault |
| Vaults | `list-vault-items <id>` | List vault items |
| Vaults | `add-vault-member <id> <member>` | Add vault member |
| Vaults | `remove-vault-member <id> <member>` | Remove member |
| Vaults | `list-vault-members <id>` | List members |
| Vaults | `add-vault-item <id> <file>` | Add file to vault |
| Vaults | `remove-vault-item <id> <item>` | Remove item |
| Vaults | `get-vault-item <id> <item> <file>` | Download item |
| Lightning | `add-lightning [id]` | Create a Lightning wallet for a DID |
| Lightning | `remove-lightning [id]` | Remove Lightning wallet from a DID |
| Lightning | `lightning-balance [id]` | Check Lightning wallet balance |
| Lightning | `lightning-invoice <amount> <memo> [id]` | Create invoice to receive sats |
| Lightning | `lightning-pay <bolt11> [id]` | Pay a Lightning invoice |
| Lightning | `lightning-check <hash> [id]` | Check status of a payment |
| Lightning | `lightning-decode <bolt11>` | Decode a BOLT11 invoice |
| Lightning | `lightning-zap <recipient> <amount> [memo]` | Send sats to a DID, alias, or Lightning Address |
| Lightning | `lightning-payments [id]` | Show payment history |
| Lightning | `publish-lightning [id]` | Publish Lightning service endpoint for a DID |
| Lightning | `unpublish-lightning [id]` | Remove Lightning service endpoint from a DID |

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
