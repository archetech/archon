# Recovery Procedures

Multi-step operations for getting a node back after losing state. These are
procedures rather than symptoms — for "X is not working", see
[Troubleshooting](deployment.md#12-troubleshooting).

## Table of Contents

1. [Resyncing a reset gatekeeper database](#1-resyncing-a-reset-gatekeeper-database)
2. [A dead Tor hidden service](#2-a-dead-tor-hidden-service)

---

## 1. Resyncing a reset gatekeeper database

The gatekeeper's database can be rebuilt: DIDs anchored to a chain come back
when the mediators re-import them, and DIDs on `hyperswarm` come back from
peers. The wallet is untouched by any of this — it holds the keys, and the
gatekeeper holds only what those keys signed.

The catch is that the node cannot reach the resync on its own.

### Why the node cannot simply restart

`ARCHON_NODE_ID` names an identity in the wallet. On startup keymaster resolves
that identity's DID and only reports ready once it succeeds:

```
Waiting for gatekeeper to sync...
```

With the database reset, that DID no longer resolves, so keymaster never
becomes healthy. Every service that could repopulate the database —
the hyperswarm mediator, the chain mediators — waits on
`keymaster: condition: service_healthy`, so none of them start. The thing that
would fix the gatekeeper is gated behind the gatekeeper being fixed.

The way out is an identity the wallet has **never** seen. Keymaster creates a
missing node ID rather than waiting for it, and a freshly created DID resolves
against the local gatekeeper immediately.

### Procedure

1. **Note the current value** of `ARCHON_NODE_ID` in your `.env`. You are going
   to put it back.

2. **Set a temporary node ID** that has never been used on this node:

   ```
   ARCHON_NODE_ID=bootstrap-resync
   ```

3. **Bring the stack up.**

   ```
   docker compose up -d
   ```

   Keymaster creates `bootstrap-resync`, resolves it, and reports ready. The
   mediators start behind it.

4. **Wait for the resync.** The chain mediators re-import anchored batches from
   their first configured block, which takes as long as the chain scan takes;
   the hyperswarm mediator re-imports from peers. Progress is in the logs, and
   the gatekeeper's own view is:

   ```
   ./admin get-status
   ```

5. **Confirm the original identity is back** before switching:

   ```
   ./admin resolve-did <the original node DID>
   ```

6. **Restore `ARCHON_NODE_ID`** to the noted value and bring the stack up
   again. Keymaster finds the identity in the wallet, resolves it against the
   rebuilt database, and reports ready without creating anything.

### What looks broken during this, and is not

**Bitcoin and Zcash balances read zero while the temporary ID is set.** The
watch-only wallet name is derived from the node ID — `archon-watch-<nodeID>` in
Bitcoin Core, `archon-zec-<nodeID>` — so a temporary node ID points the wallet
service at a fresh, empty wallet. Nothing is lost: the descriptors are derived
from the wallet's seed, not from the node identity, and the original Core
wallet is still there under its original name. Restoring `ARCHON_NODE_ID`
restores the balances immediately. This coupling is tracked as
[#449](https://github.com/archetech/archon/issues/449).

### What this leaves behind

- The temporary identity stays in the wallet. `./archon remove-id
  bootstrap-resync` removes it once you no longer need it.
- An empty `archon-watch-bootstrap-resync` wallet (and the Zcash equivalent)
  stays loaded in the chain daemon. Harmless, and removable with Core's
  `unloadwallet`.

### When this does not apply

A DID created on the `local` registry was never published anywhere, so nothing
can bring it back — not a chain resync and not a peer. If the node's own
identity was created that way, a reset database cannot be repaired, and the
node needs a new identity. `ARCHON_DEFAULT_REGISTRY` decides this, and defaults
to `hyperswarm`.

---

## 2. A dead Tor hidden service

A node keeps advertising its `.onion` endpoint after the hidden service stops.
Drawbridge reads the onion hostname from a file on a shared volume and caches
the first success, and that file outlives the `tor` container — so
`GET /api/v1/didcomm-endpoint` keeps returning an address nothing is listening
on. Senders see:

```
DIDComm delivery to did:cid:... failed: 502 (TypeError: fetch failed)
```

Check the container is actually running, rather than trusting the advertised
endpoint:

```
docker compose ps tor
```

`Exited` here with a published onion endpoint is the failure. The usual cause
is `tor` missing from `COMPOSE_PROFILES`, which makes `docker compose up` skip
it silently. Add it, bring the stack up, and restart drawbridge so it re-reads
the hostname file.

This is tracked as [#915](https://github.com/archetech/archon/issues/915).
