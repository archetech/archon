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

1. **Every published object is a DID.** A post, an essay, a paper, a reply, a review,
   a reaction, a rating and a tag are each an Archon asset. Archon's existing machinery then
   supplies permalinks, ownership, edit history, deletion, gossip and optional chain
   timestamps.
2. **Applications live outside the wallet.** The user's wallet holds the root
   identity and delegates scoped, revocable authority to a separate client using an
   existing standard, Authorization Capabilities (ZCAP). The client publishes under its
   own agent DID, and verifiers attribute its objects to the user through the
   capability. This needs no protocol change.

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
  model are unchanged. Delegation lives in signed capabilities and verifier logic.
- **No private content in v1.** Objects are public plaintext. Private circles (for
  example on group vaults, as in #1044) are later work.
- **No central ranking or moderation.** Indexers and clients may rank and filter, but
  the raw graph is public and anyone can aggregate it differently (as in #937).
- **No payment rail.** Tipping can use the existing `#lightning` service entries
  (`publish-lightning`, zaps) but is not part of the protocol.

## Names

| Name | What it is |
|---|---|
| **Memeplex** | The protocol: object schemas, the delegation profile, the attribution rules, and the query conventions. |
| **Memepool** | The first client and indexer, run by the project. |
| **object** | Any Memeplex asset DID: post, article, paper, reply, review, reaction, rating, tag. |
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
| Signed delegation | Data Integrity proofs, which Archon already produces for operations (`proofPurpose: capabilityInvocation`) and credentials. |
| Revocable handle | An issuer-owned asset holding the capability, bound to its own DID the way credentials are (#948), and deactivated to revoke. |
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
    "capability": { … },            // the delegated zcap; omitted when the author publishes directly

    // content: inline text, or a reference for anything large
    "text": "…",
    "content": { "cid": "…", "type": "text/markdown", "bytes": 48213 },

    // links
    "parent": "did:cid:…",          // the object or DID this one responds to
    "parentVersion": "bafyrei…",    // optional: the parent's versionId this one responds to
    "root": "did:cid:…",            // the thread root, for one-query thread loading
    "quotes": ["did:cid:…"],
    "tags": ["cryptography", "did"]
  }
}
```

The object carries no timestamp of its own. Its creation and update times are those of
its operations, which resolution already reports.

### Kinds

| Kind | Purpose | `parent` | Notes |
|---|---|---|---|
| `post` | Short text, Twitter-like | — | Usually inline `text`. |
| `article` | Long-form essay, Substack-like | — | `title`, `summary`; body as `content` on IPFS. |
| `paper` | Scholarly work, arXiv-like | — | `title`, `abstract`, `authors` (DIDs), `content` (PDF or source). Revised by editing; see Revisions and citation. |
| `reply` | Comment in a thread | required | Same fields as `post`; also carries `root`. |
| `review` | Written assessment | required | `verdict` (free text or schema-defined), body. A review can itself be replied to. A reviewer who also wants to score publishes a separate `rating`. |
| `reaction` | Like or other emoji response | required | `value`, one emoji (see Reactions). Withdrawn by deleting it. |
| `rating` | Score on the author's own scale | required | Integers `rating`, `min`, `max` (see Ratings). One per author per parent; changed by editing, withdrawn by deleting. |
| `tag` | Label applied to someone else's object | required | `tag`, a normalized string (see Tags). Withdrawn by deleting it. |

`parent` is the one link from a response to what it responds to; `kind` says how. This
keeps every response, of whatever kind, reachable from its parent with one query. A
response that assessed one particular revision also names it in `parentVersion` (see
Revisions and citation). `parent` itself stays the bare DID, so the query still finds it.

Kinds are an open set: a client ignores kinds it does not understand. New kinds are
added by agreement, not by registry.

### Examples

One object of each kind, showing each object's `didDocumentData`. All but the reply are
published directly by their author. The reply is published by a delegated client, so it
carries a capability (abbreviated here; see Delegation for the full form). DIDs are
shortened.

**post**

```jsonc
{ "memeplex": { "v": 1, "kind": "post", "author": "did:cid:…alice",
                "text": "Every post on Memepool is a DID. This one too.",
                "tags": ["archon", "memeplex"] } }
```

**article**: the body lives on IPFS

```jsonc
{ "memeplex": { "v": 1, "kind": "article", "author": "did:cid:…alice",
                "title": "Why every post should be a DID",
                "summary": "Permalinks, edit history and provable timestamps for free.",
                "content": { "cid": "bafkrei…", "type": "text/markdown", "bytes": 48213 },
                "tags": ["archon", "publishing"] } }
```

**paper**: revised in place; each revision is a version of the same DID

```jsonc
{ "memeplex": { "v": 1, "kind": "paper", "author": "did:cid:…alice",
                "title": "Convergent Replay of Signed DID Histories",
                "abstract": "We show that nodes receiving the same signed operations …",
                "authors": ["did:cid:…alice", "did:cid:…bob"],
                "content": { "cid": "bafybei…", "type": "application/pdf", "bytes": 912340 },
                "tags": ["distributed-systems", "did"] } }
```

**reply**: published by Bob's client under his capability, quoting another post

```jsonc
{ "memeplex": { "v": 1, "kind": "reply", "author": "did:cid:…bob",
                "capability": { "id": "did:cid:…handle", "controller": "did:cid:…bobs-client",
                                "allowedAction": ["memeplex:post", "memeplex:reply"], "…": "…" },
                "parent": "did:cid:…alice-post", "root": "did:cid:…alice-post",
                "text": "Including the reactions? See the scale section.",
                "quotes": ["did:cid:…carol-post"] } }
```

**review**: pins the revision it assessed

```jsonc
{ "memeplex": { "v": 1, "kind": "review", "author": "did:cid:…carol",
                "parent": "did:cid:…paper", "parentVersion": "bafyreirev2…",
                "verdict": "minor revisions",
                "text": "The convergence argument holds, but section 4 assumes …" } }
```

**reaction**

```jsonc
{ "memeplex": { "v": 1, "kind": "reaction", "author": "did:cid:…dave",
                "parent": "did:cid:…alice-post", "value": "❤️" } }
```

**rating**: three stars out of five

```jsonc
{ "memeplex": { "v": 1, "kind": "rating", "author": "did:cid:…carol",
                "parent": "did:cid:…paper", "parentVersion": "bafyreirev2…",
                "rating": 3, "min": 1, "max": 5 } }
```

**tag**: a community labeller marking a post

```jsonc
{ "memeplex": { "v": 1, "kind": "tag", "author": "did:cid:…spamwatch",
                "parent": "did:cid:…some-post", "tag": "spam" } }
```

### Reactions

A reaction's `value` is a single Unicode emoji, so every client can render it and no
Memeplex-specific list has to be maintained:

- **One emoji, in its canonical form.** `value` is exactly one emoji from Unicode's
  recommended (RGI) set, in the fully-qualified form listed in Unicode's
  `emoji-test.txt`. `❤️` is valid; the unqualified `❤` and arbitrary text are not.
  Each emoji therefore has one encoding, and counts never split across encodings.
- **No skin-tone modifiers.** The five modifiers U+1F3FB–U+1F3FF are not allowed.
  Clients that offer a tone picker strip the modifier before publishing. Other
  multi-character emoji (🧑‍💻, 🏳️‍🌈) are allowed.
- **Invalid values are ignored.** A reaction whose `value` breaks these rules is not
  counted or displayed.

### Boosts and quote posts

A boost (repost) is a `post` that quotes the original:

- A **plain boost** has `quotes: [original]` and no `text`. Clients show the original
  as "Alice boosted".
- A **quote post** adds `text`, shown above the original.

Neither sets `parent`: a boost shares the original with the booster's own audience
instead of joining its thread. A reply that also quotes something is still a reply,
because `parent` decides thread membership and `quotes` only embeds.

### Ratings

A rating states its own scale, so clients can use 5 stars, 0–100 or thumbs up and
down, and ratings stay comparable:

```jsonc
{ "memeplex": { "v": 1, "kind": "rating", "author": "did:cid:…user",
                "parent": "did:cid:…paper", "parentVersion": "bafyreirev2…",
                "rating": 3, "min": 1, "max": 5 } }
```

- `rating`, `min` and `max` are integers with `min < max` and
  `min ≤ rating ≤ max`.
- The comparable value is `(rating − min) / (max − min)`, from 0 (worst) to 1 (best).
  Three stars on a 1–5 scale is 0.5; 80 on 0–100 is 0.8; a thumbs up `(1, 0, 1)` is 1.
  Centred scales work too: `(0, −2, 2)` is 0.5.
- Four stars out of five, `(4, 1, 5)`, is **0.75, not 0.8**: it is three steps up a
  four-step scale. Clients that display normalized values should not present them as
  "n out of max".
- An author has one rating per parent. Changing it is an edit, so the history stays
  visible; aggregators count each author's current attributed version once. Rating a
  new revision of the parent is also an edit, which updates `parentVersion`; the
  earlier rating and the revision it rated remain in the history.
- Equal values are not equally precise: a 5-point scale and a 100-point scale cluster
  differently. Aggregators that care can group by `max − min`.

A like stays a `reaction` ("I appreciate this"); a `rating` judges quality.

### Tags

An object's author describes it with the `tags` field inside the object. Anyone else
labels it with a `tag` object whose `parent` is the labelled object:

```jsonc
{ "memeplex": { "v": 1, "kind": "tag", "author": "did:cid:…labeller",
                "parent": "did:cid:…post", "tag": "cryptography" } }
```

Tag values, in both places, are normalized before publishing: Unicode NFC, trimmed,
lower-case, internal whitespace collapsed to a single hyphen. Otherwise one tag
splinters across spellings.

Third-party tags are signed, attributed judgments like any other object, so their
weight depends on who applied them. Moderation labels are tags too (see Moderation and
reputation).

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

### Revisions and citation

A revision is an edit: the object keeps its DID, and every earlier revision stays
resolvable. This is arXiv's model, with the DID as the identifier and its versions as
`v1`, `v2` and so on.

- **Citing the work** uses the bare DID, which always resolves to the latest revision.
- **Citing one revision** uses a DID URL with the revision's `versionId`, the canonical
  CID of the operation that produced it: `did:cid:…?versionId=bafyrei…`. Gatekeeper
  resolves it in both ports (#1462, #1463).
- **Not by sequence number or time.** `versionSequence` names a position, which a
  preferred sibling can take over, and on `hyperswarm` a version's time is chosen by
  its publisher. Only `versionId` names fixed content, so an author cannot change what
  a citation points to after the fact.
- **Responses pin what they assessed.** A `review` or `rating` of an article or paper
  sets `parentVersion` to the `versionId` it assessed. Clients show "reviewed an
  earlier revision" when that is not the current version, so a review of v1 is never
  presented as a review of v2. Replies, reactions and tags usually omit it.

### Timestamps and anchoring

On `hyperswarm`, an object's time is the signed `proof.created` of its operation, which
the publisher chooses. Anyone who needs a time a publisher cannot choose can move the
object to a chain registry, after which its anchoring bounds it. Most objects never
need this; a paper establishing priority might.

## Follows

A follow is not a publication. It has no content anyone reads, quotes or cites, nobody
responds to it, and it is current state the reader toggles rather than a work
addressed to an audience. Memeplex therefore defines publications and responses only,
and treats a follow list as the reader's own preference.

By default a client keeps follows **private**: on the device, or in a vault the user
owns so that several clients share them. Timelines are computed for the reader, so the
network never needs to know whom anyone follows. This is closer to Substack's reading
privacy than to Twitter's public graph.

A public social graph (follower counts, graph-based discovery) can be added later if
something needs it. The candidates are a `follows` list in the user's own DID data,
written by the wallet, or a single per-user state asset kept apart from publications
and editable by a delegated client. Neither is part of v1.

## Delegation

### Standards considered

Delegation should use an existing standard rather than a Memeplex-specific credential.
The Decentralized Identity Foundation's review of delegated-authorization options found
two with chained delegation: ZCAP and UCAN.

| | ZCAP (Authorization Capabilities) | UCAN | Plain verifiable credential |
|---|---|---|---|
| Maintainer | W3C Credentials Community Group | UCAN working group | — (convention only) |
| Version | v0.4.0 draft; revival proposed April 2026 | v1.0.0 release candidates | No delegation schema exists; only community drafts and sector profiles |
| Encoding | JSON-LD, Data Integrity proofs | DAG-CBOR envelope, varsig signatures | JSON-LD |
| Scope | `invocationTarget` plus `allowedAction` | `cmd` hierarchy plus a policy language | Whatever the schema says |
| Chaining | `parentCapability`; child may only narrow the parent | `aud`→`iss` proof chain; may only narrow | Not defined |
| Expiry | Required; child no later than parent; verifiers SHOULD reject more than 3 months out | `exp` required but may be `null` | Optional |
| Revocation | Largely unspecified (a verifier-side endpoint) | Separate revocation spec | Archon: deactivate the credential DID |
| Fit with Archon | Archon already signs Data Integrity proofs and names `capabilityInvocation` as its operation proof purpose | Needs DAG-CBOR and varsig codecs Archon does not have | Native, but invents its own semantics |

**Decision: use the ZCAP data model**, signed with the Data Integrity proofs Archon
already produces, and supply revocation from Archon, which ZCAP leaves unspecified.
UCAN's command hierarchy and policy language are attractive, but its encoding is
foreign to everything else Archon signs. A plain credential would reinvent exactly the
semantics (attenuation, chaining, expiry) that ZCAP already defines.

### Parties

- **User:** an agent DID whose wallet holds the root key.
- **Client:** an agent DID created by the application, holding its own key. Agents
  are self-controlled, so the user cannot own the client's DID.

### Capabilities

The **root capability** names the user's DID as its target and its controller, and is
never stored or signed (a ZCAP root is identified by its target):

```jsonc
{
  "@context": "https://w3id.org/zcap/v1",
  "id": "urn:zcap:root:did%3Acid%3A…user",
  "controller": "did:cid:…user",
  "invocationTarget": "did:cid:…user"
}
```

The wallet **delegates** from the root to the client:

```jsonc
{
  "@context": ["https://w3id.org/zcap/v1", "https://w3id.org/security/suites/…"],
  "id": "did:cid:…handle",              // the asset that holds this capability (see Revocation)
  "parentCapability": "urn:zcap:root:did%3Acid%3A…user",
  "invocationTarget": "did:cid:…user",
  "controller": "did:cid:…client",
  "allowedAction": ["memeplex:post", "memeplex:reply", "memeplex:react", "memeplex:edit"],
  "expires": "2027-01-24T18:00:00Z",
  "proof": {
    "type": "DataIntegrityProof",
    "proofPurpose": "capabilityDelegation",
    "capabilityChain": ["urn:zcap:root:did%3Acid%3A…user"],
    "verificationMethod": "did:cid:…user#key-1",
    "created": "2026-10-24T18:00:00Z",
    "proofValue": "…"
  }
}
```

A client may delegate a narrower capability onward, for example to a scheduling bot,
with this capability as `parentCapability`. ZCAP's rules then require the child's
actions to be a subset of the parent's and its expiry to be no later.

### Actions

| `allowedAction` | Allows the controller to |
|---|---|
| `memeplex:post` | create `post`, `article` and `paper` objects |
| `memeplex:reply` | create `reply` objects |
| `memeplex:review` | create `review` objects |
| `memeplex:react` | create and delete `reaction` objects |
| `memeplex:rate` | create, edit and delete `rating` objects |
| `memeplex:tag` | create and delete `tag` objects |
| `memeplex:edit` | update objects published under this capability |
| `memeplex:delete` | delete objects published under this capability |

A client asks for the actions it needs; the wallet shows them and the user approves a
subset.

### Expiry and renewal

ZCAP requires an expiry, and verifiers should reject one more than three months out. A
wallet therefore renews a client's capability before it expires, by delegating a new
capability with a new handle. Objects published under the old one stay attributed (the
attribution check uses the object's own time), so renewal costs one wallet action per
period and nothing else.

### Issuance flow

1. The client creates its agent DID and shows it to the user, for example as a QR code
   or a deep link into the wallet.
2. The wallet shows the requested actions and expiry, creates the handle asset, signs
   the capability with the handle's DID as its `id`, and stores the signed capability in
   the handle.
3. The client fetches the capability from the handle and embeds it as
   `memeplex.capability` in every object it publishes for that user. ZCAP verifiers do
   not fetch capabilities by ID during chain verification, so each object carries what
   is needed to verify it.

A client may hold capabilities from several users (a shared device, or a service
publishing for many people); the `author` and `capability` fields keep them apart.

### Invocation

In ZCAP terms, publishing an object is an invocation of the capability. Archon already
signs every operation with `proofPurpose: capabilityInvocation`; the client's signature
on the object's create or update operation is the invocation proof, and the action is
implied by the object's kind and operation (create, update or delete).

## Attribution

Attribution is decided **per version**, along the object's accepted history. The
current controller is not evidence of authorship: an asset transfer needs only the
previous owner's signature, so anyone can create an object naming *U* as author and
then transfer it to *U* without *U* signing anything.

### Capability check

*capability-ok(Z, U, A, X, T)* holds when capability *Z* lets controller *A* perform
action *X* for user *U* at time *T*:

1. *Z*'s chain ends at the root capability whose `invocationTarget` and `controller`
   are *U*.
2. Each delegation proof in the chain verifies, signed by a key of the previous link's
   controller (for the first link, *U*'s key as resolved at the proof's time).
3. Each link narrows its parent: actions a subset, expiry no later.
4. *Z*'s `controller` is *A*.
5. *T* is before each link's `expires`.
6. *X* is within *Z*'s `allowedAction`.
7. Each link's handle, resolved at *T*, exists, is not deactivated, and holds a
   capability with the same `id`. Because the capability names its handle, a copy
   under another asset fails here.
8. Any revocation or expiry snapshot for a link admits this version (see Revocation).

Steps 1–6 follow the ZCAP verification algorithm; steps 7 and 8 are the Archon
revocation profile.

### Creation

The create operation decides whether an object is a publication by *U* at all. Let *A*
be the controller the create operation names and signs with, and *T* its time.

- **Direct:** `memeplex.capability` is absent, `memeplex.author` is *U*, and *A* is *U*.
- **Delegated:** `memeplex.author` is *U*, and *capability-ok(Z, U, A, X, T)* holds for
  *Z* = `memeplex.capability` and *X* the creating action for the object's kind
  (`memeplex:post`, `memeplex:reply`, `memeplex:review`, `memeplex:react`,
  `memeplex:rate` or `memeplex:tag`).

An object whose creation is not attributed is never attributed, whatever its later
versions say.

### Later versions

An update or deletion, signed by its predecessor's controller *A* at time *T*, is
attributed to *U* only if all of these hold:

1. Its predecessor version is attributed to *U*, so attribution runs unbroken from the
   creation.
2. It leaves `author` and `kind` unchanged. (A deletion clears the data; the check
   applies to the predecessor.)
3. *A* is *U* (direct), or *capability-ok(Z, U, A, X, T)* holds with *X* =
   `memeplex:edit` or `memeplex:delete`, or the kind's own action where that action
   covers it (`memeplex:react` and `memeplex:tag` cover deletion; `memeplex:rate` covers
   editing and deletion). For an update, *Z* is the capability the new version carries;
   it may be a renewal rather than the creating capability, but its controller must be
   *A*. A deletion carries no data, so for a deletion *Z* is the capability its
   predecessor carries. To delete under a renewal, a client first installs the renewal
   with an attributed update.
4. If it changes the controller, the new controller is *U*: a client may hand an object
   back to its author, after which later versions are direct. Any other transfer ends
   attribution for every later version.

A version that fails is shown as unattributed and stops the lineage: later versions
built on it are unattributed too. Earlier attributed versions stay attributed.

A shared verifier library should implement these rules once for clients and indexers
alike.

## Revocation

ZCAP leaves revocation largely to the verifier. Memeplex supplies it from Archon: each
delegated capability lives in an asset owned by its delegator (the **handle**), and
deactivating the handle with `revokeDID` revokes the capability. From then on step 7
fails for any version whose time is after the revocation. This is the same binding
Archon credentials use (#948): the handle's DID is the capability's `id`, so it is
created first and the signed capability is written into it with an update.

### The backdating gap

On `hyperswarm`, *T* is the publisher-chosen `proof.created`. A client that keeps its
key after revocation (a stolen device, a rogue app) can create objects or edits dated
before the revocation, and step 7 would accept them. Gatekeeper does not bound
Hyperswarm times by receipt, and adding such a bound is a protocol decision outside
this design.

Options:

1. **Revocation snapshot (recommended).** When revoking, the wallet first finds every
   object whose history depends on the handle, and records the set it accepts, mapping
   each object DID to the `versionId` (the canonical operation CID) of its accepted
   version at that moment.

   The current capability is not enough to find them. An object created under the
   handle and later edited under a renewal no longer carries it, and objects published
   under capabilities delegated *from* the handle carry their own. Missing either would
   drop its creation from the snapshot and break the whole lineage. So the wallet
   queries the user's objects by author (`memeplex.author $in [user]`; `author` never
   changes), walks each object's history, and includes the object if any version's
   capability chain contains the handle. Deleted objects no longer match the author
   query; only their tombstones lose attribution. The record goes
   into the user's DID data under `memeplex.revocations[handle]`, with the set on IPFS
   if it is large. Step 8 then admits a version only if its `versionId` is in the
   snapshot or is an ancestor of one, reached through signed `previd` links. Objects
   the wallet's node had not yet seen are lost, which is the right failure direction.

   The snapshot names operations, not sequence numbers, because a sequence number does
   not identify content: a revoked client could publish a backdated sibling at the same
   sequence that Archon's sibling ordering prefers over the snapshotted version. Under
   the `versionId` rule that sibling is simply unattributed.
2. **Anchoring.** Attribute only versions anchored on a chain before the revocation's
   anchor. This is sound but slow and costly for ordinary posts.
3. **First-seen time.** Indexers record when they first observed each version and
   distrust versions first seen after the revocation. This is useful as a client-side
   heuristic but is not verifiable by others.

The snapshot needs nothing new from the protocol, and a user who suspects a compromise
can also take it from an earlier point to disown recent objects.

### Expiry has the same gap

After `expires`, a client that still has its key can publish objects dated before the
expiry, and step 5 accepts them. On `hyperswarm`, expiry therefore bounds a delegation
only when the wallet also records a snapshot for it, as for revocation. The wallet
should do so when it renews a capability and when one lapses. Without a snapshot,
expiry bounds only anchored publications.

### Who controls published objects

The client controls the objects it publishes. Consequences:

- The user cannot edit or delete them directly. After revocation they no longer count
  as the user's beyond the snapshot, but they remain on the network.
- A cooperating client can hand objects over with `transferAsset` to the user's DID; a
  rogue or abandoned one will not.

Decision (from #1436): accept this for v1. If usage shows users need direct control,
the alternatives are a delegation term requiring transfer on request (unenforced), or a
protocol change letting Gatekeeper accept operations on a user's assets signed by a key
the user's capability names. The latter changes protocol authorization and needs its
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
| Every response to an object | `{ "where": { "memeplex.parent": { "$in": ["did:cid:…"] } } }` |
| Boosts and quote posts of an object | `{ "where": { "memeplex.quotes[*]": { "$in": ["did:cid:…"] } } }` |
| Objects under one capability | `{ "where": { "memeplex.capability.id": { "$in": ["did:cid:…handle"] } } }` |
| Objects an author tagged | `{ "where": { "memeplex.tags[*]": { "$in": ["cryptography"] } } }` |
| Tags others applied (their `parent`s are the tagged objects) | `{ "where": { "memeplex.tag": { "$in": ["cryptography"] } } }` |

Only one condition and only `$in` are supported, so a client separates replies,
reviews, reactions, ratings and tags by `kind` after the query. Results are unsorted and unpaged, and
they are not attributions: the matches still have to pass the attribution check,
because anyone can write any `author` into an object they publish.

### Indexer

Timelines, ranking, full-text search and counts need an indexer. The Memepool indexer:

- discovers new activity through `GET /api/v1/events` and resolves objects whose data
  has a `memeplex` member;
- remembers every DID it has indexed and processes every later event for those DIDs,
  including deletions. A deleted object's data is cleared, so it no longer carries a
  `memeplex` member, and filtering on that member would leave stale posts and
  reactions in the index instead of tombstones;
- reconciles periodically against full state, because the events feed is ordered by
  event time, not arrival. A late or backdated publication can land behind any
  polling watermark, and replay can displace a branch without emitting a new event.
  Reconciliation re-resolves the indexed DIDs and re-reads the events feed over its
  whole range;
- verifies attribution per version and records what each result depended on: the
  capability handles in the chain, the author's DID (which holds revocation records),
  and the controllers whose keys signed. When any of those change, the indexer
  re-verifies the affected versions, so a later revocation snapshot can disown objects
  it had already accepted;
- builds timelines for the set of authors a reader supplies (see Follows), thread
  trees, reply, reaction and boost counts, and per-tag feeds;
- serves them to clients over HTTP, behind Drawbridge like other public surfaces.

The indexer is a cache of public data. Anyone can run one, and a client can always fall
back to direct queries and its own verification.

## Moderation and reputation

There is no central moderator. Viewers choose which judgments to apply:

- **Labels are tags.** A community labels an object ("spam", "misleading",
  "nsfw") by publishing a `tag` object from its own DID. A client applies the tags
  from the labellers its reader trusts and ignores the rest, so moderation needs no
  separate mechanism. Block lists of DIDs remain credentials issued by those
  communities (as in #937).
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

- create 1, 5 and 10 million Memeplex objects with a realistic mix (mostly short posts,
  reactions, ratings and tags, some replies, few articles), across a realistic number of
  authors;
- measure creation throughput, Hyperswarm propagation to a second node, startup replay
  time, resolve latency, `query` latency for `author`, `root` and `parent`, the memory
  used by the search index, and storage;
- compare startup against the current production dataset to separate per-object cost
  from fixed cost.

Every delegated object embeds its capability, so measure object size with a realistic
chain as well. The results decide whether reactions, ratings and tags, the most numerous kinds,
stay as individual DIDs or are batched.

## Security considerations

- **Spoofed authorship.** Anyone can publish an object claiming any `author`.
  Attribution, not the data, decides authorship. Clients must never display an
  unverified `author` as fact.
- **Capability copying.** Prevented by the capability's handle-bound `id` and step 7.
- **Backdating after revocation or expiry.** Addressed by snapshots bound to operation
  CIDs.
- **Over-broad actions.** Wallets should default to narrow actions, and show which
  clients hold which actions. ZCAP's mandatory expiry bounds a forgotten delegation
  only for anchored publications, or with an expiry snapshot (see Revocation).
- **Transferred objects.** Ownership is not authorship; attribution follows the
  creation and signed lineage, never the current controller.
- **Spam.** Object creation on `hyperswarm` is free. Indexers will need rate limits or
  cost per author (for example L402 on publishing through a hosted node, or ranking by
  trust graph). Not designed here.
- **Content addressing of large bodies.** IPFS content is available only while someone
  pins it. The project's pinning work (`ARCHON_GATEKEEPER_REGISTRIES_PIN`) is one
  option; long-term availability of papers needs an explicit answer.

## Milestones

1. **Benchmark** objects-as-DIDs at the volumes above (Scale).
2. **Schemas:** the object schema and the Memeplex ZCAP profile (actions, handle,
   revocation), with signed fixtures.
3. **Verifier library:** the attribution rules, shared by clients and the indexer, with
   cross-checks against real signed objects, including revoked, expired, widened and
   copied capabilities, transferred objects, edit-only capabilities, and backdated
   siblings.
4. **Direct publishing:** create, edit, delete and query objects from the existing CLI
   and SDKs with no delegation; this works with today's `create-asset-json`.
5. **Delegation:** wallet UI to grant, renew, list and revoke capabilities, including
   the revocation snapshot.
6. **Indexer.**
7. **Memepool client.**
8. **Moderation:** block lists and labels.

## Open questions

- **Delegation key.** ZCAP seeds the chain from the target's `capabilityDelegation`
  verification relationship, which Archon DID documents do not carry today. Either the
  Memeplex profile accepts a key in `capabilityInvocation` (which Archon uses for
  operations) as delegation authority, or agent documents gain `capabilityDelegation`.
- **Cryptosuite.** Archon's secp256k1 proofs use an unregistered cryptosuite because no
  registered suite covers secp256k1. Generic ZCAP libraries will not verify them, so
  interoperability beyond Memeplex verifiers may need the `eddsa-jcs-2022` assertion
  keys Archon already supports.
- **Action vocabulary.** Is the action table the right granularity, and should
  capabilities be able to narrow further (for example, replies only within one thread)?
- **Revocation record.** Is `memeplex.revocations` in the user's DID data the right
  place, given that every revocation then updates the user's DID?
- **Change feed.** Should Gatekeeper offer an arrival-ordered change feed? It would
  let indexers follow new and displaced versions directly, instead of reconciling
  periodically against full state.
- **Reactions, ratings and tags.** Individual DIDs or batched, pending the benchmark.
- **Public follows.** Whether Memeplex should ever define a public follow list (see
  Follows), and if so, where it lives.
- **Content availability.** Who pins long-form content and papers, and for how long?
- **Custom emoji.** Should reactions also allow community emoji, as a shortcode plus
  an image CID (in the style of Nostr's NIP-30), with clients that lack support
  showing the shortcode?

## References

- ZCAP: [Authorization Capabilities v0.4.0](https://w3c-ccg.github.io/zcap-spec/), W3C
  Credentials Community Group draft; [revival proposal, April 2026](https://lists.w3.org/Archives/Public/public-credentials/2026Apr/0029.html)
- UCAN: [specification](https://github.com/ucan-wg/spec) and
  [delegation](https://github.com/ucan-wg/delegation)
- #937: thin agent marketplace (attestations, opt-in block lists)
- #1044: encrypted messageboard where each post is a DID owned by its author
- #1299: historical verification of credential responses
- #1462 / #1463: Gatekeeper resolution by `versionId`
- #108 / #948: credentials name the asset that holds them
