# Changelog

All notable, user-facing changes are documented here.

---

## [2026-01-29]

### Changed
- Redemption-rate change fee now uses the global average rate (and is no longer labeled “estimated”).
- Redemption tiering is now debt-ahead only (legacy IR-proxy tiers retired).
- Daily heartbeat no longer lists inactive LP positions.

## [2026-02-02]

### Added
- `/stats` for public system snapshot totals (users, wallets, active loans/LPs, loan debt, Firelight subscribers).

## [2026-02-03]

### Added
- LP USD pricing cache from Liquity JSON (FLR/XRP/CDP/APS) and CryptoCompare (XDC), with TVL coverage in `/stats`.

### Changed
- `/stats` now includes LP USD TVL and coverage, plus user chain breakdown.
- `/my-lp` and Daily Heartbeat LP sections now show USD values for principal and fees with consistent decimals and small-value precision.
- Daily heartbeat loan section formatting adjusted (tier colors moved to risk lines, collateral line removed).

## [2026-01-30]

### Changed
- Daily heartbeat will refresh snapshots when stale; if refresh fails, it sends the most recent stale data with a warning.
- Firelight channel updates now include capacity changes while OPEN, without spamming DMs.

## [2026-01-23]

### Added
- Redemption risk now uses debt-ahead depth and shows a clearer position bar plus debt-ahead context.
- Staleness warnings for snapshot data in alerts, commands, and the daily heartbeat.

### Changed
- Daily heartbeat loan layout tightened with clearer liquidation/redemption sections and meaning lines.
- `/test-alerts` expanded for debt-ahead and per-protocol testing (IR and liquidation).

## [2026-01-26]

### Added
- Firelight signal channel with a single live status message (OPEN/CLOSED/UNKNOWN).
- 🔥 reaction subscriptions for Firelight DMs when capacity state flips.
- Admin commands `!!postfirelight` and `!!editfirelight` to seed and refresh the Firelight message.
- `!!help` for a quick command summary.

### Changed
- Firelight capacity now uses on-chain `depositLimit` vs `totalAssets` for open/closed state.

## [2026-01-28]

### Added
- `/redemption-rate` command for target IR guidance by contract and loan, using recent snapshots.

### Changed
- Snapshot refresh behavior now uses time/debt gates and avoids unnecessary refreshes unless new tracked positions are detected.

## [2026-01-22]

### Added
- Per-wallet LP alert flag to suppress tier-only updates and only notify on in-range/out-of-range status changes.

## [2026-01-21]

### Changed
- Loan and LP alerts now use a consistent improving/worsening format with clear tier markers and human-friendly meaning lines.
- Wallets and positions are now clickable links to explorers and DEX position pages across alerts, commands, and heartbeat summaries.
- Daily heartbeat entries now mirror command layouts (token/trove link first, then principal/fees/status/tier).

## [2026-01-20]

### Changed
- LP alerts now emphasize “why” (improving/worsening) with clearer wording and emoji cues.
- LP alerts show current price plus min/max range bounds in token terms for easier range context.
- Status display is simplified to current state only to reduce confusion.

## [2026-01-15]

### Added
- Cleaner, more readable alert DMs with embeds and clearer status changes.
- Daily heartbeat summary formatting for quicker scanning of loans and LPs.
- Wallet labels shown in alerts when available.

### Changed
- Alert noise reduced: same-tier updates are suppressed, and first-seen positions no longer DM on startup.
- Redemption risk tiers now include a Critical state and simplified behavior.
- LP and loan summaries now focus on signal (less raw tick noise).
