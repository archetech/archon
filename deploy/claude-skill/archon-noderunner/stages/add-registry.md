# Stage: `add-registry <CHAIN:net>`

Add a chain-writer mediator to the node.

## Valid chains
- `BTC:mainnet`
- `ZEC:mainnet`
- `ETH:mainnet`
- `SOL:mainnet-beta`

## Procedure

1. **Announce** what will change: which mediator + wallet containers, which `.env` keys, which compose profile.

2. **Back up** `.env`.

3. **Prompt** the operator:
   - RPC endpoint for the chain (own node URL, Alchemy/Infura key, or public default)
   - `ARCHON_<CHAIN>_START_BLOCK` (current chain tip minus a small margin, unless they want to backfill history)
   - Any chain-specific config from the archon `.env.example` (fee ceilings default OK)

4. **Splice** the chain's config keys into `.env`. Add the profile to `COMPOSE_PROFILES` idempotently. Add the chain to `ARCHON_GATEKEEPER_REGISTRIES_PIN` (comma-separated, dedup).

5. **Build & bring up** the new services (`docker compose build <chain>-mainnet-mediator <chain>-mainnet-wallet`, then `up -d`).

6. **Wait** for the mediator to complete its first import cycle. Then read the writer wallet's funding address from the log (`Send <CHAIN> to <addr>` line).

7. **🛑 Human checkpoint — funding.** Print:
   - Deposit address
   - Suggested top-up: **10× the fee ceiling** for the chain
     - BTC: `ARCHON_BTC_FEE_MAX` × 10 sat
     - ZEC: `ARCHON_ZEC_FEE_MAX` × 10 ZEC
     - ETH: `ARCHON_ETH_MIN_GAS_BALANCE_WEI` × 10 wei
     - SOL: `ARCHON_SOL_MIN_BALANCE_LAMPORTS` × 10 lamports
   - Wait for the operator to broadcast a funding tx; ask for the txid.
   - Poll the tx for confirmation (mempool.space / RPC).
   - Watch the mediator log for the first `Transaction broadcast` (or equivalent) line — that confirms the writer is live.

8. **Verify** `/api/v1/registries` now includes the new registry. May take a full import cycle after funding.

9. **Report** — writer address, current balance, tx headroom, first anchor txid.

## Rollback

If funding fails or the operator wants to back out before confirming: `remove-registry <CHAIN:net>` restores the pre-add `.env` from backup, tears down the two new containers, preserves the wallet DB in `data/` for recovery.

## Cross-cutting rule

Per feedback_funding_red_alert.md: **insufficient funds is a RED ALERT**. The `status` and `health-check` commands must probe every enabled writer wallet and surface funding gaps as critical, not observational.
