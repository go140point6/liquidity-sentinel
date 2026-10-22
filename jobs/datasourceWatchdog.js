const path = require('node:path');
const fs = require('node:fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const Database = require('better-sqlite3');
const { REST, Routes } = require('discord.js');
const { CHAINS, readFreshness, notification } = require('../utils/datasourceFreshness');

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

async function main() {
  const recipient = process.env.DATASOURCE_WATCHDOG_DISCORD_USER_ID;
  if (!/^\d{17,20}$/.test(recipient || '')) {
    throw new Error('Set DATASOURCE_WATCHDOG_DISCORD_USER_ID to your Discord user ID.');
  }
  if (!process.env.BOT_TOKEN || !process.env.DB_PATH) throw new Error('BOT_TOKEN and DB_PATH are required.');
  const intervalMs = positiveNumber('DATASOURCE_WATCHDOG_POLL_MIN', 5) * 60000;
  const staleMinutes = positiveNumber('DATASOURCE_WATCHDOG_STALE_MIN', 30);
  const statePath = path.join(__dirname, '..', 'data', 'datasource-watchdog-state.json');
  let previous = {};
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (saved.version !== 1 || !saved.sources || typeof saved.sources !== 'object') {
      throw new Error('Invalid watchdog state file');
    }
    if (saved.recipient === recipient) previous = saved.sources;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const rest = new REST({ timeout: 15000, retries: 0, rejectOnRateLimit: () => true }).setToken(process.env.BOT_TOKEN);
  let channelId;
  let stopping = false;
  let timer;
  const stop = () => { stopping = true; clearTimeout(timer); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  async function check() {
    let current;
    let db;
    try {
      db = new Database(path.resolve(process.env.DB_PATH), { readonly: true, fileMustExist: true });
      db.pragma('busy_timeout = 5000');
      current = readFreshness(db, { staleMinutes });
    } catch (err) {
      console.error('[datasourceWatchdog] Database check failed:', err.message);
      current = Object.fromEntries(CHAINS.map((chain) => [chain, {
        status: 'unknown', detail: 'Cannot read scan history; check the watchdog logs.',
      }]));
    } finally {
      if (db) db.close();
    }
    const message = notification(previous, current);
    // Advance persisted state only after Discord confirms delivery. Failed DMs retry next poll.
    if (message) {
      if (!channelId) {
        const channel = await rest.post(Routes.userChannels(), { body: { recipient_id: recipient } });
        channelId = channel.id;
      }
      await rest.post(Routes.channelMessages(channelId), {
        body: { content: message, allowed_mentions: { parse: [] } },
      });
      console.log('[datasourceWatchdog] Health change DM delivered.');
    }
    const sources = Object.fromEntries(CHAINS.map((chain) => [chain, current[chain].status]));
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temporary = `${statePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, recipient, sources }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, statePath);
    previous = sources;
    console.log('[datasourceWatchdog]', sources);
  }

  async function tick() {
    try { await check(); }
    catch (err) { console.error('[datasourceWatchdog] Check/delivery failed; retrying next poll:', err.message); }
    if (!stopping) timer = setTimeout(tick, intervalMs);
  }
  console.log(`[datasourceWatchdog] Poll=${intervalMs / 60000}m stale=${staleMinutes}m; monitoring completed FLR/XDC tail scans.`);
  await tick();
}

if (require.main === module) {
  main().catch((err) => { console.error('[datasourceWatchdog]', err.message); process.exitCode = 1; });
}
