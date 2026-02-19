# Indexed Backfill/Tail (Phase 1)

This phase adds a canonical event index layer while keeping existing command outputs unchanged.

## What is added

- `index_streams`, `index_cursors`
- `backfill_jobs`, `backfill_windows`
- `chain_events` (canonical raw event store)
- Workers:
  - `jobs/indexBackfill.js`
  - `jobs/indexTail.js`
  - `jobs/deriveNftStateFromEvents.js`

## Stream model

Phase 1 auto-registers `Transfer(address,address,uint256)` streams for enabled `LP_NFT` and `LOAN_NFT` contracts.

`stream_key` format:

- `<CHAIN_ID>:<contract_key>:Transfer`

Examples:

- `FLR:enosys_lp:Transfer`
- `XDC:example_loans:Transfer`

## Run order

1. Register/sync streams + backfill selected history.
2. Derive `nft_transfers` / `nft_tokens` from canonical `chain_events`.
3. Optionally run tail continuously.
4. Run validation scripts.

## Commands

Backfill all transfer streams:

```bash
node jobs/indexBackfill.js
```

Backfill one contract key from explicit range:

```bash
node jobs/indexBackfill.js --chain=FLR --contract-key=enosys_lp --from=32000000 --to=32005000
```

Tail enabled streams near head (with overlap):

```bash
node jobs/indexTail.js
```

Derive ownership state from indexed events:

```bash
node jobs/deriveNftStateFromEvents.js
```

Derive only one contract/stream:

```bash
node jobs/deriveNftStateFromEvents.js --chain=FLR --contract-id=1
node jobs/deriveNftStateFromEvents.js --stream-id=2
```

## Validation

Cursor continuity / gap checks:

```bash
node dev/validateCursorContinuity.js
```

Duplicate key checks:

```bash
node dev/validateEventDuplicates.js
```

Backfill boundary checks:

```bash
node dev/validateBackfillBoundaries.js
```

Coverage summary by stream:

```bash
node dev/coverageSummary.js
```

Shadow diff (canonical events vs derived NFT state):

```bash
node dev/shadowDiffNftState.js --chain=FLR --contract-key=sparkdex_lp_v4
```

Shadow diff (legacy cursor vs indexed cursor/event progress):

```bash
node dev/shadowDiffCursors.js --chain=FLR --contract-key=sparkdex_lp_v4
```

## Daily Integrity Runner

Run all core validation + shadow-diff checks in one pass:

```bash
node jobs/indexDailyIntegrity.js
```

Or via npm:

```bash
npm run -s index:integrity
```

Outputs:

- `data/metrics/index-integrity-latest.json` (latest one-run summary)
- `data/metrics/index-integrity-runs.jsonl` (append-only history)

Each step is logged as `OK`/`FAIL` with elapsed ms. The process exits non-zero on any failed step.

## Notes

- Writes are idempotent on `(chain_id, tx_hash, log_index)` in `chain_events`.
- Workers write per-window outcomes to `backfill_windows` for retry/error visibility.
- Existing command readers still use snapshot tables; no command behavior changes in this phase.
