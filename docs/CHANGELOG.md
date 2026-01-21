# Changelog

All notable, user-facing changes are documented here.

---

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
