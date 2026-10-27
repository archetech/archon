# Memeplex reference: formats and implementation (#1436)

Status: design; not implemented. Read the [protocol core](memeplex-1436.md) first.
This companion holds the field definitions, schemas, examples and operational
detail. Object formats and rendering requirements apply to
Memeplex implementations; the Memepool section records choices of one client.
The core is the single definition of attribution and publication state.

## Object format

An object is an asset with a `memeplex` member in `didDocumentData`. The five
[kinds](memeplex-1436.md#a-small-vocabulary) share one attribution rule. Responses
use the [version-pinned references](memeplex-1436.md#references-remember-what-was-read)
defined in the core. Examples below show asset data with abbreviated identifiers.

### Fields

| Field | Type | Kinds |
|---|---|---|
| `v` | integer, `1` | all; required |
| `kind` | string | all; required |
| `author` | DID | all; required |
| `grant` | DID | all; required |
| `text` | string, at most 10,000 code points | post, reply |
| `content` | `{ cid, type, bytes }` | post, paper, reply |
| `target`, `targetVersion` | DID, `versionId` | post, optional; reply, rating, tag, required |
| `tags` | 1–20 strings, each 1–64 code points (see Tags and reactions) | post, paper, reply |
| `title` | string, at most 300 code points | post, optional; paper, required |
| `subtitle` | string, at most 300 code points: one line shown under the title | post with a `title`; paper |
| `summary` | string, at most 5,000 code points: an article's summary or a paper's abstract | post with a `title`; paper, required |
| `authors` | 1–100 distinct DIDs, including `author` | paper; required |
| `source` | `{ cid, type, bytes }` | paper |
| `pdf` | `{ cid, type, bytes }` | paper |
| `verdict` | string, at most 300 code points | reply |
| `rating`, `min`, `max` | integers (see Ratings) | rating; required |
| `tag` | string, 1–64 code points (see Tags and reactions) | tag; required |
| `image` | version-pinned DID URL of an image asset (see Custom emoji) | tag |

- **Body.** `text` and `content` are mutually exclusive. A reply has one of them; a
  paper has `content`; a post has `text` or `content`, or neither when it has a
  `target` (a plain boost).
- **References.** `cid` is an IPFS CID string, `bytes` a nonnegative integer, and
  `type` the media type Text formatting allows for that field. A `targetVersion` is a
  canonical operation CID.
- **Strictness.** A field from this table on a kind that does not list it makes the
  object invalid, as does a missing required field. A field not in the table is
  ignored. New fields arrive only with a new `v` (see Schemas: Evolution).
- **Lengths** count Unicode code points. The whole operation must still fit
  Gatekeeper's 64 Ki limit.

A verdict is free text so that venues can use their own wording ("accept", "minor
revisions"). A venue that needs a fixed vocabulary defines an extension kind.

### Schemas

Every kind, the grant and the grant request has a **schema**: a JSON Schema (draft
2020-12), in the spirit of AT Protocol's Lexicon. The schema text below is normative.
Each schema is also published as an Archon schema asset (`createSchema`), with the
common `$defs` inlined so it stands alone, and the protocol pins its DID and
`versionId`. A schema validates the `memeplex` member (or `memeplexGrant`,
`memeplexGrantRequest`), not the whole `didDocumentData`.

- **Validation.** Verifiers and indexers validate each object against its kind's
  schema. A version that fails is not attributed; earlier attributed versions still
  determine publication state. Rules a schema cannot express are part of the kind's definition
  and are checked alongside (see Checks beyond the schemas).
- **Core kinds have bare names** (`post`, `reply`, `rating`, …).
- **Extension kinds are named by their schema DID:** `"kind": "did:cid:…schema?versionId=…"`.
  That gives namespacing without a registry or DNS. A client that does not know an
  extension kind can fetch its schema, and may show the object generically or ignore
  it.
- **Evolution.** The schemas and the checks beyond them for a given `v` never
  change. Any change to what is valid, including a new optional field (an unknown
  field that was ignored would now be checked), publishes new schemas under a new
  `v`. Validity never depends on Unicode data, so a new Unicode release needs no new
  `v`.
  Each object is validated by the rules of its own `v`, so a verifier that supports
  `v: 2` still validates `v: 1` objects by `v: 1` rules, and every verifier that
  supports a `v` reaches the same result for it. A verifier that does not support an
  object's `v` neither attributes nor rejects it: the object is unsupported there.

### Schema text

**Common definitions**, shared as `$defs` by every schema:

```json
{
  "did": {"type": "string", "pattern": "^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$"},
  "versionId": {"type": "string", "pattern": "^b[a-z2-7]{20,}$"},
  "cid": {
    "type": "string",
    "pattern": "^(b[a-z2-7]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$"
  },
  "pinnedDidUrl": {
    "type": "string",
    "pattern": "^did:[a-z0-9]+:[A-Za-z0-9._:%-]+\\?versionId=b[a-z2-7]{20,}$"
  },
  "bytes": {"type": "integer", "minimum": 0},
  "markdown": {
    "type": "object",
    "required": ["cid", "type", "bytes"],
    "properties": {
      "cid": {"$ref": "#/$defs/cid"},
      "type": {"const": "text/markdown"},
      "bytes": {"$ref": "#/$defs/bytes"}
    }
  },
  "pdf": {
    "type": "object",
    "required": ["cid", "type", "bytes"],
    "properties": {
      "cid": {"$ref": "#/$defs/cid"},
      "type": {"const": "application/pdf"},
      "bytes": {"$ref": "#/$defs/bytes"}
    }
  },
  "source": {
    "type": "object",
    "required": ["cid", "type", "bytes"],
    "properties": {
      "cid": {"$ref": "#/$defs/cid"},
      "type": {"enum": ["application/x-tex", "application/gzip"]},
      "bytes": {"$ref": "#/$defs/bytes"}
    }
  },
  "tagValue": {"type": "string", "minLength": 1, "maxLength": 64},
  "tags": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"$ref": "#/$defs/tagValue"}},
  "text": {"type": "string", "maxLength": 10000},
  "action": {
    "anyOf": [
      {"enum": ["memeplex:post", "memeplex:reply", "memeplex:rate", "memeplex:tag"]},
      {"$ref": "#/$defs/pinnedDidUrl"}
    ]
  },
  "actions": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"$ref": "#/$defs/action"}},
  "nonce": {"type": "string", "minLength": 22, "pattern": "^[A-Za-z0-9_-]+$"},
  "expiresAt": {
    "type": "string",
    "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"
  }
}
```

Every schema sets `"$schema": "https://json-schema.org/draft/2020-12/schema"`, omitted
below. Each kind's schema lists every field the field table defines: the fields the
kind allows with their types, and the rest as `false`, so a field from another kind
makes the object invalid. Other properties are unconstrained, so unknown fields are
ignored, as the strictness rule requires.

**post**

```json
{
  "title": "Memeplex post",
  "type": "object",
  "properties": {
    "v": {"const": 1},
    "author": {"$ref": "#/$defs/did"},
    "grant": {"$ref": "#/$defs/did"},
    "kind": {"const": "post"},
    "text": {"$ref": "#/$defs/text"},
    "content": {"$ref": "#/$defs/markdown"},
    "target": {"$ref": "#/$defs/did"},
    "targetVersion": {"$ref": "#/$defs/versionId"},
    "tags": {"$ref": "#/$defs/tags"},
    "title": {"type": "string", "maxLength": 300},
    "subtitle": {"type": "string", "maxLength": 300},
    "summary": {"type": "string", "maxLength": 5000},
    "authors": false, "source": false, "pdf": false, "verdict": false,
    "rating": false, "min": false, "max": false, "tag": false, "image": false
  },
  "required": ["v", "kind", "author", "grant"],
  "dependentRequired": {
    "target": ["targetVersion"],
    "targetVersion": ["target"],
    "subtitle": ["title"],
    "summary": ["title"]
  },
  "allOf": [
    {"not": {"required": ["text", "content"]}},
    {
      "anyOf": [
        {"required": ["text"]},
        {"required": ["content"]},
        {"required": ["target"]}
      ]
    }
  ]
}
```

**paper**

```json
{
  "title": "Memeplex paper",
  "type": "object",
  "properties": {
    "v": {"const": 1},
    "author": {"$ref": "#/$defs/did"},
    "grant": {"$ref": "#/$defs/did"},
    "kind": {"const": "paper"},
    "content": {"$ref": "#/$defs/markdown"},
    "tags": {"$ref": "#/$defs/tags"},
    "title": {"type": "string", "maxLength": 300},
    "subtitle": {"type": "string", "maxLength": 300},
    "summary": {"type": "string", "maxLength": 5000},
    "authors": {
      "type": "array",
      "minItems": 1,
      "maxItems": 100,
      "uniqueItems": true,
      "items": {"$ref": "#/$defs/did"}
    },
    "source": {"$ref": "#/$defs/source"},
    "pdf": {"$ref": "#/$defs/pdf"},
    "text": false, "target": false, "targetVersion": false, "verdict": false,
    "rating": false, "min": false, "max": false, "tag": false, "image": false
  },
  "required": ["v", "kind", "author", "grant", "title", "summary", "authors", "content"]
}
```

**reply**

```json
{
  "title": "Memeplex reply",
  "type": "object",
  "properties": {
    "v": {"const": 1},
    "author": {"$ref": "#/$defs/did"},
    "grant": {"$ref": "#/$defs/did"},
    "kind": {"const": "reply"},
    "text": {"$ref": "#/$defs/text"},
    "content": {"$ref": "#/$defs/markdown"},
    "target": {"$ref": "#/$defs/did"},
    "targetVersion": {"$ref": "#/$defs/versionId"},
    "tags": {"$ref": "#/$defs/tags"},
    "verdict": {"type": "string", "maxLength": 300},
    "title": false, "subtitle": false, "summary": false, "authors": false,
    "source": false, "pdf": false, "rating": false, "min": false, "max": false,
    "tag": false, "image": false
  },
  "required": ["v", "kind", "author", "grant", "target", "targetVersion"],
  "allOf": [
    {"not": {"required": ["text", "content"]}},
    {
      "anyOf": [
        {"required": ["text"]},
        {"required": ["content"]}
      ]
    }
  ]
}
```

**rating**

```json
{
  "title": "Memeplex rating",
  "type": "object",
  "properties": {
    "v": {"const": 1},
    "author": {"$ref": "#/$defs/did"},
    "grant": {"$ref": "#/$defs/did"},
    "kind": {"const": "rating"},
    "target": {"$ref": "#/$defs/did"},
    "targetVersion": {"$ref": "#/$defs/versionId"},
    "rating": {"type": "integer"},
    "min": {"type": "integer"},
    "max": {"type": "integer"},
    "text": false, "content": false, "tags": false, "title": false,
    "subtitle": false, "summary": false, "authors": false, "source": false,
    "pdf": false, "verdict": false, "tag": false, "image": false
  },
  "required": ["v", "kind", "author", "grant", "target", "targetVersion", "rating", "min", "max"]
}
```

**tag**

```json
{
  "title": "Memeplex tag",
  "type": "object",
  "properties": {
    "v": {"const": 1},
    "author": {"$ref": "#/$defs/did"},
    "grant": {"$ref": "#/$defs/did"},
    "kind": {"const": "tag"},
    "target": {"$ref": "#/$defs/did"},
    "targetVersion": {"$ref": "#/$defs/versionId"},
    "tag": {"type": "string", "minLength": 1, "maxLength": 64},
    "image": {"$ref": "#/$defs/pinnedDidUrl"},
    "text": false, "content": false, "tags": false, "title": false,
    "subtitle": false, "summary": false, "authors": false, "source": false,
    "pdf": false, "verdict": false, "rating": false, "min": false, "max": false
  },
  "required": ["v", "kind", "author", "grant", "target", "targetVersion", "tag"]
}
```

**grant** (`memeplexGrant`)

```json
{
  "title": "Memeplex grant",
  "type": "object",
  "required": ["v", "client"],
  "properties": {
    "v": {"const": 1},
    "client": {"$ref": "#/$defs/did"},
    "actions": {"$ref": "#/$defs/actions"},
    "nonce": {"$ref": "#/$defs/nonce"},
    "expiresAt": {"$ref": "#/$defs/expiresAt"}
  }
}
```

**grant request** (`memeplexGrantRequest`)

```json
{
  "title": "Memeplex grant request",
  "type": "object",
  "required": ["v", "client", "name", "nonce"],
  "properties": {
    "v": {"const": 1},
    "client": {"$ref": "#/$defs/did"},
    "name": {"type": "string", "minLength": 1, "maxLength": 100},
    "actions": {"$ref": "#/$defs/actions"},
    "nonce": {"$ref": "#/$defs/nonce"},
    "expiresAt": {"$ref": "#/$defs/expiresAt"}
  }
}
```

JSON Schema counts string length in code points, matching the field table.

### Checks beyond the schemas

These rules cannot be expressed in JSON Schema. Validators apply them alongside the
schema, and a version that fails one is invalid in the same way.

1. **Rating bounds:** `min < max` and `min ≤ rating ≤ max`.
2. **Paper authors:** `authors` includes `author`.
3. **Expiry instant:** a grant's or grant request's `expiresAt` is a valid ISO 8601
   date-time in UTC, such as `2026-12-31T00:00:00Z`. The schema's pattern checks only
   the shape; a value that is not a real instant is invalid.

No check depends on Unicode data: tag values are validated structurally, and how
they are normalized and classified is up to readers (see Tags and reactions).

### Examples

One object of each kind and common variant, showing `didDocumentData`. Each names
its [grant](memeplex-1436.md#one-grant-one-client-one-chain): the reply comes from
Bob's Memepool client, and the paper from a client Alice runs herself. DIDs are
shortened.

**post**

```jsonc
{ "memeplex": { "v": 1, "kind": "post", "author": "did:cid:…alice",
                "grant": "did:cid:…alice-memepool",
                "text": "Every post on Memepool is a DID. So is this photo.\n\n![A canvas tent full of people facing a projector screen](did:cid:…photo?versionId=bafyreiimg…)",
                "tags": ["archon", "memeplex"] } }
```

**post with a title (an article)**: the body lives on IPFS

```jsonc
{ "memeplex": { "v": 1, "kind": "post", "author": "did:cid:…alice",
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
                "target": "did:cid:…alice-post", "targetVersion": "bafyreipost…",
                "text": "Including the reactions? Carol measured them:\n\n![Carol's benchmark post](did:cid:…carol-post?versionId=bafyreicarol…)" } }
```

**post with a target**: a quote post; without `text` it would be a plain boost

```jsonc
{ "memeplex": { "v": 1, "kind": "post", "author": "did:cid:…erin",
                "grant": "did:cid:…erin-grant",
                "target": "did:cid:…alice-post", "targetVersion": "bafyreipost…",
                "text": "This is the clearest explanation of the idea so far." } }
```

**reply with a verdict (a review)**: pins the revision it assessed

```jsonc
{ "memeplex": { "v": 1, "kind": "reply", "author": "did:cid:…carol",
                "grant": "did:cid:…carol-grant",
                "target": "did:cid:…paper", "targetVersion": "bafyreirev2…",
                "verdict": "minor revisions",
                "text": "The convergence argument holds, but section 4 assumes …" } }
```

**tag with an emoji (a reaction)**

```jsonc
{ "memeplex": { "v": 1, "kind": "tag", "author": "did:cid:…dave",
                "grant": "did:cid:…dave-grant",
                "target": "did:cid:…alice-post", "targetVersion": "bafyreipost…",
                "tag": "❤️" } }
```

**rating**: three stars out of five

```jsonc
{ "memeplex": { "v": 1, "kind": "rating", "author": "did:cid:…carol",
                "grant": "did:cid:…carol-grant",
                "target": "did:cid:…paper", "targetVersion": "bafyreirev2…",
                "rating": 3, "min": 1, "max": 5 } }
```

**tag**: a community labeller marking a post

```jsonc
{ "memeplex": { "v": 1, "kind": "tag", "author": "did:cid:…spamwatch",
                "grant": "did:cid:…spamwatch-grant",
                "target": "did:cid:…some-post", "targetVersion": "bafyreispam…",
                "tag": "spam" } }
```

### Articles

A post with a `title` is an article: clients give it a long-form layout, with the
optional `subtitle` and `summary` on its card. Its body is usually `content` on IPFS.
Articles need no separate kind because nothing about them differs except the fields
they carry.

### Boosts and quote posts

A boost (repost) is a `post` whose `target` is the original:

- A **plain boost** has no `text` or `content`. Clients show the original as "Alice
  boosted".
- A **quote post** has a body, shown above the original.

`kind`, not `target`, decides thread membership: a thread shows `reply` objects, and
counts posts, ratings and tags that target it without listing them in it.
A boost shares the original with the booster's own audience. Its `target` lets
queries discover it alongside other responses, subject to the current-data limits
under Discovery queries. Boosting needs the `memeplex:post` action.

Quoting inside other text is an embed (see Text formatting): an essay that discusses
three posts embeds each where it discusses it. Embeds are not indexed by Gatekeeper, so
counting them needs an indexer.

### Ratings

A rating states its own scale, so clients can use 5 stars, 0–100 or thumbs up and
down, and ratings stay comparable:

```jsonc
{ "memeplex": { "v": 1, "kind": "rating", "author": "did:cid:…user",
                "grant": "did:cid:…grant",
                "target": "did:cid:…paper", "targetVersion": "bafyreirev2…",
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
- An author has one rating per target. Changing it is an edit, so the history stays
  visible; aggregators count each author's current attributed version once. Two
  clients can still each create a rating for the same author and target. So that
  independent indexers agree, first derive each object's publication state and
  exclude withdrawn objects. Select the remaining rating whose publication version
  was anchored latest, by its anchoring block's time, with
  ties broken by the smallest canonical `versionId`. Block times are set by the chain,
  not the signer, and stay comparable when the ratings were published under grants on
  different registries. An attributed deletion makes the next one by the same
  rule current; with none left, the author has no rating. Rating a
  new revision of the target is also an edit, which updates `targetVersion`; the
  earlier rating and the revision it rated remain in the history.
- Equal values are not equally precise: a 5-point scale and a 100-point scale cluster
  differently. Aggregators that care can group by `max − min`.

A like is a reaction ("I appreciate this"); a `rating` judges quality.

### Reviews

A reply with a `verdict` is a review. It sits in the thread like any reply, so it can
be answered there, and clients may also list a target's reviews separately. A
reviewer who also wants to score publishes a separate `rating`.

### Tags and reactions

An object's author describes it with the `tags` field inside the object. Anyone else
labels it, or reacts to it, with a `tag` object whose `target` is the object:

```jsonc
{ "memeplex": { "v": 1, "kind": "tag", "author": "did:cid:…labeller",
                "grant": "did:cid:…grant",
                "target": "did:cid:…post", "targetVersion": "bafyrei…",
                "tag": "cryptography" } }
```

A tag value is any string of 1–64 code points. Validity stops there: whether a value
is well formed is a matter of presentation, not authorship, so it never depends on a
verifier's Unicode data.

- **Publishers normalize.** Clients publish a **word** as lower-case NFC with internal
  whitespace collapsed to a single hyphen, so one tag does not splinter across
  spellings, and a **reaction** as exactly one fully-qualified emoji from Unicode's
  recommended (RGI) set, as listed in `emoji-test.txt` (`❤️`, not `❤`). The `tags`
  field takes words.
- **Readers classify and group.** An indexer or client decides whether a value is a
  reaction (one emoji) or a label (anything else), and normalizes values when
  counting, using the Unicode data it has. A value it cannot classify, such as an
  emoji newer than its data, shows as text. How to group skin-tone variants is also
  the reader's choice (see Memepool for its choice).
- **Counted once per author.** An author can apply several values to one object, but
  each value, as the reader normalizes it, counts at most once per author and object,
  even if two clients each published it.

Indexers on different Unicode releases may count a brand-new emoji differently;
authorship is the same everywhere.

#### Custom emoji

A tag with an `image` is a **custom emoji** reaction, like Slack's `:catjam:` or
Nostr's NIP-30 emoji:

```jsonc
{ "memeplex": { "v": 1, "kind": "tag", "author": "did:cid:…dave",
                "grant": "did:cid:…dave-grant",
                "target": "did:cid:…post", "targetVersion": "bafyrei…",
                "tag": ":catjam:",
                "image": "did:cid:…catjam?versionId=bafyrei…" } }
```

- **`tag` carries the shortcode,** by convention `:name:`. A client without custom
  emoji support shows it as text, which still reads.
- **`image` is a version-pinned image asset,** so the picture cannot change after
  the fact and is fetched from IPFS, not from a host that would learn who is reading.
- **Readers group custom emoji by image, not shortcode.** There is no global
  namespace: two communities' `:catjam:` can be different pictures, and one picture
  can have two names.
- **Custom emoji have tighter rendering limits** than other images (see Text
  formatting: Rendering budgets).

Shared emoji packs, which map a community's shortcodes to images so users can pick
from a set, are a client feature built on `image`; they need no protocol change.

Word tags are signed, attributed judgments like any other object, so their
weight depends on who applied them. Moderation labels are tags too (see Memepool:
Moderation).

### Content and size

Inline `text` is for content that fits comfortably inside one operation. Larger
Markdown bodies go to IPFS and are referenced from `content`; binary data uses image
assets or the paper's download fields. Updating the
content of an article is a normal update that replaces the reference; the old
reference stays in the previous version.

### Coauthors

Attribution covers only `author`, the DID that published the paper. The other DIDs in
`authors` are the publisher's **claim**. A listed coauthor confirms it by publishing a
`tag` with the value `coauthor` on the paper, with `targetVersion` set to the revision
they stand behind. Clients show a listed coauthor as confirmed for a revision only
when such an attributed tag pins that exact revision. A tag on an earlier revision is
shown as such ("confirmed v2"), never as confirmation of a later one, because the
publisher can change the paper while keeping the coauthor listed. Otherwise the
coauthor is shown as "listed by the publisher". An attributed deletion withdraws
the tag; an attributed edit can move its confirmation to a new revision. Read the
tag's publication state in both cases.

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
    carry script. `createImage` records JPEG files as `image/jpg`; renderers read that
    as `image/jpeg` before applying this list, without changing the signed asset.
  - **Size:** at most 10 MB per image. The asset's `bytes` is the publisher's claim,
    so clients use it only to reject early, count bytes while downloading, and abort
    past the limit before buffering or decoding the whole image.
  - **Alt text** is expected to be non-empty. Clients may flag images without it.
- **Rendering budgets.** Every object is untrusted input, so clients bound the work
  before fetching or rendering, and fall back to a link or a truncated view with a
  "show more" link when a budget is exceeded:
  - **Body:** a `content` body is fetched only if its declared `bytes` is at most
    1 MB, counted while downloading and aborted past that.
  - **Embeds:** at most 20 embeds per object are expanded; the rest show as links.
    An embedded object's card shows its own text with its embeds as links, so
    expansion is one level deep and cannot recurse.
  - **Images:** besides the 10 MB download limit, the asset's declared width × height
    is at most 40 megapixels and is checked against the decoded header before full
    decoding; animated images are limited to 100 frames.
  - **Custom emoji:** an `image` on a tag is at most 256 KB and 128 × 128 pixels,
    checked the same way; animation is allowed within the frame limit.
  - **Aggregate:** at most 50 MB fetched to render one object and its embeds.
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

## Archon mapping

These primitives exist in `packages/keymaster/src/keymaster.ts` and the
Gatekeeper API. The Memeplex verifier and client are still to be implemented.

| Need | Primitive |
|---|---|
| Create a grant or publication | `createAsset(data, { registry, controller })`; create on the grant's chain registry. |
| Edit | `updateDID` / `mergeData`; each operation produces another version. |
| Withdraw or revoke | `revokeDID`; Memeplex interprets the deletion through its attribution rule. |
| Read history | `exportDIDs` and `resolveDID` with `versionId`; earlier versions remain resolvable while accepted. |
| Store content | IPFS through the Gatekeeper data API; `createFile` stores `{ cid, filename, type, bytes }`. |
| Store an image | `createImage`; the asset has `file` and `image` data. |
| Publish a schema | `createSchema`; the protocol pins its schema DID and version. |
| Discover activity | `GET /api/v1/events`; reconcile over the full range for completeness. |
| Query current data | `POST /api/v1/query`; a discovery shortcut, not a complete publication index. |

Archon also supports `transferAsset` and `changeRegistry`. Using either on a
publication ends attribution for that version and its successors. They are not
Memeplex migration mechanisms. Attribution never uses `versionTime` as a grant
cutoff, even though Archon supports historical resolution by time.

## Grant request flow

1. The client creates its agent DID and a **grant request**:

   ```jsonc
   { "memeplexGrantRequest": { "v": 1,
                               "client": "did:cid:…client",
                               "name": "Memepool",
                               "actions": ["memeplex:post", "memeplex:reply", "memeplex:tag"],
                               "nonce": "Qm9vdHN0cmFwIG5vbmNlMTIz" } }
   ```

   `nonce` is at least 128 random bits, base64url-encoded. The client presents the
   request as a **grant link**, following the `archon://` deep links Archon wallets
   already handle (`archon://auth?challenge=…`, `archon://accept?credential=…`):

   ```text
   archon://grant?request=<base64url(request JSON)>
   ```

   - `request` is the UTF-8 JSON above, base64url-encoded without padding. The whole
     link is at most 2,048 characters, which keeps it scannable as a QR code; a
     typical request is about 330.
   - The client shows the link as a QR code for a wallet on another device, as a
     clickable link for a wallet on the same device (the browser extension or the
     mobile app), and as copyable text that the wallet accepts when pasted.
   - The request travels inline, so presenting it needs no network call and creates
     no DID. The wallet sends nothing back: the client finds the grant by query (step
     3).
   - A wallet rejects a link whose `request` does not decode, does not match the grant
     request schema, or is longer than the limit, and creates no grant.
2. The wallet shows the client DID, the claimed `name` (labelled as the client's own
   claim) and the requested scope: the listed actions, or every core kind when the
   request has no `actions`. The user approves it or a narrower subset and picks a
   permitted registry, and the wallet creates the grant there with that scope and the
   request's `client` and `nonce`.
3. The client finds the grant with a query for `memeplexGrant.client` (see
   Discovery queries), keeps the one carrying its nonce, waits until it is anchored,
   and checks the grant against the core authorization rules. The grant's creator
   is the user. Anyone who saw the request could create
   a grant with the same nonce from a different DID, so the client shows the user's
   identity and asks for confirmation before publishing.
4. The client names the grant's DID as `memeplex.grant` in every object it publishes
   for that user, and creates each object on the grant's registry. Its Gatekeeper
   must support that registry.

A client may hold grants from several users (a shared device, or a service publishing
for many people); the `author` and `grant` fields keep them apart.

## Discovery queries

Gatekeeper keeps an in-memory index of every DID's `didDocumentData`, and
`POST /api/v1/query` matches a path against a list of values. That index does not
cover the controller, which is why objects carry `author` in their data.

| Question | Query |
|---|---|
| Everything by a user | `{ "where": { "memeplex.author": { "$in": ["did:cid:…user"] } } }` |
| Every response to an object | `{ "where": { "memeplex.target": { "$in": ["did:cid:…"] } } }` |
| Objects under one grant | `{ "where": { "memeplex.grant": { "$in": ["did:cid:…grant"] } } }` |
| Grants naming a client | `{ "where": { "memeplexGrant.client": { "$in": ["did:cid:…client"] } } }` |
| Objects an author tagged | `{ "where": { "memeplex.tags[*]": { "$in": ["cryptography"] } } }` |
| Tags others applied (their `target`s are the tagged objects) | `{ "where": { "memeplex.tag": { "$in": ["cryptography"] } } }` |

A thread is loaded by repeating the `target` query one level at a time, keeping
`reply` objects (subject to the limit below); an indexer builds complete thread trees
directly. Objects carry no separate thread-root field to keep consistent.

Only one condition and only `$in` are supported, so a client separates boosts
(posts), replies, ratings and tags by `kind` after the query, and reviews and
reactions by their fields. Results are unsorted and unpaged, and they are not
attributions: the matches still have to pass the attribution check, because anyone
can write any `author` into an object they publish.

These queries match **current** data, so they are incomplete. An object whose latest
version is an unattributed deletion or edit (by a revoked client, for example) may
no longer match, even though its publication state is its last attributed version. A
thread or timeline built from queries can therefore miss such objects. Complete
results need history-based discovery from the events feed, as the indexer does.

## Memepool

Memepool is the first client and indexer. These choices do not bind other clients.

### Reactions

Memepool offers no skin-tone picker, and counts and renders every reaction as its base
emoji: the fully-qualified RGI emoji that Unicode's `emoji-test.txt` lists as the
untoned form of the reaction's `tag`. Removing the modifier code points is not
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

Memepool follows the core's
[history-based discovery and publication rule](memeplex-1436.md#a-graph-anyone-can-reconstruct).
It builds timelines, thread trees, search, counts and per-tag feeds, and serves
those views over HTTP behind Drawbridge. Other indexers may rank them differently.

### Moderation

There is no central moderator. Viewers choose which judgments to apply:

- **Labels are tags.** A community labels an object ("spam", "misleading",
  "nsfw") by publishing a `tag` object from its own DID. A client applies the tags
  from the labellers its reader trusts and ignores the rest, so moderation needs no
  separate mechanism. Block lists of DIDs remain credentials issued by those
  communities (as in #937).
- **Reviews** are replies, so a review's own reputation is visible: who wrote it, who
  replied, whether it was retracted.
- **Unattributed versions** are hidden or marked separately; an earlier attributed
  version remains the publication. A failed creation yields no publication.

### Wallet

The wallet lists active grants with their scope ("all core kinds" or the listed
actions) and expiry. It grants what a client requests, including any requested
`expiresAt`, unless the user narrows the scope or changes the expiry; lets the user
choose each grant's registry from the permitted mainnets; changes a grant's scope or
expiry in place with a scope update; and makes revoking a grant a single action. It shows a revocation in three states: **requested** (signed by the wallet),
**submitted** (accepted by a node for anchoring) and **effective** (the deletion is
anchored). Until it is effective, the wallet warns the user that the client can
still publish.

## Content availability

IPFS content is available only while someone pins it.
`ARCHON_GATEKEEPER_REGISTRIES_PIN` pins operation JSON, not the article, PDF or
image bytes referenced by an operation. Publishers, indexers or pinning services
must pin those separately. A reviewer who needs the assessed content to survive
retains its CID and pins it. Long-term preservation remains an open question.

A valid publication can exceed a renderer's automatic-fetch budget or have missing
content. Show an appropriate link or placeholder; neither condition grants or
removes authorship. Rendering untrusted material must follow the budgets and
safe-format rules above.

## Design choices

V1 uses public grant assets because third parties can read the user's signed
scope directly. Archon credentials are encrypted to their subjects and would
need an additional public representation for this purpose.

ZCAP and UCAN were considered. V1 needs one level of delegation, with evidence
resolved through Archon; it does not need delegation chains or an additional
capability proof format. The grant is already signed, versioned and revocable.

A revocation snapshot was also considered: the wallet could record the exact
versions it accepts when revoking, instead of requiring chain ordering. That
requires a complete inventory, including deleted objects, and durable availability
of the snapshot. Chain-based authority avoids that inventory at the cost of
anchoring latency. An indexer's first-seen time can inform its own heuristics but
cannot serve as independently verifiable authority.

Spam controls remain a client or service concern. A batch transaction spreads
anchoring cost over many objects; anchoring alone is not an effective rate limit.
Hosted publishing can impose costs or limits, and indexers can rank by trust.

## Scale

Every object, of every kind, is a DID; no kind is batched or stored differently. Each
object goes through Gatekeeper gossip, replay and the in-memory search index on every
node. CPU, memory, startup time and durable storage all grow with the workload.
Optimizations will come as volume requires them, as they have for startup replay.

A sizing benchmark establishes the starting point, on an isolated node with production-like Redis
persistence, in both Gatekeeper ports:

- create 1, 5 and 10 million Memeplex objects with a realistic mix (mostly short posts,
  reactions, ratings and tags, some replies, few articles), across a realistic number of
  authors;
- measure creation throughput, Hyperswarm propagation to a second node, mediator
  batch anchoring throughput on a chain registry, startup replay
  time, resolve latency, `query` latency for `author` and `target`, the memory
  used by the search index, and storage;
- compare startup against the current production dataset to separate per-object cost
  from fixed cost;
- run the application workload too: per-version attribution, re-verification after
  grant changes, full reconciliation, rebuilding a fresh indexer from scratch, and
  publication churn (edits, deletions and revocations at a realistic rate).

Acceptance targets for each measurement (latency, memory, rebuild time) are set before
the benchmark runs. The results size node hardware and show where optimization will be
needed first.

## Milestones

1. **Benchmark** objects-as-DIDs at the volumes above (Scale).
2. **Schemas:** JSON Schemas for every core kind and the grant, published as schema
   assets, with signed fixtures.
3. **Verifier library:** the attribution rules, shared by clients and the indexer, with
   cross-checks against real signed objects, including revoked and forged grants,
   transferred objects, backdated siblings, and unattributed edits and deletions after
   revocation (of ratings and coauthor confirmations in particular), and a fresh index
   rebuild that must match a continuously running one.
4. **CLI client:** create an agent DID as the client, grant it from the user's
   identity, then create, edit, delete and query objects on the grant's registry from
   the existing CLI and SDKs; this works with today's asset commands.
5. **Delegation:** wallet UI to create, list and revoke grants on a permitted registry.
6. **Indexer.**
7. **Memepool client.**
8. **Moderation:** block lists and labels.

## Open questions

- **Action vocabulary.** Is one action per creatable kind the right granularity, and
  should grants be able to narrow further (for example, replies only within one
  thread)?
- **Change feed.** Should Gatekeeper offer an arrival-ordered change feed? It would
  let indexers follow new and displaced versions directly, instead of reconciling
  periodically against full state.
- **Public follows.** Whether Memeplex should ever define a public follow list (see
  Memepool: Follows), and if so, where it lives.
- **Content availability.** Who pins long-form content and papers, and for how long?

## References

- ZCAP: [Authorization Capabilities v0.4.0](https://w3c-ccg.github.io/zcap-spec/) and
  UCAN: [specification](https://github.com/ucan-wg/spec), considered and not adopted
- #937: thin agent marketplace (attestations, opt-in block lists)
- #1044: encrypted messageboard where each post is a DID owned by its author
- #1299: historical verification of credential responses
- #1462 / #1463: Gatekeeper resolution by `versionId`
