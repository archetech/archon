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
import GatekeeperClient from '@didcid/clients/gatekeeper';
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

// Loading never creates. A surface that provisions -- a first run, a setup
// flow -- says so; every other caller gets WalletNotFoundError on an empty
// store, so a lost wallet is not silently replaced by a new identity.
await keymaster.loadOrCreateWallet();

const newId = await keymaster.createId('Bob');
```

#### Browser wallet

```js
// Import using subpaths
import GatekeeperClient from '@didcid/clients/gatekeeper';
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

// Loading never creates. A surface that provisions -- a first run, a setup
// flow -- says so; every other caller gets WalletNotFoundError on an empty
// store, so a lost wallet is not silently replaced by a new identity.
await keymaster.loadOrCreateWallet();

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
| `ARCHON_PASSPHRASE` | No | - | Passphrase for wallet encryption. For automation; the environment is a poor place for a secret |
| `ARCHON_PASSPHRASE_FILE` | No | `~/.archon/passphrase` | File holding the passphrase. Read if it exists, so answering the CLI's offer to save ends the asking |
| `ARCHON_WALLET_PATH` | No | `~/.archon/wallet.json` (`wallet.db` for sqlite), or `./wallet.json` if one is already there | Path to wallet file. The default follows you between directories; an explicit path is obeyed even if nothing is there |
| `ARCHON_WALLET_TYPE` | No | `json` | Wallet type (`json` or `sqlite`) |
| `ARCHON_DEFAULT_REGISTRY` | No | `hyperswarm` | Default DID registry |

`ARCHON_WALLET_PATH` is a path under either backend. A SQLite wallet written
before that was true is under `data/`, because the path was passed to the store
as a name: `./wallet.json` was kept at `data/wallet.json`. The CLI still finds
those on its own when nothing is configured. If `ARCHON_WALLET_PATH` names one
of them, it now means the path it says, and the CLI reports where the older
wallet is rather than opening it — move the file, or point the variable at it.

#### Quick Start

```bash
# Guided install and onboarding
curl -fsSL https://archon.technology/install | bash

# Point it at a node
export ARCHON_NODE_URL=http://localhost:4224

# Create a new wallet — you are asked for a passphrase once, and offered
# somewhere to keep it so later commands do not ask again
keymaster create-wallet

# Create an identity
keymaster create-id MyBot

# Back it up -- these 12 words are the only way to restore the wallet
keymaster show-mnemonic

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
| Identity | `list-registries` | List supported registries |
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
| Challenges | `verify-response <response> [-t time] [-s version]` | Verify a response, optionally as of an earlier time or response version |
| Aliases | `add-alias <alias> <did>` | Add alias for DID |
| Aliases | `get-alias <alias>` | Get DID by alias |
| Aliases | `remove-alias <alias>` | Remove alias |
| Aliases | `list-aliases` | List all aliases |
| Addresses | `list-addresses` | List all wallet addresses |
| Addresses | `get-address <domain>` | Get the current address for a domain |
| Addresses | `import-address <domain>` | Import addresses for the current ID from a domain |
| Addresses | `check-address <address>` | Check whether an address is available |
| Addresses | `add-address <address>` | Claim an address for the current ID |
| Addresses | `remove-address <address>` | Remove an address from the current ID |
| Addresses | `publish-address [address] [id]` | Publish an address for the current ID |
| Addresses | `unpublish-address [id]` | Remove the published address |
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
| Grants | `create-grant <request> [-r <registry>] [-a <alias>] [--actions <a,b>] [--expires <instant>] [--no-expiry]` | Create the grant a client app asks for with a grant request |
| Grants | `list-grants` | List the grants made by the current ID |
| Grants | `update-grant <id> [--actions <a,b>] [--all-actions] [--expires <instant>] [--no-expiry]` | Change a grant's actions or expiry |
| Grants | `revoke-grant <id>` | Revoke a grant |
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
| Lightning | `remove-lightning [id] [--force]` | Remove Lightning wallet from a DID; refused while it holds funds, or its balance can't be read. `--force` discards every wallet the DID holds |
| Lightning | `lightning-balance [id]` | Check Lightning wallet balance |
| Lightning | `lightning-invoice <amount> <memo> [id]` | Create invoice to receive sats |
| Lightning | `lightning-pay <bolt11> [id]` | Pay a Lightning invoice |
| Lightning | `lightning-check <hash> [id]` | Check status of a payment |
| Lightning | `lightning-decode <bolt11>` | Decode a BOLT11 invoice |
| Lightning | `lightning-zap <recipient> <amount> [memo]` | Send sats to a DID, alias, or Lightning Address |
| Lightning | `lightning-payments [id]` | Show payment history |
| Lightning | `publish-lightning [id]` | Publish Lightning service endpoint for a DID |
| Lightning | `unpublish-lightning [id]` | Remove Lightning service endpoint from a DID |
| Cashu | `add-cashu [id]` | Enable Cashu on the node's mint |
| Cashu | `remove-cashu [id] [--force]` | Remove every Cashu mint from a DID |
| Cashu | `add-cashu-mint <url> [id]` | Add an outside Cashu mint to a DID |
| Cashu | `remove-cashu-mint <url> [id] [--force]` | Remove one Cashu mint from a DID |
| Cashu | `list-cashu-mints [id]` | List a DID's Cashu mints |
| Cashu | `cashu-balance [id] [-m <url>]` | Show spendable, in-flight and outstanding ecash |
| Cashu | `cashu-mint <amount> [id] [--pay] [-m <url>]` | Get a mint quote for ecash, or with `--pay` also pay and claim it |
| Cashu | `cashu-claim <quoteId> [id] [-m <url>]` | Mint the ecash of a paid quote |
| Cashu | `cashu-quotes [id] [-m <url>]` | List open mint and melt quotes |
| Cashu | `cashu-melt <bolt11> [id] [-m <url>]` | Pay a Lightning invoice from ecash |
| Cashu | `cashu-send <amount> [id] [-m <url>]` | Create a token and print it |
| Cashu | `cashu-receive <token> [id]` | Redeem a token at its mint |
| Cashu | `cashu-check [id] [-m <url>]` | Settle open operations and drop spent proofs |
| Cashu | `cashu-restore [id] [-m <url>]` | Recover ecash from the wallet seed |
| Cashu | `cashu-sends [id] [-m <url>]` | List sent tokens not yet settled |
| Cashu | `cashu-reclaim <operationId> [id]` | Take back a sent token not yet redeemed, or a locked one after its locktime |
| Cashu | `cashu-send-to <recipient> <amount> [memo] [id] [--locktime <duration>] [-m <url>]` | Send ecash locked to a DID, over DIDComm |
| Cashu | `cashu-decode-request <request> [id]` | Show the amount and mints a Cashu payment request asks for |
| Cashu | `cashu-pay-request <request> [id] [--max <sats>]` | Pay a Cashu payment request, as from an HTTP 402, and print the token |
| Cashu | `cashu-messages [id]` | List token messages waiting in the DIDComm inbox |
| Cashu | `cashu-accept [id]` | Redeem the token messages in the DIDComm inbox |

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

#### Grants

A grant is what an identity lets a client application do in its name. It belongs to an app, which names it, and Keymaster knows no app: it does only what is the same for all of them.

A client asks by creating a **grant request**, an asset whose data holds one member named `<app>GrantRequest`. The grant is an asset of the granting identity whose data holds `<app>Grant`. For the app `memeplex`, for example, a request held as `memeplexGrantRequest` is answered by a grant held as `memeplexGrant`.

```jsonc
// The request, an asset the client created
{ "exampleGrantRequest": { "v": 1, "name": "Example", "registries": ["BTC:mainnet", "ETH:mainnet"], "actions": ["example:read", "example:write"] } }

// The grant, an asset of the identity that grants
{ "exampleGrant": { "v": 1, "client": "did:cid:…client", "request": "did:cid:…request", "actions": ["example:read", "example:write"] } }
```

A request has `registries`, a list of the registries the grant may be created on, and may have `actions` (a list), `expiresAt` (an RFC 3339 date-time), `name` and `v` (a number). Anything else in it is the app's. The grant's `client` is the identity that created the request, and its `request` is the request's DID; it copies `v`, `actions` and `expiresAt` when the request has them.

```bash
# Grant what the request asks for. The request is named by its DID, an alias, or a link to it
keymaster create-grant did:cid:…request
keymaster create-grant 'archon://auth?challenge=did:cid:…request'

# Grant some of the actions it lists, on a chosen registry, until a chosen date-time
keymaster create-grant did:cid:…request -r ETH:mainnet --actions example:read --expires 2027-01-31T00:00:00Z

keymaster list-grants
keymaster update-grant <id> --actions example:read      # or --all-actions to remove the list
keymaster update-grant <id> --no-expiry                 # or --expires <date-time>
keymaster revoke-grant <id>
```

`create-grant` refuses a request that is not found, is deleted, is not an asset or does not have the shape above. It refuses a request that has changed since it was created: an asset can be transferred to an identity that signed nothing, so only a request at its first version says who asks. It refuses a request the granting identity made itself, and `--actions` the request does not list.

The grant is created on a registry the request lists and the node supports: `--registry`, or the first in the request's order when none is named. `create-grant` prints the grant's DID on standard output and `Created on <registry>` on standard error, so the registry written to is stated even when none was named. The assets of an identity registered on `local` are created on `local`, so such an identity can grant only a request that lists `local`.

Keymaster applies no app's rules. Whether a grant's actions mean anything, whether its registry is one the app accepts, and whether the grant is valid, are for the app to check. A request that has the shape of one is granted.

`list-grants` prints each grant with its `app`, its `request`, and its `status`: `anchored`, or `pending` while its latest version is not anchored on its registry. An asset the node could not resolve is listed as `unresolved`.

The rules for reading a request and a grant are pure functions in `@didcid/keymaster/grant` (`grantRequestOf`, `grantIn`, `grantRequestFault`, `anchoredOn` and the rest), for a program that shows a request before anything is granted. The wallets' Auth tab uses them, and Keymaster's own commands do.

`update-grant` changes `actions` and `expiresAt` and keeps everything else the grant and its asset hold. It is refused when the grant has changed since it was read. `update-grant` and `revoke-grant` refuse a DID that is not a live grant of the current ID. On a chain registry a revocation takes effect once it is anchored.

### Client

The KeymasterClient is used to communicate with a keymaster REST API service.

```js
// Import using subpaths
import KeymasterClient from '@didcid/clients/keymaster';

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
