# filecoin-mediator

Autonomous background agent that monitors the filecoin-wallet service and re-pins any failed operations. Part of the Archon Filecoin storage layer.

## What it does

Runs on a configurable interval and performs a repair cycle:

1. Fetches all pin records from the filecoin-wallet service
2. Identifies any with `status: failed`
3. Removes the failed record
4. Re-submits the CID for pinning

This makes the system self-healing — transient Filecoin network or payment failures are automatically retried without user intervention. Follows the OpenClaw mediator pattern: a narrow, single-purpose agent that owns one remediation task.

## Configuration

| Variable | Description |
|----------|-------------|
| `ARCHON_FIL_WALLET_URL` | filecoin-wallet base URL (default: `http://localhost:4242`) |
| `ARCHON_ADMIN_API_KEY` | Admin key for filecoin-wallet delete endpoint |
| `ARCHON_FIL_EXPORT_INTERVAL` | Repair cycle interval in ms (default: `60000`) |
| `ARCHON_FIL_MEDIATOR_PORT` | HTTP port for mediator health/metrics (default: `4244`) |
| `ARCHON_FIL_MEDIATOR_METRICS_PORT` | Prometheus metrics port (default: `4245`) |

## Run

```bash
npm install
npm run dev     # tsx (development)
npm run build   # compile to dist/
npm start       # node dist/filecoin-mediator.js (production)
```

## Relationship to filecoin-wallet

```
react-wallet  ──POST /anchor──►  filecoin-wallet  ──Synapse──►  Filecoin
                                       │
                              filecoin-mediator
                              (polls, repairs failed pins)
```

The happy path (user toggles Filecoin on, DID operations get pinned) runs entirely through the filecoin-wallet. The mediator only activates when a pin fails.
