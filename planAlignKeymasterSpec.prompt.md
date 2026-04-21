## Plan: Align Keymaster Spec

Update the handwritten Keymaster service spec in `/home/david/archetech/archon/docs/services/keymaster/README.md` so it matches the live TypeScript server and SDK contract. Scope is README-only: fix confirmed request/response shapes, route semantics, and implementation claims that currently diverge from `services/keymaster/server/src/keymaster-api.ts`, `packages/keymaster/src/keymaster.ts`, and `packages/keymaster/src/keymaster-client.ts`, without changing code or generated OpenAPI artifacts.

**Steps**
1. Rework the HTTP-contract framing section in `/home/david/archetech/archon/docs/services/keymaster/README.md` to state the real envelope rule: most successful responses are wrapped, but the exact key is whatever the current client consumes; call out known exceptions and avoid over-generalizing boolean/create responses.
2. Update the wallet section in `/home/david/archetech/archon/docs/services/keymaster/README.md` so `PUT /api/v1/wallet` no longer documents `overwrite`, and `POST /api/v1/wallet/backup` reflects the current `ok: <backupDid>` behavior. Also adjust any surrounding prose that implies stronger type guarantees than the server currently exposes.
3. Correct the ID and DID route descriptions in `/home/david/archetech/archon/docs/services/keymaster/README.md`: `GET /api/v1/ids/:id` should describe DID resolution returning `{ docs }`, while the DID route family should keep its alias/name lookup semantics aligned with `keymaster.resolveDID`. This step depends on step 1.
4. Rewrite the addresses section in `/home/david/archetech/archon/docs/services/keymaster/README.md` to match live behavior: `GET /api/v1/addresses/:domain` returns the locally stored current-ID address record for that domain, and `GET /api/v1/addresses/check/:address` returns a flat `AddressCheckResult` object rather than `{ address: AddressCheckResult }`. This can run in parallel with step 3.
5. Fix the crypto helper and challenge/response sections in `/home/david/archetech/archon/docs/services/keymaster/README.md`: align `keys/sign` request fields with `contents`, `keys/verify` request/response with `json` and `{ ok }`, `GET /api/v1/challenge` with `{ did }`, and `/response` / `/response/verify` body fields with `challenge` / `response`. This can run in parallel with step 4 once step 1 is done.
6. Correct deeper implementation claims in `/home/david/archetech/archon/docs/services/keymaster/README.md` that would mislead a drop-in reimplementation, especially DID-write `proofPurpose` being `authentication` in current TS paths rather than the documented `assertionMethod`. Keep this limited to verified behavior in `packages/keymaster/src/keymaster.ts`.
7. Do a consistency sweep across `/home/david/archetech/archon/docs/services/keymaster/README.md` for repeated stale field names or envelopes such as `challengeDid`, `responseDid`, `{ id: ... }`, `{ verify: ... }`, and wrapped `AddressCheckResult` references. This depends on steps 2 through 6.

**Relevant files**
- `/home/david/archetech/archon/docs/services/keymaster/README.md` — only file to edit; update route tables, prose, and conformance claims.
- `/home/david/archetech/archon/services/keymaster/server/src/keymaster-api.ts` — authoritative HTTP request/response contract for route handlers.
- `/home/david/archetech/archon/packages/keymaster/src/keymaster.ts` — authoritative implementation semantics behind wallet backup, DID resolution, address handling, and proof creation.
- `/home/david/archetech/archon/packages/keymaster/src/keymaster-client.ts` — authoritative client-consumed keys and request field names; use this to avoid documenting envelopes the SDK does not actually use.

**Verification**
1. Re-scan `/home/david/archetech/archon/docs/services/keymaster/README.md` for the known stale markers: `overwrite?: boolean`, `challengeDid`, `responseDid`, `{ "id": IDInfo }`, `{ "address": AddressCheckResult }`, `{ "verify": boolean }`, and `assertionMethod` in DID-write flow descriptions.
2. Cross-check every changed route section against the corresponding handler in `/home/david/archetech/archon/services/keymaster/server/src/keymaster-api.ts` and the matching client call in `/home/david/archetech/archon/packages/keymaster/src/keymaster-client.ts`.
3. Verify that any route described as contractual in `/home/david/archetech/archon/docs/services/keymaster/README.md` uses the exact request-field names and response keys currently served by the TS implementation.
4. Confirm scope boundaries: no edits to `/home/david/archetech/archon/docs/keymaster-api.json`, Swagger comments in `/home/david/archetech/archon/services/keymaster/server/src/keymaster-api.ts`, or service code.

**Decisions**
- Included: README corrections that make the service spec match the live TypeScript implementation.
- Excluded: changing the TypeScript implementation, directly editing generated OpenAPI output, or reconciling Swagger drift outside the handwritten spec.
- Source of truth: prefer live TS behavior when the README and code disagree, consistent with `/home/david/archetech/archon/docs/services/keymaster/README.md` itself.

**Further Considerations**
1. After the README-only fix lands, a second pass should decide whether the Swagger source in `/home/david/archetech/archon/services/keymaster/server/src/keymaster-api.ts` should be updated and the generated `/home/david/archetech/archon/docs/keymaster-api.json` refreshed from that source to eliminate doc split-brain.
2. If any route behavior is clearly accidental but already shipped, document the shipped contract first in the README and handle behavioral cleanup separately as a code-change task.
