# Chain mediator batch imports

- An anchored batch DID commits to the signed create operation and its original ordered batch list, exposed as `didDocumentData.batch.ops` in the genesis document. Use `gatekeeper.getGenesis(did)` for imports; it returns a genesis DID document, not a raw operation; this checks content identity/shape without controller authorization or history mutation. Do not use latest or versioned authorized DID resolution to interpret a batch anchor. Keep missing genesis content retryable and authorize every contained operation normally. The original signed operation remains retrievable by CID as provenance, not treated as an authorization verdict by retrieval (#1269).

- Reorg recovery must withdraw Gatekeeper receipts and block metadata before committing the new scan position, and prune discovered items in the same suffix so retry loops cannot reimport orphaned anchors. Verify that the checkpoint below the rewind range still belongs to the canonical chain; the configured depth alone does not establish that. Leave the old position intact on withdrawal failure.

- Solana imports must use finalized commitment for tips, signature discovery, parsed transactions, and block retrieval regardless of the outbound transaction commitment setting.

- Rewind exclusion must cover complete CID fetch/import requests, not just event processing or a queue snapshot. Test imports already in flight and arrivals during withdrawal; preserve retry behavior in both cases. Numeric block height zero must use `/0`, not `/latest`, in shared clients.

- Genesis retrieval must validate cached operation shape and DID identity before accepting a cache hit. CID ingress can retain retrieval aliases, so an invalid cache hit must retry IPFS without rewriting historical aliases. Cover recovery through ordinary CID ingress with a corrected upstream response.

- Ethereum discovery, checkpoint sync, and persisted batch retries must use the RPC finalized boundary, with no latest/safe/confirmation-depth fallback. Keep legacy suffix withdrawal limited to the one-time finalized-import transition; later finalized-history rollback stops imports. Outbound mined-transaction tracking remains independent of import finality.
