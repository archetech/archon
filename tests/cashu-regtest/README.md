# Cashu on regtest Lightning

Drives both Keymaster flavors through their real CLI and services against real
Lightning: regtest CLN nodes, LNbits, Drawbridge, the DIDComm relay, and the mint on its
`cln` backend. It covers what the `fakewallet` backend in the CLI integration suite
cannot: real invoices and routes, real fees and change, and payments that stay in
flight or fail.

```sh
tests/cashu-regtest/run.sh                # builds the images, about 30 minutes in all
SKIP_BUILD=1 tests/cashu-regtest/run.sh   # reuses them
KEEP=1 tests/cashu-regtest/run.sh         # leaves the stack up for inspection
```

It is safe beside a running node. The stack has its own Compose project, network and
named volumes, publishes no ports, and tags its images `cashu-regtest/*` rather than
`ghcr.io/archetech/*`. It needs Docker, `jq` and Python 3. It is not part of CI.

Remove the images with
`docker images --format '{{.Repository}}:{{.Tag}}' | grep '^cashu-regtest/' | xargs docker rmi`.

`scenarios.py` exits non-zero if any check fails. It reports
[cdk#2836](https://github.com/cashubtc/cdk/issues/2836) as a known issue rather than a
failure: on this mint, a payment that fails after being attempted stays `PENDING`, with
its proofs reserved. The exemption needs the mint's node to report a failed attempt and
the mint to report `PENDING`. It checks that no value is lost there, and says so if a
newer mint has started releasing them, which needs the mint to report the quote `UNPAID`.

## Paying the node with ecash

The last scenarios pay Drawbridge's paywall with ecash (NUT-24, #1596). The stack runs
the node's Drawbridge twice more with the paywall on, `drawbridge-paid-ts` and
`drawbridge-paid-py`, each redeeming what it is paid through that Keymaster flavor. The
Keymasters themselves keep using the open Drawbridge, as a node's own services do.

`agent.mjs` is the client: an agent that registers a new DID through the paywall. It
posts the signed operation and gets HTTP 402 with a Cashu payment request, asks its
Keymaster what the request costs (`decodeCashuRequest`), has it pay from the agent's
ecash (`payCashuRequest`), and posts again with the token in `X-Cashu`. Each flavor pays
a node run by the other. The scenario then checks that:

- the 402 offered both Lightning and Cashu, and the request named the price and the
  node mint;
- the DID is registered, the node's wallet holds the price, and the agent's send
  settled;
- the node recorded a Cashu payment;
- the same token again, and a token for less than the price, are each refused with
  `400` and pay the node nothing, and the agent reclaims the one that was never
  redeemed.

With the stack left up by `KEEP=1`, the agent runs by hand:

```sh
docker compose -p cashu-regtest -f tests/cashu-regtest/compose.yml exec \
    -e ARCHON_KEYMASTER_URL=http://keymaster-ts:4226 cli \
    node agent.mjs http://drawbridge-paid-py:4222 <an identity with ecash>
```

`hold.sh` is a CLN plugin on the payee node that holds or fails incoming payments on
demand, which is how a melt stays really `PENDING`. It records each payment it sees, so
a scenario can wait for the payment to arrive before acting on it.
