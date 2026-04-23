# LP History DB Plan

This document describes the recommended architecture for historical LP transaction reporting without bloating or stalling Sentinel's main monitoring DB.

## Goal

Support historical LP reporting for Datum, such as:

- `/all-lp-tx`
- CSV exports of LP adds/removes/claims
- grouped pair/protocol summaries

without:

- making Sentinel's main DB huge
- forcing multi-day production backfills
- making the monitoring bot stale while history catches up

## Recommendation

Use a **separate LP history SQLite DB**.

Keep:

- Sentinel main DB for current-state monitoring and alerts
- LP historical event data in a dedicated `lp-history.sqlite`

This lets the history backfill run slowly and safely on public/free RPC while the production monitoring bot stays current.

## Why This Is Better

LP history has a very different workload than real-time monitoring:

- high-volume historical backfill
- append-only event storage
- read-heavy historical reporting
- much larger disk footprint

Sentinel's main DB needs to stay optimized for:

- wallet/user state
- current LP/loan/ALM snapshots
- alerts
- heartbeat
- fast startup and low operational risk

Trying to combine both in the main DB creates:

- large file growth
- longer checkpoints/backups
- more RPC pressure during backfills
- risk of stale production monitoring while history catches up

## What Stays In The Main Sentinel DB

Keep these in the main DB:

- users
- wallets
- alert state
- heartbeat state
- current LP snapshots
- current loan snapshots
- ALM snapshots
- Stability Pool snapshots
- existing loan history if it is already working and not causing pain

Do **not** move loan history yet just because LP history is being split out.

## What Goes In The LP History DB

Put these in the new LP history DB:

- canonical raw LP management events
- LP history backfill/tail cursors
- derived LP reporting rows
- optional protocol/pair/token metadata copied or derived for reporting convenience

Recommended tables:

### Raw event layer

- `index_streams`
- `index_cursors`
- `backfill_jobs`
- `backfill_windows`
- `chain_events`

But only for LP-history purposes.

### Derived reporting layer

- `lp_position_events`

Suggested shape:

- `chain_id`
- `protocol`
- `position_id`
- `wallet_lower`
- `wallet_eip55`
- `pair_label`
- `event_name`
- `event_kind`
- `block_number`
- `block_timestamp`
- `tx_hash`
- `log_index`
- `amount0_raw`
- `amount1_raw`
- optional token symbols/decimals if needed later
- `event_json`

## Data Source Strategy

The LP history DB should be its own subsystem, with its own:

- DB file
- schema
- cursors
- backfill jobs
- tail jobs

It should not depend on Sentinel's main DB being able to absorb the history volume.

## Deployment Strategy

### Sandbox / dev

1. Create and backfill the LP history DB in sandbox/dev
2. Let it run slowly on free/public RPC
3. Validate the derived `lp_position_events` output
4. Test Datum against that DB read-only

### Production

1. Copy the finished LP history DB file into prod
2. Deploy the Datum/Sentinel code that reads it
3. Start only the light incremental tail jobs in prod

This avoids multi-day production backfills.

## Relationship To Datum

Datum should treat the LP history DB as read-only.

Datum should **not**:

- decode LP logs itself
- scan RPC itself
- recompute pair labels from chain data

Datum should:

- query `lp_position_events`
- filter by `block_timestamp`
- export CSV rows
- build grouped summaries

## Relationship To Sentinel

Sentinel main bot should not depend on LP history DB freshness.

That means:

- alerts should keep using current snapshot data
- `/my-lp` should keep using current-state logic
- heartbeat should keep using current-state logic

Historical LP reporting is an analytics/reporting concern, not a monitoring concern.

## Loan History

Do **not** migrate loan history yet.

Reason:

- it is already working
- Datum already uses it
- it is not currently the operational bottleneck

Recommended staging:

1. Split LP history first
2. Prove the separate-history-DB model works
3. Revisit loan history later if main DB size or ops pressure warrants it

## Practical Next Step

Create a new implementation branch that targets a dedicated LP history DB and keep Sentinel main-DB monitoring code untouched.

That branch should:

1. define `LP_HISTORY_DB_PATH`
2. add a dedicated LP history schema
3. add LP history backfill/tail jobs writing only to that DB
4. add derived `lp_position_events`
5. let Datum read that DB directly

## What We Undid

The prior experiment of pushing LP history into Sentinel's main DB was reverted because:

- it ballooned the main DB
- it made backfill too slow on free/public RPC
- it created too much operational risk for production monitoring freshness

Only unrelated improvements should remain in the main Sentinel repo:

- better RPC retry handling
- legacy scan cursor checkpointing

Those are still useful regardless of where LP history ultimately lives.
