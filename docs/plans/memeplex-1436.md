# Memeplex: delegated publishing on Archon (#1436)

Status: design. Nothing described here is implemented. This document expands the
design record in #1436 into something an implementer can work from, and records the
decisions taken so far and the questions still open.

## Summary

**Memeplex** is an open publishing protocol on Archon that covers the ground of
Twitter, Substack and arXiv: short posts, long essays and papers, and the replies,
reviews, comments and reactions around them. **Memepool** is the first client built on
it.

Two decisions shape everything else:

1. **Every published object is a DID.** A post, an essay, a paper, a reply, a review
   and a reaction are each an Archon asset. Archon's existing machinery then supplies
   permalinks, ownership, edit history, deletion, gossip and optional chain
   timestamps.
2. **Applications live outside the wallet.** The user's wallet holds the root
   identity and issues a scoped, revocable *delegation credential* to a separate
   client. The client publishes under its own agent DID, and verifiers attribute its
   objects to the user through the credential. This needs no protocol change.

## Goals

- Publishing of any length, from a one-line post to a paper, under one model.
- Responses (replies, quotes, reviews, comments, reactions) are first-class objects
  that link to what they respond to, so threads and review histories form a graph any
  node can walk.
- Authorship is verifiable by anyone, without trusting the client or an indexer.
- A client never holds the user's root key, and the user can cut a client off with
  one wallet action.
- Several independent clients can implement Memeplex; Memepool is one of them.

## Non-goals

- **No protocol change.** Gatekeeper's single-controller rule and its authorization
  model are unchanged. Delegation lives in credentials and verifier logic.
- **No private content in v1.** Objects are public plaintext. Private circles (for
  example on group vaults, as in #1044) are later work.
- **No central ranking or moderation.** Indexers and clients may rank and filter, but
  the raw graph is public and anyone can aggregate it differently (as in #937).
- **No payment rail.** Tipping can use the existing `#lightning` service entries
  (`publish-lightning`, zaps) but is not part of the protocol.

## Names

| Name | What it is |
|---|---|
| **Memeplex** | The protocol: object schemas, the delegation credential, the attribution rules, and the query conventions. |
| **Memepool** | The first client and indexer, run by the project. |
| **object** | Any Memeplex asset DID: post, article, paper, reply, review, reaction, follow list. |
| **author** | The user DID an object is attributed to. |
| **publisher** | The agent DID that controls an object: the author itself, or a delegated client. |

The name puns on the memetic *meme pool* and Bitcoin's *mempool*: objects gossip on
Hyperswarm first and can be anchored on a chain later.

## Archon primitives used

Everything below exists today; the references are to `packages/keymaster/src/keymaster.ts`
and the Gatekeeper documentation.

| Need | Primitive |
|---|---|
| Create an object | `createAsset(data, { registry, controller })`. Assets must be controlled by an agent DID. The default registry is `hyperswarm`. |
| Edit an object | `updateDID` / `mergeData`. Each update is a new version; earlier versions stay resolvable (`resolve-did-version`, `versionTime`, `versionSequence`). |
| Delete an object | `revokeDID`. Resolution reports `deactivated`, and deletion clears the document data while keeping registration metadata. |
| Anchor an object | `changeRegistry` to a chain registry (BTC, ZEC, ETH, SOL) gives the object a chain-backed timestamp. |
| Move an object | `transferAsset` to another agent DID. |
| Large content | IPFS via the Gatekeeper data API (`createFile` stores `{ cid, filename, type, bytes }`). Operations are limited to 64 Ki JSON code units in both Gatekeeper ports. |
| Delegation credential | `createSchema`, `bindCredential`, `issueCredential` (bound to its own DID, #948), `acceptCredential`, `publishCredential({ reveal: true })`, `revokeCredential`. |
| Historical checks | Resolution at `versionTime`, as used by historical `verifyResponse` (#1299). |
| Discovery | Gatekeeper `POST /api/v1/query` (`$in` match on a `didDocumentData` path) and `GET /api/v1/events` (paged event feed by time and registry). |

## Object model

Every object is an asset whose `didDocumentData` carries one `memeplex` member. Keeping
everything under one key avoids collisions with other data and gives queries a fixed
prefix.

```jsonc
{
  "memeplex": {
    "v": 1,
    "kind": "post",                 // see kinds below
    "author": "did:cid:…user",      // the attributed user
    "delegation": "did:cid:…cred",  // omitted when the author publishes directly
    "created": "2026-10-24T18:00:00Z",

    // content: inline text, or a reference for anything large
    "text": "…",
    "content": { "cid": "…", "type": "text/markdown", "bytes": 48213 },

    // links
    "replyTo": "did:cid:…",         // the object this responds to
    "root": "did:cid:…",            // the thread root, for one-query thread loading
    "quotes": ["did:cid:…"],
    "tags": ["cryptography", "did"]
  }
}
```

### Kinds

| Kind | Purpose | Required links | Notes |
|---|---|---|---|
| `post` | Short text, Twitter-like | — | Usually inline `text`. |
| `article` | Long-form essay, Substack-like | — | `title`, `summary`; body as `content` on IPFS. |
| `paper` | Scholarly work, arXiv-like | — | `title`, `abstract`, `authors` (DIDs), `content` (PDF or source), optional `supersedes` for a new revision. |
| `reply` | Comment in a thread | `replyTo`, `root` | Same fields as `post`. |
| `review` | Structured assessment | `target` | `verdict` (free text or schema-defined), optional `rating`, body. A review can itself be replied to. |
| `reaction` | Like, boost, emoji | `target` | `value`. Withdrawn by deleting it. |
| `follows` | A user's follow list | — | `follows: [DIDs]`. One per author per publisher; edited in place. |

Kinds are an open set: a client ignores kinds it does not understand. New kinds are
added by agreement, not by registry.

### Content and size

Inline `text` is for content that fits comfortably inside one operation. Anything
larger, or any binary, goes to IPFS and is referenced from `content`. Updating the
content of an article is a normal update that replaces the reference; the old
reference stays in the previous version.

### Edits, deletion and revisions

- **Edit:** an update to the object. Every version remains resolvable, so a client can
  show "edited" with the full history.
- **Delete:** `revokeDID`. Clients show a tombstone: the object existed, was deleted,
  and when.
- **Paper revisions:** an edit changes the object in place. A formally new revision of
  a paper should instead be a new `paper` object with `supersedes`, so citations of the
  earlier revision stay stable.

### Timestamps and anchoring

On `hyperswarm`, an object's time is the signed `proof.created` of its operation, which
the publisher chooses. Anyone who needs a time a publisher cannot choose can move the
object to a chain registry, after which its anchoring bounds it. Most objects never
need this; a paper establishing priority might.

## Delegation

### Parties

- **User:** an agent DID whose wallet holds the root key.
- **Client:** an agent DID created by the application, holding its own key. Agents
  are self-controlled, so the user cannot own the client's DID.

### The delegation credential

The wallet issues a credential against a Memeplex delegation schema:

```jsonc
{
  "issuer": "did:cid:…user",
  "credentialSubject": {
    "id": "did:cid:…client",
    "memeplex": {
      "v": 1,
      "scopes": ["post", "reply", "react", "edit", "delete"],
      "client": "Memepool for iOS"      // human label for the wallet's list
    }
  },
  "validFrom": "2026-10-24T18:00:00Z",
  "validUntil": "2027-01-24T18:00:00Z" // optional expiry
}
```

### Scopes

| Scope | Allows the client to |
|---|---|
| `post` | create `post`, `article` and `paper` objects |
| `reply` | create `reply` objects |
| `review` | create `review` objects |
| `react` | create and delete `reaction` objects |
| `follow` | create and edit the author's `follows` object |
| `edit` | update objects it published under this delegation |
| `delete` | delete objects it published under this delegation |

A client asks for the scopes it needs; the wallet shows them and the user approves a
subset.

### Issuance flow

1. The client creates its agent DID and shows it to the user, for example as a QR code
   or a deep link into the wallet.
2. The wallet shows the requested scopes and expiry, and issues the credential.
3. The client accepts the credential and publishes it **revealed** in its own DID
   manifest (`publishCredential(did, { reveal: true })`). Archon credentials are
   encrypted to the holder by default; revealing the copy in the manifest is what lets
   any verifier read the scopes.
4. The client includes the credential DID as `memeplex.delegation` in every object it
   publishes for that user.

A client may hold delegations from several users (a shared device, or a service
publishing for many people); the `author` and `delegation` fields keep them apart.

## Attribution

A verifier attributes object *O* to user *U* as follows.

**Direct publishing.** If `O.memeplex.delegation` is absent, *O* is attributed to *U*
when *O*'s controller is *U* and `O.memeplex.author` is *U*.

**Delegated publishing.** Otherwise, with credential DID *C* = `O.memeplex.delegation`
and *T* = the time of the version being checked:

1. *O*'s controller is an agent DID *A*.
2. *A*'s manifest contains a revealed credential with `id` *C*. Its proof verifies
   against issuer *U*, its subject is *A*, and `O.memeplex.author` is *U*.
3. *C* resolved at *T* exists and is not deactivated. Because the credential carries
   its own DID (#948), a copied credential under another asset DID fails here.
4. *T* is within `validFrom` and `validUntil`.
5. The object's kind, or the operation (for an edit or a deletion), is within the
   credential's scopes.
6. The revocation record, if any, admits this version (next section).

If any step fails, the object is shown as unattributed: it exists, but not as *U*'s.

Steps 1–5 use only resolution. A shared verifier library should implement them once
for clients and indexers alike.

## Revocation

The wallet revokes a delegation by deactivating the credential DID
(`revokeCredential`). From then on step 3 fails for any version whose time is after
the revocation.

### The backdating gap

On `hyperswarm`, *T* is the publisher-chosen `proof.created`. A client that keeps its
key after revocation (a stolen device, a rogue app) can create objects or edits dated
before the revocation, and step 3 would accept them. Gatekeeper does not bound
Hyperswarm times by receipt, and adding such a bound is a protocol decision outside
this design.

Options:

1. **Revocation snapshot (recommended).** When revoking, the wallet first queries the
   objects published under *C* (`memeplex.delegation $in [C]`) and records the set it
   accepts, mapping each object DID to its version sequence at that moment. The record
   goes into the user's DID data under `memeplex.revocations[C]`, with the set on IPFS
   if it is large. Step 6 then admits only versions in the snapshot. Objects the
   wallet's node had not yet seen are lost, which is the right failure direction.
2. **Anchoring.** Attribute only versions anchored on a chain before the revocation's
   anchor. This is sound but slow and costly for ordinary posts.
3. **First-seen time.** Indexers record when they first observed each version and
   distrust versions first seen after the revocation. This is useful as a client-side
   heuristic but is not verifiable by others.

The snapshot needs nothing new from the protocol, and a user who suspects a compromise
can also date the snapshot earlier than the revocation to disown recent objects.

### Who controls published objects

The client controls the objects it publishes. Consequences:

- The user cannot edit or delete them directly. After revocation they no longer count
  as the user's beyond the snapshot, but they remain on the network.
- A cooperating client can hand objects over with `transferAsset` to the user's DID; a
  rogue or abandoned one will not.

Decision (from #1436): accept this for v1. If usage shows users need direct control,
the alternatives are a delegation term requiring transfer on request (unenforced), or a
protocol change letting Gatekeeper accept operations on a user's assets signed by a key
the user's credential names. The latter changes protocol authorization and needs its
own decision.

## Discovery and indexing

### Direct queries

Gatekeeper keeps an in-memory index of every DID's `didDocumentData`, and
`POST /api/v1/query` matches a path against a list of values. That index does not
cover the controller, which is why objects carry `author` in their data.

| Question | Query |
|---|---|
| Everything by a user | `{ "where": { "memeplex.author": { "$in": ["did:cid:…user"] } } }` |
| A whole thread | `{ "where": { "memeplex.root": { "$in": ["did:cid:…root"] } } }` |
| Direct replies | `{ "where": { "memeplex.replyTo": { "$in": ["did:cid:…post"] } } }` |
| Reviews or reactions of an object | `{ "where": { "memeplex.target": { "$in": ["did:cid:…paper"] } } }` |
| Objects under one delegation | `{ "where": { "memeplex.delegation": { "$in": ["did:cid:…cred"] } } }` |
| A tag | `{ "where": { "memeplex.tags[*]": { "$in": ["cryptography"] } } }` |

Only one condition and only `$in` are supported, results are unsorted and unpaged, and
query results are not attributions: the matches still have to pass the attribution
check, because anyone can write any `author` into an object they publish.

### Indexer

Timelines, ranking, full-text search and counts need an indexer. The Memepool indexer:

- follows new activity through `GET /api/v1/events` (filtered by time and registry),
  and resolves objects whose data has a `memeplex` member;
- verifies attribution once per version and stores the result;
- builds timelines from follow lists, thread trees, reply and reaction counts, and
  per-tag feeds;
- serves them to clients over HTTP, behind Drawbridge like other public surfaces.

The indexer is a cache of public data. Anyone can run one, and a client can always fall
back to direct queries and its own verification.

## Moderation and reputation

There is no central moderator. Viewers choose which judgments to apply:

- **Block lists and labels** are credentials or objects issued by communities that
  name DIDs or objects (as in #937). A client applies the lists its user trusts.
- **Reviews** are objects, so a review's own reputation is visible: who wrote it, who
  replied, whether it was retracted.
- **Unattributed objects** (failed delegation, revoked client) are hidden or marked by
  default.

## Scale

Objects as DIDs puts every object through Gatekeeper storage, gossip, replay and the
in-memory search index on every node. The protocol has no fixed limit that rules this
out, but cost per object should be measured, not assumed.

Benchmark before building the client, on an isolated node with production-like Redis
persistence, in both Gatekeeper ports:

- create 1, 5 and 10 million Memeplex objects with a realistic mix (mostly short posts
  and reactions, some replies, few articles), across a realistic number of authors;
- measure creation throughput, Hyperswarm propagation to a second node, startup replay
  time, resolve latency, `query` latency for `author` and `root`, the memory used by the
  search index, and storage;
- compare startup against the current production dataset to separate per-object cost
  from fixed cost.

The results decide whether reactions, the most numerous kind, stay as individual DIDs or
are batched (for example, one object per author per target holding the current
reactions).

## Security considerations

- **Spoofed authorship.** Anyone can publish an object claiming any `author`.
  Attribution, not the data, decides authorship. Clients must never display an
  unverified `author` as fact.
- **Credential copying.** Prevented by the credential's bound `id` (#948) and step 3.
- **Backdating after revocation.** Addressed by the revocation snapshot.
- **Over-broad scopes.** Wallets should default to narrow scopes and short expiries,
  and show which clients hold which scopes.
- **Spam.** Object creation on `hyperswarm` is free. Indexers will need rate limits or
  cost per author (for example L402 on publishing through a hosted node, or ranking by
  trust graph). Not designed here.
- **Content addressing of large bodies.** IPFS content is available only while someone
  pins it. The project's pinning work (`ARCHON_GATEKEEPER_REGISTRIES_PIN`) is one
  option; long-term availability of papers needs an explicit answer.

## Milestones

1. **Benchmark** objects-as-DIDs at the volumes above (Scale).
2. **Schemas:** the object schema and the delegation credential schema, with signed
   fixtures.
3. **Verifier library:** attribution steps 1–6, shared by clients and the indexer, with
   cross-checks against real signed objects, including revoked and copied credentials.
4. **Direct publishing:** create, edit, delete and query objects from the existing CLI
   and SDKs with no delegation; this works with today's `create-asset-json`.
5. **Delegation:** wallet UI to grant, list and revoke delegations, including the
   revocation snapshot.
6. **Indexer.**
7. **Memepool client.**
8. **Moderation:** block lists and labels.

## Open questions

- **Scope vocabulary.** Is the scope table above the right granularity, and should the
  delegation schema allow per-kind limits (for example, replies only to one thread)?
- **Revocation record.** Is `memeplex.revocations` in the user's DID data the right
  place, given that every revocation then updates the user's DID?
- **Reactions.** Individual DIDs or batched per author and target, pending the
  benchmark.
- **Follows.** One `follows` object per author and publisher means several clients
  produce several lists; should clients merge them, or should the wallet own the
  follow list?
- **Paper identity.** Is `supersedes` enough for arXiv-style versioning and citation,
  or do papers need a stable series identifier?
- **Content availability.** Who pins long-form content and papers, and for how long?

## Related

- #937: thin agent marketplace (attestations, opt-in block lists)
- #1044: encrypted messageboard where each post is a DID owned by its author
- #1299: historical verification of credential responses
- #108 / #948: credentials name the asset that holds them
