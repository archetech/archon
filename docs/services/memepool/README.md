# Memepool service

Memepool is a Memeplex client: an agent DID that publishes for the users who grant
it. This service holds that DID's key. A user's own key stays in their wallet.

A user does two things with a wallet, once each:

1. **Signs in.** The service issues a challenge, the wallet answers it, and the
   service knows which DID it is talking to.
2. **Grants the service.** The service creates a grant request, an asset of its own
   as a challenge is, and shows a grant link naming it (`archon://auth?grant=<DID>`),
   which a wallet opens, scans or is given pasted; the wallet resolves the
   request, reads from it that the service is asking, and creates the grant from the
   user's identity. A session is shown one request, which lasts an hour, and a new
   one when that nears its end.

The request lists the registries the service can publish on: the permitted ones
its node supports. A wallet offers the user those, so the grant is one the service
can use, and the service does not take a grant on any other as one to publish under. On a
node that supports none of them the service asks for no grant, and `GET /me` says why
in `unavailable`.

From then on the service publishes what the user writes, as objects it creates on
the grant's registry, naming the user as author. The user ends this at any time by
revoking the grant in the wallet.

The service also serves Memepool's pages, as files, beside its API. Reading is not this service's job. Timelines and threads come from the
[indexer](../memeplex-indexer/README.md).

The rules are in [the Memeplex plan](../../plans/memeplex-1436.md) and its
[reference](../../plans/memeplex-reference-1436.md).

## API

All routes are under `/api/v1`. Those after the sign-in routes need a session.

| Route | Answer |
|---|---|
| `GET /ready` | `true` |
| `GET /version` | The service's version and commit |
| `GET /config` | The service's name and its DID, which is the client a grant names |
| `GET /challenge` | A challenge, and the `archon://auth?challenge=…` link that hands it to a wallet |
| `POST /callback` | Where a wallet sends `{ "response": "did:cid:…" }`, its answer, when the challenge names this as its callback. Signs nobody in: the answer is kept for the browser that asked |
| `POST /login` | Signs in the browser that asked for the challenge. With `{ "response": "did:cid:…" }` it takes the answer directly. With no body it asks whether a wallet has sent an answer to the callback: `202` with `{ "waiting": true }` until one has, then `{ "answered": "did:cid:…" }`, which is who answered and not yet a session. With `{ "confirm": "did:cid:…" }` naming that identity it signs the browser in. Sets the session cookie and returns the DID signed in |
| `POST /logout` | Ends the session |
| `GET /me` | The DID signed in, with its `grant` and `registry`, any `others` in force, and the `actions` those grants allow when every one of them is narrowed; or with the grant `link` to show and any grants still `pending`; or, on a node with no registry a grant may be on, with `unavailable` saying so in place of a link |
| `POST /objects` | Publishes an object. Takes its fields, with `kind`, and for an article its `body`; returns its `did` |
| `PUT /objects/:did` | Replaces one of the user's objects with another version |
| `DELETE /objects/:did` | Withdraws one of the user's objects |
| `GET /objects/:did/content` | The body of an article the service published, as `text/markdown`: of its latest version, or of the one `?versionId=` names |
| `GET /identities/:did` | What an identity says of itself: `{ did, name?, address? }`, with the address only when its domain confirms it |
| `GET /avatars/:did` | An identity's avatar, as the image it is, or 404 when it has none the service serves |

The service states an object's `v`, `author` and `grant` itself, from the session
and the grant, whatever the request carries.

### Names and addresses

An identity's document may carry a `name` and an `address`, which is where a wallet
puts them. `GET /identities/:did` passes them on, so that the pages can say who an
author is beside the DID.

- **A name is a claim.** Any identity can give itself any name, and nothing checks
  one. It is passed on shortened to 64 characters, with nothing in it but what is
  printed, and the pages always show the DID beside it.
- **An address is passed on only when its domain confirms it.** An address such as
  `alice@example.org` is a name that `example.org` gives out, so the service asks
  that domain whose it is (`/.well-known/names/alice`, as Keymaster's
  `check-address` does) and passes it on when the answer is this identity's DID.
  One the domain gives to another, to nobody, or does not answer for within five
  seconds is left out.
- **An address is a name at a host name**, in lower-case letters, digits and the
  marks `. _ + -`. One with anything else in it is not asked about or shown: a
  character that turns text about, or a letter that looks like another, makes an
  address at one domain read as an address at another.
- **What is found out is kept ten minutes**, so a domain is asked once in a while
  however many posts an author has. The request is one that reaches no address
  inside the service's own network, is ended after five seconds, and has no more
  than 16 KiB of its answer read.
- **It is for a user who has signed in**, since it has the service ask a domain a
  stranger chose.

### Avatars

An identity's avatar is the image asset its document names as `avatar`, which is
where a wallet puts one. `GET /avatars/:did` serves it, so that the pages can show
an author's beside what the author wrote, from their own origin.

It is whatever the identity's owner chose, and the service did not store it:

- **It is served only as an image**: AVIF, GIF, JPEG, PNG or WebP, with a header
  that tells a browser to take it for nothing else. SVG is refused, being a document
  that can hold a script.
- **It may be 1,000,000 bytes.** One whose asset says it is larger is not read, and
  one that says it is smaller is read no further than that.
- **The node is given ten seconds to find it**, since bytes it does not have are
  looked for on the network.
- **It is for a user who has signed in**, as publishing is: reading one has the node
  look for bytes a stranger named.

Anything else is a 404, and the pages show a figure in the avatar's place.

### Content

The client that publishes an object pins the content the object refers to, so this
service stores the content of what it publishes and takes none on trust.

- **An article is sent with its text**, as `body` beside the fields of a post or a
  paper: `{ "kind": "post", "title": "…", "summary": "…", "body": "# …" }`. The
  service adds the text to its node's IPFS, which pins it, and publishes the entry
  with `content: { cid, type: "text/markdown", bytes }` in place of the body. A body
  may be 200,000 bytes.
- **It takes no reference to content it has not stored.** A request that carries
  `content`, `pdf` or `source` is refused, since those would be bytes the service
  never saw and does not keep. An edit may send back the reference the entry already
  has, to leave its body as it is, or a new `body` to replace it.
- **It reads the body of what it published, and no other.** `GET /objects/:did/content`
  answers 404 for an entry the service did not create: such an entry can refer to
  anything, of any size. That includes one that was created elsewhere and then
  transferred to the service, which an asset's owner can do to any identity. A reader
  asks for the body of the version it is showing, with `versionId`, since the latest
  version may be an edit that is not anchored yet.
- **It stores a body only for an object it would publish.** The object is checked
  first, with the grant's scope and what an edit may change, so that a request it
  refuses leaves nothing pinned.
- **It keeps what it stores.** Content stays on the node for as long as the node's
  IPFS keeps it. Withdrawing an article or replacing its body removes nothing: the
  entry's earlier versions still refer to the earlier body.

A paper's PDF and source are files, which the service does not take yet.

| Status | Meaning |
|---|---|
| 400 | The object is not valid, an edit would change what the object is, or the object was not published under a grant of the user's that is in force |
| 401 | Not signed in, or the answer is not one this service takes (see Sessions) |
| 409 | More than one identity answered the challenge |
| 403 | The user has no grant to publish under (none, one not yet anchored, or one revoked or expired), or none that allows this kind of object |
| 429 | The service has issued as many challenges this minute as it is set to |
| 502 | The node did not accept the operation |

## Sessions

A session is a random token in a cookie that scripts cannot read and that is sent
only on requests from the service's own pages (`HttpOnly`, `SameSite=Strict`).

An answer signs a browser in when all of these hold:

- it answers a challenge this service issued, that has not lapsed and has not been
  answered before;
- it comes from the browser that asked for that challenge, which the service marks
  with a second cookie. A wallet publishes its answer as an asset whose DID anyone
  can see, so the DID alone must not be enough;
- the answer is given as a DID, and is still as its author created it. The owner of
  an asset can replace its contents and hand it to any identity without that
  identity's consent, so only an answer at its first version shows who wrote it.

A wallet that sends its answer to the callback is not the browser, so the callback
signs nobody in. It keeps the answer, and the browser that asked for that challenge
collects the sign-in.

A challenge is an asset anyone on the network can see, and anyone can answer one. So
an answer at the callback does not sign the browser in by itself:

- the browser is told who answered, and the user confirms that identity is theirs
  before there is a session;
- when more than one identity has answered a challenge, nobody is signed in with it
  (`409`), and the user asks for another.

Someone who answers a user's challenge before the user does can therefore stop that
sign-in, and cannot become the user or put the user in their own account unnoticed.
The other way round, someone who asks for a challenge and persuades a user to answer
it is signed in as that user, as with any sign-in by a link. A wallet shows the
challenge's callback before it answers, and that is where the user sees whose
challenge it is.

The callback answers a wallet running in a browser on another origin. It is the only
route that does, and it allows no credentials.

Each challenge is an asset the node stores and gossips, and anyone can ask for one,
so the service issues a limited number a minute (60 unless set otherwise).
 Sessions and challenges are held in memory: a restart signs everyone out,
and nobody loses anything but the session.

The service keeps no record of its users or their grants. A user's grants are found
on the node, by who made them, each time they are needed. With more than one in
force, a new object goes under the earliest, and a change to an object goes under
the grant the object was published under: under any other it would not be
attributed.

## What publishing means

An object is a publication once the chain anchors it, and what the grant allowed
at that position decides whether it is attributed. The service refuses what it
can tell is wrong before creating anything: an object that is not valid, and one
of a kind the user's grants do not allow, which would be created and never
attributed. With several grants in force, a new object goes under the earliest
whose scope allows its kind.

## Running it

Add `memepool` to `COMPOSE_PROFILES`, and `memeplex` for the indexer its readers
use, and set `ARCHON_MEMEPOOL_WALLET_PASSPHRASE`. The service listens on port 4237,
on the host's loopback address unless `ARCHON_MEMEPOOL_HOST_BIND` says otherwise.

| Setting | Default | Meaning |
|---|---|---|
| `ARCHON_MEMEPOOL_WALLET_PASSPHRASE` | none | Encrypts the service's wallet. The service does not start without it |
| `ARCHON_MEMEPOOL_PUBLIC_URL` | none | Where users reach the service, such as `https://node.example/memepool`. With it, a challenge names the service's callback and a wallet sends its answer straight back. Without it, a user copies the answer from the wallet to the page |
| `ARCHON_MEMEPOOL_PAGES_DIR` | `public` | The built [pages](../../../apps/memepool/README.md), which the service serves beside its API. The image carries them. Empty serves none |
| `ARCHON_MEMEPOOL_NAME` | `memepool` | The name of the service's identity, and the name it gives in a grant request |
| `ARCHON_MEMEPOOL_REGISTRY` | `hyperswarm` | The registry the service's own identity is created on. Not `local`: the service does not start with that setting, or with a wallet whose identity is on `local`, since such an identity can publish only on `local` |
| `ARCHON_MEMEPOOL_PORT` | `4237` | The host port |
| `ARCHON_MEMEPOOL_HOST_BIND` | `127.0.0.1` | The host address the port is bound to |
| `ARCHON_MEMEPOOL_CHALLENGES_PER_MINUTE` | `60` | Challenges issued in a minute |
| `ARCHON_MEMEPOOL_SESSION_HOURS` | `24` | How long a session lasts |
| `ARCHON_MEMEPOOL_TRUSTED_PROXIES` | `0` | Proxies in front of the service. With one or more, cookies are marked for HTTPS only when the last proxy says the request arrived over HTTPS |

### The service's key

The service is the DID in its wallet, `data/memepool/wallet.json`. The repository carries `data/memepool`, so that the directory belongs to whoever checked it out and the service, which runs as that user, can write to it. If it is missing when the container starts, Docker creates it as root and the service cannot make its wallet: create it first, owned by `ARCHON_UID`. Every grant a
user has made names that DID. On a first start the service makes the wallet and the
identity, and says so in its log.

**Back the wallet up, with its passphrase.** A service started without them is a new
client, with a new DID, that nobody has granted: what it published before stays
attributed, and every user has to grant it again before it can publish for them.

### Through Drawbridge

With the `memepool` profile, Drawbridge offers the service at `<node>/memepool`:
its pages are at `<node>/memepool/` and its API at `<node>/memepool/api/v1`. Drawbridge sets the service's cookies for
`/memepool`, so a browser sends them to Memepool and to nothing else on the node's
host, and it limits how often one source reads and writes (see the
[Drawbridge](../drawbridge/README.md) rate limits).

When the node is served over HTTPS, by a proxy that ends TLS in front of
Drawbridge and sends `X-Forwarded-Proto`, set `ARCHON_MEMEPOOL_TRUSTED_PROXIES=1`.
The service then marks its cookies `Secure`, so that a browser never sends them
over plain HTTP.

