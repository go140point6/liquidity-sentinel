# Admin Commands

This document describes Sentinel’s admin‑only chat commands (prefix `!!`).

---

## `!!postfirelight`

Posts the Firelight signal message to the configured channel and adds the 🔥 reaction.
It also stores the message ID so the job can edit it on state changes.

Use when first setting up the Firelight channel.

---

## `!!editfirelight`

Edits the existing Firelight signal message with the latest state.
Use if you need to refresh the message content without waiting for the next poll.

---

## Requirements

- You must have **Manage Server** permission in Discord to run these commands.
- `FIRELIGHT_CHANNEL_ID` must be set in `.env`.
- The bot needs permission to send messages and add reactions in the Firelight channel.


## `!!postspapr`

Posts the Stability Pool APR board message to the configured channel and adds the subscription reaction.
It stores the message ID so the job can edit the same message in place.

---

## `!!editspapr`

Edits the existing Stability Pool APR board message with the latest computed 24h annualized values.
Use if you need to refresh without waiting for the next poll.

---

## Additional Requirements (SP APR)

- `SP_APR_CHANNEL_ID` must be set in `.env`.
- Optional: `SP_APR_POLL_MIN` (default 60), `SP_APR_REACTION_EMOJI` (default 📈).
- Stability pool source addresses are configured in `data/stability_pools.json`.
