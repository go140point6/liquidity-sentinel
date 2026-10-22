# Datasource watchdog

`datasource-watchdog` is a separate persistent PM2 worker. It reads Sentinel's
SQLite database in read-only mode and sends owner DMs using the existing
`BOT_TOKEN` through Discord's HTTP API. It does not connect to RPC endpoints or
start another Discord gateway client.

Add these settings to the real `.env` before starting it:

```dotenv
DATASOURCE_WATCHDOG_DISCORD_USER_ID=your_discord_user_id
DATASOURCE_WATCHDOG_POLL_MIN=5
DATASOURCE_WATCHDOG_STALE_MIN=30
```

Start only this worker on the main VPS, as ryan:

```bash
cd /home/ryan/liquidity-sentinel
pm2 start ecosystem.config.js --only datasource-watchdog
pm2 logs datasource-watchdog --lines 30
pm2 save
```

The first check runs immediately; subsequent checks run five minutes after the
previous check finishes. With the defaults, a scan failure is typically detected
30–35 minutes after the last successful scan. The cycle normally runs every eight
minutes, so this permits missed cycles and catch-up work.

For each chain, every enabled Transfer stream belonging to an enabled contract
must have a completed `TAIL` job in the last 30 minutes. Failed jobs, incomplete
jobs, backfills, and partially completed catch-up scans cannot mark a chain fresh.
A successful scan with no transfer events still counts. Missing history or no
enabled streams is stale. Database read failures are reported as UNKNOWN, and
recovery generates a DM as well.

On first startup, healthy sources are silent and stale/unknown sources notify.
Thereafter only status changes notify. Partial recovery identifies the recovered
chain and the chain still affected. When both recover, the DM says all clear.
State lives in `data/datasource-watchdog-state.json` and survives restarts.
Failed delivery leaves the previous status unchanged and retries next poll. A
crash after delivery but before saving state can cause a duplicate DM. Run one
instance, as configured in the ecosystem file.

The watchdog measures scan freshness, not RPC reachability or the freshness of
every downstream loan, LP, price, Stability Pool, or Datum snapshot. It cannot
send a DM if this VPS, the worker itself, or Discord is unavailable. Check its
PM2 logs for delivery failures. Restart this worker after changing its `.env`
settings:

```bash
pm2 restart datasource-watchdog
```
