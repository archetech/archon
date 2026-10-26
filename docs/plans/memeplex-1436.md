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
   identity and gives a separate client a scoped, revocable **grant**: an ordinary
   asset the user creates, naming the client and what it may do. The client publishes
   under its own agent DID, and verifiers attribute its objects to the user through the
   grant. Every object is published by a client under a grant; a user who wants to
   publish without an application runs their own client. A grant and the objects published under it are
   anchored on one chain registry, so a revoked client cannot backdate its way past
   the revocation. This needs no protocol change.

## Goals

- Publishing of any length, from a one-line post to a paper, under one model.
- Responses (replies, boosts, reviews, comments, reactions) are first-class objects
  that link to what they respond to, so threads and review histories form a graph any
  node can walk.
- Authorship is verifiable by anyone, without trusting the client or an indexer.
- A client never holds the user's root key, and the user can cut a client off with
  one wallet action.
- Several independent clients can implement Memeplex; Memepool is one of them.

## Non-goals

- **No protocol change.** Gatekeeper's single-controller rule and its authorization
  model are unchanged. Delegation lives in grant assets and verifier logic.
- **No private content in v1.** Objects are public plaintext. Private circles (for
  example on group vaults, as in #1044) are later work.
- **No central ranking or moderation.** Indexers and clients may rank and filter, but
  the raw graph is public and anyone can aggregate it differently (as in #937).
- **No payment rail.** Tipping can use the existing `#lightning` service entries
  (`publish-lightning`, zaps) but is not part of the protocol.

## Names

| Name | What it is |
|---|---|
| **Memeplex** | The protocol: object schemas, grants, the attribution rules, and the query conventions. |
| **Memepool** | The first client and indexer, run by the project. |
| **object** | Any Memeplex asset DID: post, article, paper, reply, review, reaction, rating, tag. |
| **author** | The user DID an object is attributed to. |
| **publisher** | The agent DID that controls an object: the client its grant names, never the author itself. |

The name puns on the memetic *meme pool* and Bitcoin's *mempool*: objects gossip on
Hyperswarm first and are then anchored on a chain.

## Archon primitives used

Everything below exists today; the references are to `packages/keymaster/src/keymaster.ts`
and the Gatekeeper documentation.

| Need | Primitive |
|---|---|
| Create an object | `createAsset(data, { registry, controller })`. Assets must be controlled by an agent DID. Memeplex objects use their grant's chain registry. |
| Edit an object | `updateDID` / `mergeData`. Each update is a new version; earlier versions in the accepted history stay resolvable (`versionId`, `versionTime`, `versionSequence`). |
| Delete an object | `revokeDID`. Resolution reports `deactivated`, and deletion clears the document data while keeping registration metadata. |
| Anchor an object | Create it on a chain registry (BTC, ZEC, ETH, SOL), or `changeRegistry` to one and then publish an update there; see Timestamps and anchoring. |
| Move an object | `transferAsset` to another agent DID. |
| Large content | IPFS via the Gatekeeper data API (`createFile` stores `{ cid, filename, type, bytes }`). Operations are limited to 64 Ki JSON code units in both Gatekeeper ports. |
| Delegation | A grant: an asset the user creates and controls, naming the client and its actions. Revoked with `revokeDID`. |
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
    "kind": "reply",                // see Kinds; Fields lists what each kind allows
    "author": "did:cid:…user",      // the attributed user, who created the grant
    "grant": "did:cid:…",           // the grant it was published under

    // body: inline text, or instead, for anything large,
    // "content": { "cid": "…", "type": "text/markdown", "bytes": 48213 }
    "text": "…",

    // links
    "parent": "did:cid:…",          // the object this one responds to
    "parentVersion": "bafyrei…",    // the versionId responded to
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
| `article` | Long-form essay, Substack-like | — | `title`, optional `subtitle` and `summary`; body as `content` on IPFS. |
| `paper` | Scholarly work, arXiv-like | — | `title`, optional `subtitle`, `summary` (the abstract), `authors` (DIDs; see Coauthors), `content` (the paper in Markdown), optional `pdf` and `source` (LaTeX) downloads. Revised by editing; see Revisions and citation. |
| `reply` | Comment in a thread | required | Same fields as `post`. |
| `boost` | Reshare to the booster's own audience | required | Optional `text`, making it a quote post (see Boosts and quote posts). |
| `review` | Written assessment | required | `verdict` (short free text), body. A review can itself be replied to. A reviewer who also wants to score publishes a separate `rating`. |
| `reaction` | Like or other emoji response | required | `value`, one emoji (see Reactions). Withdrawn by deleting it. |
| `rating` | Score on the author's own scale | required | Integers `rating`, `min`, `max` (see Ratings). One per author per parent; changed by editing, withdrawn by deleting. |
| `tag` | Label applied to someone else's object | required | `tag`, a normalized string (see Tags). Withdrawn by deleting it. |

`parent` is the one link from a response to what it responds to; `kind` says how. This
keeps every response, of whatever kind, reachable from its parent with one query.

### Fields

| Field | Type | Kinds |
|---|---|---|
| `v` | integer, `1` | all; required |
| `kind` | string | all; required |
| `author` | DID | all; required |
| `grant` | DID | all; required |
| `text` | string, at most 10,000 code points | post, article, reply, boost, review |
| `content` | `{ cid, type, bytes }` | post, article, paper, reply, review |
| `parent`, `parentVersion` | DID, `versionId` | reply, boost, review, reaction, rating, tag; required |
| `tags` | 1–20 normalized strings, each at most 64 code points | post, article, paper, reply, review |
| `title` | string, at most 300 code points | article, paper; required |
| `subtitle` | string, at most 300 code points: one line shown under the title | article, paper |
| `summary` | string, at most 5,000 code points: an article's summary or a paper's abstract | article; paper, required |
| `authors` | 1–100 distinct DIDs, including `author` | paper; required |
| `source` | `{ cid, type, bytes }` | paper |
| `pdf` | `{ cid, type, bytes }` | paper |
| `verdict` | string, at most 300 code points | review; required |
| `value` | one emoji (see Reactions) | reaction; required |
| `rating`, `min`, `max` | integers (see Ratings) | rating; required |
| `tag` | normalized string, at most 64 code points (see Tags) | tag; required |

- **Body.** `text` and `content` are mutually exclusive. An article, reply or review
  has one of them; a paper has `content`; a post has `text` or `content`; a boost
  has `text` or nothing.
- **References.** `cid` is an IPFS CID string, `bytes` a nonnegative integer, and
  `type` the media type Text formatting allows for that field. A `parentVersion` is a
  canonical operation CID.
- **Strictness.** A field from this table on a kind that does not list it makes the
  object invalid, as does a missing required field. A field not in the table is
  ignored, so a later optional field (see Schemas) does not invalidate objects for
  clients that predate it.
- **Lengths** count Unicode code points. The whole operation must still fit
  Gatekeeper's 64 Ki limit.

A verdict is free text so that venues can use their own wording ("accept", "minor
revisions"). A venue that needs a fixed vocabulary defines an extension kind.

### Version pinning

Every reference to another object names the exact version it refers to, as AT
Protocol's strong references do:

- **`parent` with `parentVersion`.** A response always carries both: `parent` is the
  bare DID, so the "every response to an object" query still finds it, and
  `parentVersion` is the `versionId` of the revision the author saw.
- **Embeds** (images and quoted objects in the text) pin the version in the DID URL:
  `![alt](did:cid:…?versionId=bafyrei…)`. See Text formatting.

A reference then always means the content the author responded to, quoted or showed,
even after the target is edited. Clients may mark a response whose `parentVersion` is
not the parent's current revision. For reviews and ratings that mark is prominent
("reviewed an earlier revision"); for replies and reactions it can be subtle or
omitted. If a pinned version leaves the accepted history, see Revisions and citation.

### Schemas

Every kind, and the grant, has a **schema**: a JSON Schema (draft 2020-12) published as
an Archon schema asset (`createSchema`), in the spirit of AT Protocol's Lexicon. The
Memeplex specification lists the schema DID and pinned `versionId` for each core kind.

- **Validation.** Verifiers and indexers validate each object against its kind's
  schema. An object that fails is ignored: not displayed, counted or attributed.
  Rules a schema cannot express (the reaction emoji rules, normalized tags, rating
  bounds) are part of the kind's definition and are checked alongside.
- **Core kinds have bare names** (`post`, `reply`, `rating`, …).
- **Extension kinds are named by their schema DID:** `"kind": "did:cid:…schema?versionId=…"`.
  That gives namespacing without a registry or DNS. A client that does not know an
  extension kind can fetch its schema, and may show the object generically or ignore
  it.
- **Evolution.** Adding optional fields keeps `v`. A breaking change publishes a new
  schema and increments `v`; clients ignore versions they do not support.

### Examples

One object of each kind, showing each object's `didDocumentData`. Each names the grant
it was published under (see Delegation): the reply comes from Bob's Memepool client,
and the paper from a client Alice runs herself. DIDs are shortened.

**post**

```jsonc
{ "memeplex": { "v": 1, "kind": "post", "author": "did:cid:…alice",
                "grant": "did:cid:…alice-memepool",
                "text": "Every post on Memepool is a DID. So is this photo.\n\n![A canvas tent full of people facing a projector screen](did:cid:…photo?versionId=bafyreiimg…)",
                "tags": ["archon", "memeplex"] } }
```

**article**: the body lives on IPFS

```jsonc
{ "memeplex": { "v": 1, "kind": "article", "author": "did:cid:…alice",
                "grant": "did:cid:…alice-memepool",
                "title": "Why every post should be a DID",
                "subtitle": "Objects as identifiers, not rows in someone's database",
                "summary": "Permalinks, edit history and provable timestamps for free.",
                "content": { "cid": "bafkrei…", "type": "text/markdown", "bytes": 48213 },
                "tags": ["archon", "publishing"] } }
```

**paper**: revised in place; each revision is a version of the same DID

```jsonc
{ "memeplex": { "v": 1, "kind": "paper", "author": "did:cid:…alice",
                "grant": "did:cid:…alice-own-client",
                "title": "Convergent Replay of Signed DID Histories",
                "summary": "We show that nodes receiving the same signed operations …",
                "authors": ["did:cid:…alice", "did:cid:…bob"],
                "content": { "cid": "bafkrei…", "type": "text/markdown", "bytes": 61207 },
                "pdf": { "cid": "bafybei…", "type": "application/pdf", "bytes": 912340 },
                "source": { "cid": "bafybei…", "type": "application/x-tex", "bytes": 84112 },
                "tags": ["distributed-systems", "did"] } }
```

**reply**: published by Bob's client under his grant, quoting another post inline

```jsonc
{ "memeplex": { "v": 1, "kind": "reply", "author": "did:cid:…bob",
                "grant": "did:cid:…bobs-grant",
                "parent": "did:cid:…alice-post", "parentVersion": "bafyreipost…",
                "text": "Including the reactions? Carol measured them:\n\n![Carol's benchmark post](did:cid:…carol-post?versionId=bafyreicarol…)" } }
```

**boost**: a quote post; without `text` it would be a plain boost

```jsonc
{ "memeplex": { "v": 1, "kind": "boost", "author": "did:cid:…erin",
                "grant": "did:cid:…erin-grant",
                "parent": "did:cid:…alice-post", "parentVersion": "bafyreipost…",
                "text": "This is the clearest explanation of the idea so far." } }
```

**review**: pins the revision it assessed

```jsonc
{ "memeplex": { "v": 1, "kind": "review", "author": "did:cid:…carol",
                "grant": "did:cid:…carol-grant",
                "parent": "did:cid:…paper", "parentVersion": "bafyreirev2…",
                "verdict": "minor revisions",
                "text": "The convergence argument holds, but section 4 assumes …" } }
```

**reaction**

```jsonc
{ "memeplex": { "v": 1, "kind": "reaction", "author": "did:cid:…dave",
                "grant": "did:cid:…dave-grant",
                "parent": "did:cid:…alice-post", "parentVersion": "bafyreipost…",
                "value": "❤️" } }
```

**rating**: three stars out of five

```jsonc
{ "memeplex": { "v": 1, "kind": "rating", "author": "did:cid:…carol",
                "grant": "did:cid:…carol-grant",
                "parent": "did:cid:…paper", "parentVersion": "bafyreirev2…",
                "rating": 3, "min": 1, "max": 5 } }
```

**tag**: a community labeller marking a post

```jsonc
{ "memeplex": { "v": 1, "kind": "tag", "author": "did:cid:…spamwatch",
                "grant": "did:cid:…spamwatch-grant",
                "parent": "did:cid:…some-post", "parentVersion": "bafyreispam…",
                "tag": "spam" } }
```

### Reactions

A reaction's `value` is a single Unicode emoji, so every client can render it and no
Memeplex-specific list has to be maintained:

- **One emoji, in its canonical form.** `value` is exactly one emoji from Unicode's
  recommended (RGI) set, in the fully-qualified form listed in Unicode's
  `emoji-test.txt`. `❤️` is valid; the unqualified `❤` and arbitrary text are not.
  Each emoji therefore has one encoding, and counts never split across encodings.
- **Variants are allowed.** Skin-tone variants are valid RGI emoji. How to group
  variants when counting or displaying reactions is up to each client and indexer
  (see Memepool for its choice).
- **Invalid values are ignored.** A reaction whose `value` breaks these rules is not
  counted or displayed.
- **Counted once per author.** An author can react to one object with several emoji,
  but each emoji counts at most once per author, even if two clients each published
  it.

### Boosts and quote posts

A boost (repost) is a `boost` object whose `parent` is the original:

- A **plain boost** has no `text`. Clients show the original as "Alice boosted".
- A **quote post** adds `text`, shown above the original.

`kind`, not `parent`, decides thread membership: a thread shows `reply` objects, and
counts boosts, reactions, ratings and tags without listing them in it. So a boost
shares the original with the booster's own audience, yet the "every response to an
object" query still finds every boost and quote post through Gatekeeper alone.

Quoting inside other text is an embed (see Text formatting): an essay that discusses
three posts embeds each where it discusses it. Embeds are not indexed by Gatekeeper, so
counting them needs an indexer.

### Ratings

A rating states its own scale, so clients can use 5 stars, 0–100 or thumbs up and
down, and ratings stay comparable:

```jsonc
{ "memeplex": { "v": 1, "kind": "rating", "author": "did:cid:…user",
                "grant": "did:cid:…grant",
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
  visible; aggregators count each author's current attributed version once. Two
  clients can still each create a rating for the same author and parent. So that
  independent indexers agree, the author's rating is the attributed, undeleted rating
  object whose current version was anchored latest, by its anchoring block's time, with
  ties broken by the smallest canonical `versionId`. Block times are set by the chain,
  not the signer, and stay comparable when the ratings were published under grants on
  different registries. Deleting that object makes the next one by the same
  rule current; with none left, the author has no rating. Rating a
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
                "grant": "did:cid:…grant",
                "parent": "did:cid:…post", "parentVersion": "bafyrei…",
                "tag": "cryptography" } }
```

Tag values, in both places, are normalized before publishing: Unicode NFC, trimmed,
lower-case, internal whitespace collapsed to a single hyphen. Otherwise one tag
splinters across spellings. Like a reaction, a tag value counts at most once per
labeller and object.

Third-party tags are signed, attributed judgments like any other object, so their
weight depends on who applied them. Moderation labels are tags too (see Memepool:
Moderation).

### Content and size

Inline `text` is for content that fits comfortably inside one operation. Anything
larger, or any binary, goes to IPFS and is referenced from `content`. Updating the
content of an article is a normal update that replaces the reference; the old
reference stays in the previous version.

### Coauthors

Attribution covers only `author`, the DID that published the paper. The other DIDs in
`authors` are the publisher's **claim**. A listed coauthor confirms it by publishing a
`tag` with the value `coauthor` on the paper, with `parentVersion` set to the revision
they stand behind. Clients show each listed coauthor as confirmed only when such an
attributed tag exists for that revision or an earlier one, and as "listed by
the publisher" otherwise. A coauthor withdraws by deleting the tag.

### Text formatting

Every client renders the same text the same way:

- **`text`, and `content` of type `text/markdown`,** are GitHub Flavored Markdown
  (GFM): CommonMark plus tables, strikethrough, task lists and autolinked URLs, all
  precisely specified.
- **Math** uses the dollar convention shared by Pandoc, Jupyter and GitHub. Inline math
  is `$…$`, display math is `$$…$$`, and longer equations go in a fenced ```` ```math ````
  block. An opening `$` must be followed immediately by a non-space character, and a
  closing `$` must be preceded immediately by a non-space character and not followed by
  a digit, so "it costs $5 and $10" stays text. The math itself is LaTeX, rendered by
  the client (for example with KaTeX or MathJax).
- **No raw HTML.** HTML inside Markdown is displayed as text, never rendered.
- **Safe links only.** Links use `https:` or `did:`. Other schemes, including
  `javascript:` and `data:`, are not followed.
- **Embeds use Markdown image syntax,** in any kind: `![alt text](did:cid:…?versionId=…)`.
  There is no separate attachment or quote field. What a client shows depends on the
  DID:
  - an **image asset** is shown as the image (rules below); a client may lay out a
    short post's images as a gallery;
  - a **Memeplex object** is shown as a card with that version's content, marked if
    it is unattributed or no longer in the history;
  - anything else, or a DID URL without `versionId`, is shown as a link with the alt
    text.

  Only version-pinned `did:` URLs embed. Other sources are not loaded: an `https:`
  image would be fetched by every reader's client, telling the host who is reading,
  and could change after publication. A plain Markdown link, `[text](did:…)`, stays
  a link.
- **Images** are Archon image assets, created with `createImage`, whose data gives
  the IPFS CID, type, size, width and height.
  - **Types:** `image/png`, `image/jpeg`, `image/webp` and `image/gif`. No SVG, which can
    carry script.
  - **Size:** at most 10 MB per image; clients check the asset's `bytes` before
    fetching.
  - **Alt text** is expected to be non-empty. Clients may flag images without it.
- **Math renders untrusted.** Renderers disable trusted commands (KaTeX's `trust`
  option, which enables `\href`, `\url`, `\includegraphics` and HTML-class commands).
- **Graceful fallback.** A client may show any `text` as plain text, and math as its
  LaTeX source; both stay readable.

`content.type` is always `text/markdown`, for every kind, papers included: one body
format means one renderer, and every body reflows on small screens, works with screen
readers, can be searched, and can embed figures and other objects. A paper may also
carry two downloads, which clients offer but never render:

- **`pdf`** (`application/pdf`): the typeset version of record, for readers who want
  the author's exact layout and for printing. Clients do not embed a PDF viewer, which
  would be a large attack surface for untrusted files.
- **`source`**: LaTeX (`application/x-tex`) or a source archive (`application/gzip`),
  as arXiv accepts.

Pandoc converts most LaTeX papers to Markdown with math well enough; the PDF covers
what the conversion loses (custom macros, complex tables, exact figure placement).

### Edits, deletion and revisions

- **Edit:** an update to the object. Earlier versions remain resolvable while they are
  in the accepted history, so a client can show "edited" with the full history.
- **Delete:** `revokeDID`. Clients show a tombstone: the object existed, was deleted,
  and when.

### Revisions and citation

A revision is an edit: the object keeps its DID, and earlier revisions stay resolvable
while they remain in its accepted history. This is arXiv's model, with the DID as the identifier and its versions as
`v1`, `v2` and so on.

- **Citing the work** uses the bare DID, which always resolves to the latest revision.
- **Citing one revision** uses a DID URL with the revision's `versionId`, the canonical
  CID of the operation that produced it: `did:cid:…?versionId=bafyrei…`. Gatekeeper
  resolves it in both ports (#1462, #1463).
- **Not by sequence number or time.** `versionSequence` names a position, which a
  preferred sibling can take over, and a version's time is not known until it is
  anchored. Only `versionId` names fixed content, so an author cannot change what a
  citation points to after the fact.
- **A pending revision can disappear.** Until a revision is anchored, the object's
  controller can publish a competing successor that Archon's sibling ordering prefers,
  displacing it from the accepted history; resolving its `versionId` then returns
  `notFound`. That is the honest answer to an equivocating author, not an error.
  Clients show the citation as "revision no longer in the history" and never
  substitute another revision. Once a revision is anchored, Gatekeeper prefers it over
  any sibling anchored later, so citing anchored revisions avoids this. A reviewer who
  needs the assessed content itself to survive keeps its `content` CID, and pins it
  (see Content availability under Security considerations).
- **Responses pin what they assessed.** Every response names the revision it
  responded to in `parentVersion` (see Version pinning), so a review of v1 is never
  presented as a review of v2.

### Timestamps and anchoring

Every object is created on its grant's chain registry (see Delegation), so every
version is anchored once the chain includes its batch. Its time is then the anchoring
block's time, which the publisher cannot choose: a paper establishing priority needs
nothing extra. Before anchoring, a version carries only its signed `proof.created`,
which the publisher chooses; clients show such versions as pending.

## Follows are not objects

A follow is not a publication. It has no content anyone reads, quotes or cites, nobody
responds to it, and it is current state the reader toggles rather than a work
addressed to an audience. Memeplex therefore defines no follow kind: whom a reader
follows is the reader's own preference, kept by their client (see Memepool).

## Delegation

### Grants

A **grant** lets one client publish for one user. It is an asset the user's wallet
creates, so it is signed with the user's own key and controlled by the user:

```jsonc
{ "memeplexGrant": { "v": 1,
                     "client": "did:cid:…client",
                     "actions": ["memeplex:post", "memeplex:reply", "memeplex:react"],
                     "nonce": "Qm9vdHN0cmFwIG5vbmNl" } }
```

- **Client:** the agent DID that publishes, holding its own key, and never the user's
  own DID: the user's identity key does not sign publications. Agents are
  self-controlled, so the user cannot own the client's DID; the grant is how the user
  vouches for it. A user who wants to publish without an application, or to keep
  control of their objects, runs their own client: an agent DID they create, hold the
  key for, and grant like any other.
- **Actions:** which kinds the client may create (table below). A client may always
  edit and delete the objects it published under the grant.
- **Nonce:** copied from the client's grant request so the client can find this grant
  (see Flow). It carries no authority.
- **On a chain.** The wallet creates the grant on a chain registry (BTC, ZEC, ETH or
  SOL), and every object published under it is created on that same registry and
  stays there. A grant on `hyperswarm`, `local` or `pin` is void. See Revocation for
  why.
- **Immutable.** A grant's history is its creation and at most a deletion; a grant
  with any other update is void. To narrow a grant, the wallet revokes it and creates
  a narrower one.
- **Revocation:** the wallet deletes the grant with `revokeDID` (see Revocation).
- **No expiry and no re-delegation.** A grant lasts until it is revoked, and a client
  cannot pass it on: only the user can create a grant. Wallets list active grants so
  unused ones can be revoked.

Grants use their own `memeplexGrant` data member, not `memeplex`, so indexers never
mistake one for a publication.

### Actions

| Action | Lets the client create |
|---|---|
| `memeplex:post` | `post`, `article` and `paper` objects |
| `memeplex:reply` | `reply` objects |
| `memeplex:boost` | `boost` objects |
| `memeplex:review` | `review` objects |
| `memeplex:react` | `reaction` objects |
| `memeplex:rate` | `rating` objects |
| `memeplex:tag` | `tag` objects |

For an extension kind, the action is the kind itself, its schema DID URL; the wallet
shows the schema's title.

A client asks for the actions it needs; the wallet shows them and the user approves a
subset.

### Flow

1. The client creates its agent DID and a **grant request**:

   ```jsonc
   { "memeplexGrantRequest": { "v": 1,
                               "client": "did:cid:…client",
                               "name": "Memepool",
                               "actions": ["memeplex:post", "memeplex:reply", "memeplex:react"],
                               "nonce": "Qm9vdHN0cmFwIG5vbmNl" } }
   ```

   `nonce` is at least 128 random bits, base64url-encoded. The client shows the request
   as base64url-encoded JSON, in a QR code or a link the wallet accepts.
2. The wallet shows the client DID, the claimed `name` (labelled as the client's own
   claim) and the requested actions. The user approves a subset and picks a chain
   registry, and the wallet creates the grant there with that subset and the request's
   `client` and `nonce`.
3. The client finds the grant with a query for `memeplexGrant.client` (see Queries),
   keeps the one carrying its nonce, and checks *grant-ok* for itself. The grant's
   creator is the user. Anyone who saw the request could create a grant with the same
   nonce from a different DID, so the client shows the user's identity and asks for
   confirmation before publishing.
4. The client names the grant's DID as `memeplex.grant` in every object it publishes
   for that user, and creates each object on the grant's registry. Its Gatekeeper
   must support that registry.

A client may hold grants from several users (a shared device, or a service publishing
for many people); the `author` and `grant` fields keep them apart.

### Standards considered

ZCAP (W3C CCG Authorization Capabilities) and UCAN were considered. Both exist mainly
for chained delegation and for verifying a capability without fetching anything.
Memeplex needs neither: one level of delegation is enough, and Archon verification
already resolves DIDs. A grant asset already has what those formats add: it is signed
by the user, versioned, resolvable as of any past time, and revoked by deactivation.
Adopting either standard would add a proof format and verification rules without
adding protection.

## Attribution

Attribution is decided **per version**, along the object's accepted history. The
current controller is not evidence of authorship: an asset transfer needs only the
previous owner's signature, so anyone can create an object naming *U* as author and
then transfer it to *U* without *U* signing anything.

### Evidence

A verifier reads an object's accepted history from Gatekeeper's export
(`POST /api/v1/dids/export`, `exportDIDs` in the SDK): its events in predecessor
order. For each version it takes:

- **versionId:** the canonical CID of the event's operation (the event's `opid`,
  computed as Gatekeeper computes it when absent). `previd` names the predecessor.
- **Signer:** the DID in the operation's `proof.verificationMethod`. Gatekeeper
  accepted the operation only if that DID controlled the predecessor, or for a
  creation, is the controller the operation names. A verifier that trusts its
  Gatekeeper does not re-check signatures.
- **Controller and data:** from the create operation for the creation, and from
  resolving the object at the version's `versionId` for later versions.
- **Position *P*:** where the version is anchored on a chain registry *R*: the
  event's `ordinal` when the event's `registry` is *R*. Positions on one registry
  compare lexicographically (block height, index within the block, then the
  operation's index in its batch), so they order operations even within one block. A
  version whose accepted event is not yet a receipt from *R* is **pending** on *R*.
- **Time:** the event's `time`, as resolution reports it. Attribution does not use it;
  it orders duplicate ratings (see Ratings) and is shown to readers.

The grant's own history is read the same way.

### Grant check

*grant-ok(G, U, A, P)* holds when grant *G* lets client *A* act for user *U* at
position *P* on *G*'s registry:

1. *G*'s create operation names *U* as its controller and is signed by *U*. (A grant
   someone else created and then transferred to *U* does not count, for the same reason
   as above.)
2. *G* was created on a chain registry *R*, and its history is its creation and at most
   a deletion.
3. *G*'s creation is anchored on *R* before *P*.
4. *G* is not deleted, or its deletion is pending or anchored after *P*.
5. *G*'s `client` is *A*, and *A* is not *U*.

The check compares chain positions on one registry, never clocks (see Revocation).

### Creation

The create operation decides whether an object is a publication by *U* at all. Let *A*
be the controller the create operation names and signs with.

It is attributed to *U* when all of these hold, for *G* = `memeplex.grant`:

1. `memeplex.author` is *U*.
2. The object is created on *G*'s registry *R*.
3. *grant-ok(G, U, A, P)* holds for the creation's position *P* on *R*.
4. *G*'s `actions` include the action for the object's kind (see Actions).

A creation that is not yet anchored is **pending**: neither attributed nor rejected,
and decided once it is anchored. An object whose creation is not attributed is never
attributed, whatever its later versions say.

### Later versions

An update or deletion, signed by its predecessor's controller *A*, is attributed to *U*
only if all of these hold:

1. Its predecessor version is attributed to *U*, so attribution runs unbroken from the
   creation.
2. It leaves `author`, `kind`, `grant` and `parent` unchanged: an object stays under
   the grant it was created under, and a response stays in its thread. `parentVersion`
   may change, so a review or rating can move to a newer revision of its parent. (A
   deletion clears the data; the check applies to the predecessor.)
3. *grant-ok(G, U, A, P)* holds for that grant at the version's position *P* on the
   grant's registry. The client may edit or delete what it published under the grant.
4. It changes neither the controller nor the registry. A transfer or a
   `changeRegistry` ends attribution for that version and every later one.

A version that fails is shown as unattributed and stops the lineage: later versions
built on it are unattributed too. Earlier attributed versions stay attributed. A
pending version makes the versions after it pending too.

A shared verifier library should implement these rules once for clients and indexers
alike.

## Revocation

The wallet revokes a grant with `revokeDID`. Revocation takes effect at the deletion's
position on the grant's registry: versions anchored before it keep their attribution,
and versions anchored after it, or never, have none.

### Why objects are anchored

On `hyperswarm`, a version's time is the `proof.created` its signer chooses. A client
that keeps its key after revocation (a stolen device, a rogue app) could sign objects
and edits dated before the revocation, and a check by time would accept them.
Gatekeeper does not bound Hyperswarm times by receipt, and adding such a bound would be
a protocol change.

A chain position cannot be chosen. An operation anchored after the grant's deletion
comes after it, whatever its `proof.created` says, so the grant check compares
positions instead of times. Requiring the grant and its objects to share one registry
makes that comparison exact; positions on different chains could only be compared
through block timestamps, which drift (Bitcoin allows about two hours).

Consequences:

- **Pending until anchored.** An object gossips on Hyperswarm at once, so
  readers see it within seconds, but it is attributed only once its batch is anchored:
  minutes on SOL or ETH, longer on BTC, depending on the mediator's batch interval.
  Clients show it as pending until then.
- **A window at revocation.** Revocation takes effect when the deletion is anchored.
  Until then a compromised client can still get operations anchored ahead of it. The
  wallet submits the deletion at once, so the window is about one batch interval.
- **No inventory.** The wallet does not need to find what the client published.
  Everything anchored before the deletion stays attributed, including objects the
  wallet never saw and objects later deleted; nothing anchored after it is.
- **No displaced versions.** Among siblings, Gatekeeper prefers the one anchored first
  on the expected registry, so a revoked client cannot displace an anchored version.
  Its sibling would be anchored later, and after the deletion.
- **No disowning.** A user cannot disown objects anchored before the revocation, even
  ones a compromised client published before the user noticed.
- **One rule for everyone.** A client the user runs follows the same rules as any
  application, so the verifier has a single path.

Two alternatives were considered. A **revocation snapshot**, recorded in the grant
just before deletion and listing the `versionId` of every object to keep, gives
immediate attribution and no window, but needs the wallet to find every object
(deleted ones included), depends on the snapshot staying available on IPFS, and adds
an unverified state. Distrusting versions an indexer first saw after the revocation is
a useful client-side heuristic, but other parties cannot verify it.

### Who controls published objects

The grant's client controls the objects published under it. Consequences:

- The user cannot edit or delete an application's objects directly. After revocation
  they no longer count as the user's beyond what was anchored before it, but they
  remain on the network.
- Transferring an object ends its attribution, so a client cannot hand objects over to
  the user. A user who wants an object under their own control republishes it through
  a client they run.

Decision (from #1436): accept this for v1. If usage shows users need direct control of
an application's objects, the alternative is a protocol change letting Gatekeeper
accept operations on a user's assets signed by a key the user's grant names. That
changes protocol authorization and needs its own decision.

## Queries

Gatekeeper keeps an in-memory index of every DID's `didDocumentData`, and
`POST /api/v1/query` matches a path against a list of values. That index does not
cover the controller, which is why objects carry `author` in their data.

| Question | Query |
|---|---|
| Everything by a user | `{ "where": { "memeplex.author": { "$in": ["did:cid:…user"] } } }` |
| Every response to an object | `{ "where": { "memeplex.parent": { "$in": ["did:cid:…"] } } }` |
| Objects under one grant | `{ "where": { "memeplex.grant": { "$in": ["did:cid:…grant"] } } }` |
| Grants naming a client | `{ "where": { "memeplexGrant.client": { "$in": ["did:cid:…client"] } } }` |
| Objects an author tagged | `{ "where": { "memeplex.tags[*]": { "$in": ["cryptography"] } } }` |
| Tags others applied (their `parent`s are the tagged objects) | `{ "where": { "memeplex.tag": { "$in": ["cryptography"] } } }` |

A whole thread is loaded by repeating the `parent` query one level at a time; an
indexer builds thread trees directly. Objects carry no separate thread-root field to
keep consistent.

Only one condition and only `$in` are supported, so a client separates replies,
boosts, reviews, reactions, ratings and tags by `kind` after the query. Results are unsorted and unpaged, and
they are not attributions: the matches still have to pass the attribution check,
because anyone can write any `author` into an object they publish.

## Memepool

Everything above is the Memeplex protocol: what any client must publish and how any
verifier attributes it. This section records choices specific to Memepool, the first
client and indexer. Other clients may choose differently.

### Reactions

Memepool offers no skin-tone picker, and counts and renders every reaction as its base
emoji: the fully-qualified RGI emoji that Unicode's `emoji-test.txt` lists as the
untoned form of the reaction's `value`. Removing the modifier code points is not
enough: ☝🏽 without its modifier is the unqualified `☝`, whose base is `☝️`, and a toned
multi-person sequence can have a different base (👩🏽‍🤝‍👩🏻's base is 👭). The mapping is
derived from `emoji-test.txt`, which lists each toned emoji with its base.

### Follows

Memepool keeps follows **private**: on the device, or in a vault the user owns so that
several clients share them. Follows are never published, so the network does not learn
whom anyone follows. A hosted indexer that builds a reader's timeline does learn the set
of authors it is asked about, and computing the timeline locally does not by itself
avoid this: per-author queries go to a Gatekeeper over HTTP, so a remote Gatekeeper sees
the same author set. Readers who want their follows private from every service query a
Gatekeeper and indexer they run or trust. This is closer to Substack's reading privacy
than to Twitter's public graph.

A public social graph (follower counts, graph-based discovery) can be added later if
something needs it. The candidates are a `follows` list in the user's own DID data,
written by the wallet, or a single per-user state asset kept apart from publications.
Neither is part of v1.

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
  grant and the chain positions compared. It re-verifies pending versions as they are
  anchored, and versions anchored after a grant's deletion once that deletion is
  anchored;
- builds timelines for the set of authors a reader supplies (see Follows), thread
  trees, reply, reaction and boost counts, and per-tag feeds;
- serves them to clients over HTTP, behind Drawbridge like other public surfaces.

The indexer is a cache of public data. Anyone can run one, and a client can always fall
back to direct queries and its own verification.

### Moderation

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

### Wallet

The wallet lists active grants with the actions they allow, defaults to narrow actions,
lets the user choose each grant's chain registry, and makes revoking a grant a single
action that is submitted at once, so the deletion is anchored in the next batch.

## Scale

Every object, of every kind, is a DID; no kind is batched or stored differently. Each
object goes through Gatekeeper gossip, replay and the in-memory search index on every
node, so the costs that grow with object count are CPU, memory and startup time rather
than storage. Optimizations will come as volume requires them, as they have for
startup replay.

A sizing benchmark establishes the starting point, on an isolated node with production-like Redis
persistence, in both Gatekeeper ports:

- create 1, 5 and 10 million Memeplex objects with a realistic mix (mostly short posts,
  reactions, ratings and tags, some replies, few articles), across a realistic number of
  authors;
- measure creation throughput, Hyperswarm propagation to a second node, mediator
  batch anchoring throughput on a chain registry, startup replay
  time, resolve latency, `query` latency for `author` and `parent`, the memory
  used by the search index, and storage;
- compare startup against the current production dataset to separate per-object cost
  from fixed cost.

The results size node hardware and show where optimization will be needed first.

## Security considerations

- **Spoofed authorship.** Anyone can publish an object claiming any `author`.
  Attribution, not the data, decides authorship. Clients must never display an
  unverified `author` as fact.
- **Forged grants.** A grant counts only if the user created it; one created by
  someone else and transferred to the user fails the grant check.
- **Backdating after revocation.** Addressed by anchoring grants and their objects
  on one chain registry and comparing positions, not times. The remaining window is
  the time until the deletion is anchored.
- **Over-broad or forgotten grants.** Mitigated by wallet design (see Memepool:
  Wallet).
- **Transferred objects.** Ownership is not authorship; attribution follows the
  creation and signed lineage, never the current controller.
- **Rendering untrusted text.** Every object's text is attacker-controlled. The
  formatting rules (no raw HTML, safe link schemes, untrusted math) are what keep a
  post from becoming script in every client; renderers must follow them exactly.
- **Spam.** Every object is anchored, so the anchoring node pays a share of a batch
  transaction for it, but per object that is small. Indexers will need rate limits or
  cost per author (for example L402 on publishing through a hosted node, or ranking by
  trust graph). Not designed here.
- **Content availability.** IPFS content is available only while someone pins it.
  Registry pinning (`ARCHON_GATEKEEPER_REGISTRIES_PIN`) pins operation JSON only, not
  the article, PDF or image bytes an object references. Those need explicit
  pinning by the publisher, the indexer or a pinning service; long-term availability of
  papers needs an explicit answer.

## Milestones

1. **Benchmark** objects-as-DIDs at the volumes above (Scale).
2. **Schemas:** JSON Schemas for every core kind and the grant, published as schema
   assets, with signed fixtures.
3. **Verifier library:** the attribution rules, shared by clients and the indexer, with
   cross-checks against real signed objects, including revoked and forged grants,
   transferred objects, and backdated siblings.
4. **CLI client:** create an agent DID as the client, grant it from the user's
   identity, then create, edit, delete and query objects on the grant's registry from
   the existing CLI and SDKs; this works with today's asset commands.
5. **Delegation:** wallet UI to create, list and revoke grants on a chain registry.
6. **Indexer.**
7. **Memepool client.**
8. **Moderation:** block lists and labels.

## Open questions

- **Action vocabulary.** Is one action per creatable kind the right granularity, and
  should grants be able to narrow further (for example, replies only within one
  thread)?
- **Expiry.** Should grants carry an optional expiry? A block height on the grant's
  registry would be checkable the same way as revocation.
- **Change feed.** Should Gatekeeper offer an arrival-ordered change feed? It would
  let indexers follow new and displaced versions directly, instead of reconciling
  periodically against full state.
- **Public follows.** Whether Memeplex should ever define a public follow list (see
  Memepool: Follows), and if so, where it lives.
- **Content availability.** Who pins long-form content and papers, and for how long?
- **Custom emoji.** Should reactions also allow community emoji, as a shortcode plus
  an image CID (in the style of Nostr's NIP-30), with clients that lack support
  showing the shortcode?

## References

- ZCAP: [Authorization Capabilities v0.4.0](https://w3c-ccg.github.io/zcap-spec/) and
  UCAN: [specification](https://github.com/ucan-wg/spec), considered and not adopted
- #937: thin agent marketplace (attestations, opt-in block lists)
- #1044: encrypted messageboard where each post is a DID owned by its author
- #1299: historical verification of credential responses
- #1462 / #1463: Gatekeeper resolution by `versionId`
