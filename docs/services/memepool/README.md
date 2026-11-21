# Memepool service

Memepool is a Memeplex client: an agent DID that publishes for the users who grant
it. This service holds that DID's key. A user's own key stays in their wallet.

A user does two things with a wallet, once each:

1. **Signs in.** The service issues a challenge, the wallet answers it, and the
   service knows which DID it is talking to.
2. **Grants the service.** The service shows a grant link naming its own DID; the
   wallet creates the grant from the user's identity.

From then on the service publishes what the user writes, as objects it creates on
the grant's registry, naming the user as author. The user ends this at any time by
revoking the grant in the wallet.

Reading is not this service's job. Timelines and threads come from the
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
| `POST /login` | Takes `{ "response": "did:cid:…" }`, the wallet's answer. Sets the session cookie and returns the DID signed in |
| `POST /logout` | Ends the session |
| `GET /me` | The DID signed in, with its `grant` and `registry` (and any `others` in force), or with the grant `link` to show and any grants still `pending` |
| `POST /objects` | Publishes an object. Takes its fields, with `kind`; returns its `did` |
| `PUT /objects/:did` | Replaces one of the user's objects with another version |
| `DELETE /objects/:did` | Withdraws one of the user's objects |

The service states an object's `v`, `author` and `grant` itself, from the session
and the grant, whatever the request carries.

| Status | Meaning |
|---|---|
| 400 | The object is not valid, an edit would change what the object is, or the object was not published under a grant of the user's that is in force |
| 401 | Not signed in, or the answer is not one this service takes (see Sessions) |
| 403 | The user has no grant to publish under: none, one not yet anchored, or one revoked or expired |
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
can tell is wrong before creating anything. It does not check an object's kind
against the grant's actions: an object of a kind the grant does not allow is
created and is not attributed.

## Running it

Add `memepool` to `COMPOSE_PROFILES`, and `memeplex` for the indexer its readers
use, and set `ARCHON_MEMEPOOL_WALLET_PASSPHRASE`. The service listens on port 4237,
on the host's loopback address unless `ARCHON_MEMEPOOL_HOST_BIND` says otherwise.

| Setting | Default | Meaning |
|---|---|---|
| `ARCHON_MEMEPOOL_WALLET_PASSPHRASE` | none | Encrypts the service's wallet. The service does not start without it |
| `ARCHON_MEMEPOOL_NAME` | `memepool` | The name of the service's identity, and the name it gives in a grant request |
| `ARCHON_MEMEPOOL_REGISTRY` | `hyperswarm` | The registry the service's own identity is created on |
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
its API is at `<node>/memepool/api/v1`. Drawbridge sets the service's cookies for
`/memepool`, so a browser sends them to Memepool and to nothing else on the node's
host, and it limits how often one source reads and writes (see the
[Drawbridge](../drawbridge/README.md) rate limits).

When the node is served over HTTPS, by a proxy that ends TLS in front of
Drawbridge and sends `X-Forwarded-Proto`, set `ARCHON_MEMEPOOL_TRUSTED_PROXIES=1`.
The service then marks its cookies `Secure`, so that a browser never sends them
over plain HTTP.

