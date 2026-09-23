# Chain mediator batch imports

- An anchored batch DID commits to the create operation's immutable bytes and original ordered `data.batch.ops` list. Fetch that operation through Gatekeeper `getJSON` using the DID's CID; accepted DID resolution (even version 1) depends on publisher history and can disappear after late controller evidence. Keep unavailable content retryable and authorize every contained operation through normal Gatekeeper import. Never derive CIDs or `opidx` from latest batch-asset state.
