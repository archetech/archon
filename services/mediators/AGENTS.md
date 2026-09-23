# Chain mediator batch imports

- An anchored batch DID commits to the signed create operation and its original ordered `batch.ops` list. Resolve the batch DID at `versionSequence: 1` when importing; never use latest batch-asset state to derive CIDs or `opidx`. Both Keymaster services support versioned `/did/:id`, while the TypeScript `/assets/:id` route does not forward resolution options. Keep missing genesis content retryable.
