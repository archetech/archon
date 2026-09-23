# Chain mediator batch imports

- An anchored batch DID commits to the signed create operation and its original ordered `batch.ops` list. Resolve the batch DID at `versionSequence: 1` when importing; never use latest batch-asset state to derive CIDs or `opidx`. Both Keymaster services support versioned `/did/:id`, while the TypeScript `/assets/:id` route does not forward resolution options. Keep missing genesis content retryable.

- Reorg recovery must withdraw Gatekeeper receipts and block metadata before committing the new scan position, and prune discovered items in the same suffix so retry loops cannot reimport orphaned anchors. Verify that the checkpoint below the rewind range still belongs to the canonical chain; the configured depth alone does not establish that. Leave the old position intact on withdrawal failure.

- Solana imports must use finalized commitment for tips, signature discovery, parsed transactions, and block retrieval regardless of the outbound transaction commitment setting.

- Rewind exclusion must cover complete CID fetch/import requests, not just event processing or a queue snapshot. Test imports already in flight and arrivals during withdrawal; preserve retry behavior in both cases. Numeric block height zero must use `/0`, not `/latest`, in shared clients.
