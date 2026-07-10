# Clean Architecture Assessment

An evaluation of the Archon codebase against the principles set out in Robert
C. Martin's *Clean Architecture: A Craftsman's Guide to Software Structure and
Design* (2017).

> **Scope.** This document assesses the *TypeScript* core (`packages/`) and the
> Express service layer (`services/`), with reference to the client apps
> (`apps/`) and the Python SDK (`python/`). All file references are relative to
> the repository root and point at the canonical implementation as of writing.
> Grades reflect adherence to Uncle Bob's principles specifically, not a
> general statement of code quality.

---

## 1. Clean Architecture in brief

Martin's thesis is that *software architecture is the art of drawing lines
(boundaries) that defer decisions and isolate volatile details from stable
business policy*. The principles tested below are:

- **The Dependency Rule** — source-code dependencies may point only *inward*.
  Inner circles know nothing about outer circles. A name declared in an outer
  circle (a framework, a database, the web) must never appear in an inner one.
- **The concentric layers** — from the centre outward: **Entities**
  (enterprise-wide business rules) → **Use Cases** (application-specific
  business rules) → **Interface Adapters** (controllers, presenters, gateways)
  → **Frameworks & Drivers** (the web, the DB, the UI, the CLI).
- **SOLID** — SRP, OCP, LSP, ISP, DIP — the principles that arrange functions
  and classes into components.
- **Component cohesion & coupling** — REP/CCP/CRP (cohesion) and
  ADP/SDP/SAP (coupling) for arranging components into a deployable system.
- **Boundaries, the Humble Object pattern, and Screaming Architecture** — the
  practical techniques that keep the layers separable and the intent legible.

The single most important architectural quality, in Martin's framing, is that
*a good architecture lets you defer decisions about frameworks, databases, and
delivery mechanisms* — they become plug-ins to the business rules rather than
the thing the business rules are built around.

---

## 2. The Archon layer map

Archon maps onto the concentric circles cleanly. The repository's physical
structure mirrors the logical layering, which is itself a good sign.

```
                    Frameworks & Drivers
        Express · MongoDB · Redis · SQLite · IPFS (Kubo/Helia)
        Commander CLI · React · Electron · Browser extension
   ┌──────────────────────────────────────────────────────────┐
   │              Interface Adapters                            │
   │  services/*/server/src/*-api.ts   (HTTP controllers)       │
   │  packages/clients/src/keymaster-client.ts   (REST gateway) │
   │  packages/clients/src/gatekeeper-client.ts                 │
   │  packages/*/src/db/*.ts           (storage gateways)       │
   │  packages/ipfs/src/{kubo,helia}-client.ts                  │
   │   ┌────────────────────────────────────────────────────┐  │
   │   │           Use Cases / Entities                      │  │
   │   │  packages/keymaster/src/keymaster.ts  (Keymaster)   │  │
   │   │  packages/gatekeeper/src/gatekeeper.ts (Gatekeeper) │  │
   │   │  packages/cipher  ·  packages/common (errors/types) │  │
   │   └────────────────────────────────────────────────────┘  │
   └──────────────────────────────────────────────────────────┘
```

| Clean Architecture layer | Archon realization |
| --- | --- |
| **Entities** (enterprise rules) | Domain types & invariants in [packages/keymaster/src/types.ts](../packages/keymaster/src/types.ts) and [packages/gatekeeper/src/types.ts](../packages/gatekeeper/src/types.ts): `WalletFile`, `IDInfo`, `VerifiableCredential`, `Operation`, `GatekeeperEvent`. Domain errors in [packages/common/src/errors.ts](../packages/common/src/errors.ts). DID-document validity and operation ordering rules live in the core. |
| **Use Cases** (application rules) | The `Keymaster` class ([packages/keymaster/src/keymaster.ts](../packages/keymaster/src/keymaster.ts)) and `Gatekeeper` class ([packages/gatekeeper/src/gatekeeper.ts](../packages/gatekeeper/src/gatekeeper.ts)) — wallet derivation, credential issuance/verification, DID create/update/resolve, event ordering. |
| **Interface Adapters** | Express routers ([services/keymaster/server/src/keymaster-api.ts](../services/keymaster/server/src/keymaster-api.ts), [services/gatekeeper/server/src/gatekeeper-api.ts](../services/gatekeeper/server/src/gatekeeper-api.ts)); REST gateways (`KeymasterClient`, `GatekeeperClient`); storage gateways in `packages/*/src/db/`; IPFS gateways. |
| **Frameworks & Drivers** | Express, MongoDB, Redis, SQLite, Kubo/Helia, Commander CLI ([packages/keymaster/src/cli.ts](../packages/keymaster/src/cli.ts)), React/Electron apps under [apps/](../apps/). |

The monorepo's package boundary reinforces this: `packages/*` is published as
versioned libraries (the stable core and its adapters), while `services/*` and
`apps/*` are deployment-specific compositions. The *business policy is the
thing being depended upon, not the thing depending.*

---

## 3. The Dependency Rule — the central test

This is the rule that makes everything else work, so it gets the closest look.
The question is simple: **does the inner core ever name an outer-circle
concept?** It does not.

### 3.1 The core imports only abstractions

[packages/keymaster/src/keymaster.ts](../packages/keymaster/src/keymaster.ts)
imports only sibling domain packages (`@didcid/gatekeeper/types`,
`@didcid/cipher/types`, `@didcid/common/errors`, `@didcid/ipfs/utils`) plus a
handful of *pure, framework-free* utility libraries (`image-size`,
`file-type`, `light-bolt11-decoder`, `multiformats`). A grep for
`express`, `mongodb`, `ioredis`, `redis`, `kubo-rpc-client`, or `helia` against
both core classes returns **nothing**. The web, the database, and the IPFS node
are invisible to the business logic.

The `Keymaster` class declares its collaborators as **interfaces**, injected
through the constructor:

```ts
// packages/keymaster/src/keymaster.ts:155-159
export default class Keymaster implements KeymasterInterface {
    private gatekeeper: GatekeeperInterface;  // abstraction
    private db: WalletBase;                    // abstraction (storage port)
    private cipher: Cipher;                    // abstraction (crypto port)
```

This is textbook **Dependency Inversion**: the high-level policy
(`Keymaster`) and the low-level detail (`WalletMongo`) both depend on the
`WalletBase` abstraction; neither depends on the other.

### 3.2 Ports are first-class

Every boundary the core crosses is expressed as an explicit interface (a
"port"):

| Port (abstraction) | Defined at | Adapters (implementations) |
| --- | --- | --- |
| `WalletBase` | [keymaster/src/types.ts:272](../packages/keymaster/src/types.ts) | `json`, `json-memory`, `mongo`, `redis`, `sqlite`, `cache`, `chrome`, `web` in [packages/keymaster/src/db/](../packages/keymaster/src/db/) |
| `GatekeeperDb` | [gatekeeper/src/types.ts:84](../packages/gatekeeper/src/types.ts) | `json`, `json-cache`, `json-memory`, `mongo`, `redis`, `sqlite` in [packages/gatekeeper/src/db/](../packages/gatekeeper/src/db/) |
| `IPFSClient` | [ipfs/src/types.ts:1](../packages/ipfs/src/types.ts) | [kubo-client.ts](../packages/ipfs/src/kubo-client.ts), [helia-client.ts](../packages/ipfs/src/helia-client.ts) |
| `Cipher` | [cipher/src/types.ts:49](../packages/cipher/src/types.ts) | `cipher-node`, `cipher-web` |
| `KeymasterInterface` | [keymaster/src/types.ts:362](../packages/keymaster/src/types.ts) | in-process `Keymaster`; REST `KeymasterClient` |
| `GatekeeperInterface` | [gatekeeper/src/types.ts:141](../packages/gatekeeper/src/types.ts) | in-process `Gatekeeper`; REST `GatekeeperClient` |

The storage adapters import the database driver; the core never does. For
example, `import { MongoClient } from 'mongodb'` appears in
[packages/keymaster/src/db/mongo.ts](../packages/keymaster/src/db/mongo.ts) —
an *outer* circle file — implementing the inner-circle `WalletBase`. The
dependency arrow points inward, exactly as required.

### 3.3 The composition root wires concretes at the edge

The decision of *which* database to use is deferred to the outermost layer —
the service's startup code, which is Martin's **Main component**:

```ts
// services/keymaster/server/src/keymaster-api.ts:7731-7768
async function initWallet() {
    let wallet: WalletBase;                          // typed to the port
    if (config.db === 'redis')        wallet = await WalletRedis.create();
    else if (config.db === 'mongodb') wallet = await WalletMongo.create();
    else if (config.db === 'sqlite')  wallet = await WalletSQLite.create();
    else                              wallet = new WalletJson();
    if (config.walletCache) wallet = new WalletCache(wallet);  // decorator
    return wallet;
}
// ...
keymaster = new Keymaster({ gatekeeper, wallet, cipher, defaultRegistry,
                            passphrase: config.keymasterPassphrase });
```

The Gatekeeper service does the same at
[gatekeeper-api.ts:106-128](../services/gatekeeper/server/src/gatekeeper-api.ts).
Concrete framework choices are resolved by configuration at process start; the
business rules are handed only interface-typed objects. **The database is a
plug-in. So is IPFS. So is the crypto backend.**

> **Verdict — Dependency Rule: A.** The single most important rule of Clean
> Architecture is honoured rigorously and consistently. The core is provably
> ignorant of frameworks, databases, transports, and UI.

---

## 4. SOLID

| Principle | Grade | Evidence |
| --- | :---: | --- |
| **S** — Single Responsibility | A− | `Keymaster` owns wallet/credential/DID policy and delegates persistence, crypto, and DID resolution to injected collaborators; each storage adapter does nothing but persist. The one smell is sheer size: [keymaster-api.ts](../services/keymaster/server/src/keymaster-api.ts) is ~7,800 lines — but it is breadth (many thin routes), not tangled responsibility. |
| **O** — Open/Closed | A | Adding a DynamoDB wallet means implementing `WalletBase` and adding one `else if` in the composition root — **zero** edits to `Keymaster`. New IPFS backends slot in behind `IPFSClient`. The `WalletCache` decorator ([db/cache.ts](../packages/keymaster/src/db/cache.ts)) extends behaviour without modifying any adapter. |
| **L** — Liskov Substitution | A | All eight `WalletBase` adapters, both `IPFSClient` adapters, and the in-process/REST pairs (`Keymaster`↔`KeymasterClient`, `Gatekeeper`↔`GatekeeperClient`) are drop-in substitutable — the substitutability is exercised in tests with in-memory adapters. |
| **I** — Interface Segregation | B | `WalletBase` (3 methods) and `IPFSClient` (6 methods) are tight and focused. `KeymasterInterface` ([types.ts:362](../packages/keymaster/src/types.ts)), however, is a ~100-method "fat" interface. Every client drags in the whole surface. A stricter reading would split it into role interfaces (`WalletManager`, `CredentialManager`, `DmailManager`, `LightningManager`, …). |
| **D** — Dependency Inversion | A | High-level modules depend on abstractions throughout; concretes are injected at the edge. The one exception is in Gatekeeper (see §7.1). |

---

## 5. Component cohesion & coupling

Archon's package layout is a good fit for Martin's component principles.

- **CCP (Common Closure)** & **REP (Reuse/Release Equivalence)** — Things that
  change together live together and are released together. Each port travels
  with its adapters inside one publishable package (`@didcid/keymaster`,
  `@didcid/gatekeeper`, `@didcid/ipfs`, `@didcid/cipher`), and Lerna gives each
  an independent version. A change to the storage contract is a single
  package's release event.
- **CRP (Common Reuse)** — `@didcid/common` (errors/utils) and `@didcid/cipher`
  are small, focused, and depended-upon by many; consumers are not forced to
  pull in unrelated machinery.
- **SDP (Stable Dependencies)** — Dependencies point toward stability:
  `services/*` (volatile, frequently redeployed) → `@didcid/keymaster` →
  `@didcid/gatekeeper`/`@didcid/cipher`/`@didcid/common` (stable). The most
  depended-upon packages are the least likely to change.
- **SAP (Stable Abstractions)** — The stable packages are also the *abstract*
  ones: the most-depended-on modules (`types.ts` files) are pure interfaces, so
  stability and abstraction rise together, avoiding both the "zone of pain"
  (stable + concrete) and the "zone of uselessness" (unstable + abstract).
- **ADP (Acyclic Dependencies)** — The graph
  `common → cipher/ipfs → gatekeeper → keymaster → services → apps` is a clean
  DAG; no cycles were observed among the packages.

---

## 6. Boundaries, Humble Objects, and "Screaming Architecture"

- **Boundary anatomy.** The `KeymasterInterface`/`GatekeeperInterface` pair is a
  genuine *architectural boundary*, not just an abstraction for testing: the
  identical interface is satisfied by an in-process object *and* a
  network-crossing client. `KeymasterClient`
  ([keymaster-client.ts:68](../packages/clients/src/keymaster-client.ts))
  implements `KeymasterInterface` by marshalling each call over HTTP, so a
  consumer (CLI, React wallet, Python SDK) is agnostic to whether the policy
  runs locally or behind a server. This is the "full-fledged boundary" Martin
  describes, with the polymorphic interface doubling as the network seam.
- **The Humble Object pattern.** The Express handlers are humble: each route
  does little more than parse the request, call one domain method, and shape the
  response/HTTP status (e.g. the wallet routes in
  [keymaster-api.ts](../services/keymaster/server/src/keymaster-api.ts)). The
  hard-to-test boundary (HTTP) is kept thin; the testable behaviour sits in the
  core. The same applies to the CLI ([cli.ts](../packages/keymaster/src/cli.ts)).
- **Screaming Architecture.** The top-level vocabulary is `keymaster`,
  `gatekeeper`, `cipher`, `did-lifecycle`, `credentials`, `registries` — the
  domain, not the framework. You cannot tell from the package names that Express
  is the web framework or that MongoDB is a storage option, which is precisely
  what Martin wants: the architecture screams *self-sovereign identity*, not
  *Express app*.
- **The Test boundary.** Because every collaborator is an injectable port, the
  core is testable without a live database, IPFS node, or network — the suite
  uses in-memory `WalletBase`/`GatekeeperDb` adapters and `nock` for the REST
  clients. Tests depend on the core through its public API and do not pin
  implementation details, avoiding the "fragile tests" problem.
- **Deferred decisions.** The acid test of the architecture: the choice of
  SQLite vs MongoDB vs Redis, Kubo vs Helia, and local vs remote execution are
  all runtime configuration, not compile-time facts. These decisions were
  successfully *deferred to the edge*.

---

## 7. Where Archon deviates

A faithful assessment names the rough edges. None of these are fatal; they are
the difference between an A and an A−.

### 7.1 Gatekeeper hard-codes its crypto adapter

`Keymaster` injects `Cipher` as an interface, but `Gatekeeper` does not. It
types the field to the **concrete** class and `new`s it directly:

```ts
// packages/gatekeeper/src/gatekeeper.ts:61, 85
private cipher: CipherNode;          // concrete, not the Cipher port
// ...
this.cipher = new CipherNode();      // constructed in-place
```

`CipherNode` is still an inner-circle detail (not a framework), so the
Dependency Rule is not *broken* — but it is an inconsistency with the otherwise
uniform constructor-injection style, it prevents substituting a browser/WebCrypto
cipher, and it slightly couples Gatekeeper to a specific implementation. **The
cheapest, highest-value fix in the codebase**: change the field to the `Cipher`
interface and accept it via `GatekeeperOptions`, matching `Keymaster`.

### 7.2 `KeymasterInterface` is a fat interface

The ~100-method `KeymasterInterface` ([types.ts:362](../packages/keymaster/src/types.ts))
violates Interface Segregation. It is understandable for a wallet-centric SDK
where most consumers want most of the surface, and splitting it is a non-trivial
churn, but role interfaces would let the browser extension or a minimal client
depend on only what it uses.

### 7.3 Configuration is read as ambient global state

Services read `process.env` through a module-level `config` object rather than
receiving configuration as an explicit parameter object threaded from `main`.
This is conventional and confined to the outer layer, so it does not cross a
boundary — but it is a small concession to convenience over the "everything is
injected from Main" ideal.

### 7.4 Use cases are not separated from the entity model

Martin distinguishes *Entities* (enterprise rules) from *Use Cases*
(application rules) as separate objects. Archon collapses both into the
`Keymaster`/`Gatekeeper` classes. For a system of this size this is a pragmatic
and common simplification (it is the difference between Clean Architecture and
its stricter cousins), but it means there is no distinct, framework-free
"interactor" object per use case — the use cases are methods on a large policy
class rather than first-class objects.

---

## 8. Scorecard

| Dimension | Grade | One-line rationale |
| --- | :---: | --- |
| The Dependency Rule | **A** | Core provably ignorant of web/DB/IPFS/UI; arrows point inward everywhere. |
| Entities / domain isolation | **A** | Pure data + invariants in `types.ts`/`errors.ts`, no I/O coupling. |
| Use Case isolation | **B+** | Framework-free, but use cases are methods on a class, not separate interactors. |
| Interface Adapters | **A−** | Thin Humble-Object controllers; the same interface spans in-process and network. |
| Frameworks as plug-ins | **A** | DB, IPFS, transport, and crypto are all deferred to runtime config. |
| SOLID | **A−** | DIP/OCP/LSP strong; ISP weak (fat interface); one DIP lapse in Gatekeeper. |
| Component cohesion/coupling | **A** | Clean DAG; stability and abstraction rise together. |
| Testability | **A** | Core fully testable via in-memory ports and `nock`. |
| **Overall** | **A−** | A genuinely clean, ports-and-adapters architecture with a few honest seams. |

---

## 9. Recommendations

In rough order of value-to-effort:

1. **Inject `Cipher` into `Gatekeeper`** (§7.1). One field-type change plus an
   `options.cipher` — restores DIP uniformity and unlocks a WebCrypto Gatekeeper.
2. **Split `KeymasterInterface` into role interfaces** (§7.2). Even a partial
   split (`WalletManager`, `CredentialManager`, `DIDManager`, `LightningManager`,
   `DmailManager`) lets thin clients depend on less. Have the full interface
   extend the roles to avoid breaking existing consumers.
3. **Document the ports.** A short `packages/*/ARCHITECTURE.md` naming each port
   and its adapters would make the (already real) boundaries explicit to new
   contributors and guard against future inward-pointing leaks.
4. **Consider a lint guard** (e.g. `eslint-plugin-boundaries` or a dependency-cruiser
   rule) that *fails the build* if anything under `packages/*/src/*.ts` (excluding
   `db/` and `*-client.ts`) imports a framework/driver. This turns the Dependency
   Rule from a convention into an enforced invariant.

---

## 10. References

- Robert C. Martin, *Clean Architecture: A Craftsman's Guide to Software
  Structure and Design*, Prentice Hall, 2017.
- Robert C. Martin, ["The Clean Architecture"](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html), Clean Coder Blog, 2012.
- [Summary of "Clean Architecture" by Robert C. Martin](https://gist.github.com/ygrenzinger/14812a56b9221c9feca0b3621518635b) (community notes).
- [Clean Architecture: A Craftsman's Guide — chapter notes](https://georgearisty.dev/posts/clean-architecture/), George Aristy.

Related Archon docs: [runtime-container-architecture.md](runtime-container-architecture.md) ·
[services/README.md](services/README.md) ·
[sidetree-archon-comparison.md](sidetree-archon-comparison.md).
