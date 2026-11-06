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
its proofs reserved. It checks that no value is lost there, and says so if a newer mint
has started releasing them.

`hold.sh` is a CLN plugin on the payee node that holds or fails incoming payments on
demand, which is how a melt stays really `PENDING`.
