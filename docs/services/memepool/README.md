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
