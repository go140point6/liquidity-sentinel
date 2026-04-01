const cron = require("node-cron");

const { getDb } = require("../db");
const logger = require("../utils/logger");
const { loadPriceCache } = require("../utils/priceCache");
const {
  getLatestStabilityPoolSnapshots,
  getPoolShortLabel,
  recommendSinglePoolAllocation,
} = require("../utils/stabilityPoolSignals");

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var ${name}`);
  return String(v).trim();
}

function requireNumberEnv(name) {
  const raw = requireEnv(name);
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Env var ${name} must be numeric (got "${raw}")`);
  return v;
}

const SP_APR_REACTION_EMOJI = requireEnv("SP_APR_REACTION_EMOJI");
const SP_APR_CHANNEL_ID = requireEnv("SP_APR_CHANNEL_ID");
const SP_APR_POLL_MIN = requireNumberEnv("SP_APR_POLL_MIN");
const SP_SIGNAL_REFERENCE_DEPOSIT_CDP = requireNumberEnv("SP_SIGNAL_REFERENCE_DEPOSIT_CDP");

function getCdpUsdPrice(db) {
  const priceMap = loadPriceCache(db).get("FLR");
  const price = Number(priceMap?.get("CDP"));
  return Number.isFinite(price) && price > 0 ? price : null;
}

function fmtDailyUsd(cdpAmount, cdpUsdPrice) {
  if (!Number.isFinite(cdpAmount)) return "not yet realized";
  if (!Number.isFinite(cdpUsdPrice) || cdpUsdPrice <= 0) return "n/a";
  return `$${(cdpAmount * cdpUsdPrice).toFixed(2)}/day`;
}

function fmtWhole(n) {
  if (!Number.isFinite(n)) return "n/a";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function getConfig(db) {
  return db.prepare(`
    SELECT channel_id, message_id, last_top_pool_key
    FROM sp_apr_config
    WHERE id = 1
    LIMIT 1
  `).get();
}

function setConfig(db, { channelId, messageId }) {
  db.prepare(`
    INSERT INTO sp_apr_config (id, channel_id, message_id)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      channel_id = excluded.channel_id,
      message_id = excluded.message_id,
      updated_at = datetime('now')
  `).run(channelId, messageId);
}

function setLastState(db, { topPoolKey }) {
  db.prepare(`
    UPDATE sp_apr_config
    SET last_top_pool_key = ?, last_checked_at = datetime('now'), updated_at = datetime('now')
    WHERE id = 1
  `).run(topPoolKey || null);
}

function buildBoardMessage(state, cdpUsdPrice) {
  const lines = [];
  lines.push("Stability signal:");
  lines.push(`Overall return state (est. daily, ref ${fmtWhole(state.referenceDepositCdp)} CDP).`);
  lines.push("Includes CDP, APS, and rFLR rewards.");
  lines.push("");

  for (const row of state.rows) {
    lines.push(`${getPoolShortLabel(row)}: ${fmtDailyUsd(row.dailyReturn, cdpUsdPrice)}`);
  }

  lines.push("");
  if (state.top) {
    lines.push(`Current highest total return: ${getPoolShortLabel(state.top)}`);
  } else {
    lines.push("Current highest total return: undetermined.");
  }

  return lines.join("\n");
}

async function readState(db) {
  const snapshots = getLatestStabilityPoolSnapshots(db, "FLR");
  if (!snapshots.length) {
    return { rows: [], top: null, referenceDepositCdp: SP_SIGNAL_REFERENCE_DEPOSIT_CDP };
  }

  const rows = recommendSinglePoolAllocation(snapshots, SP_SIGNAL_REFERENCE_DEPOSIT_CDP);
  const top = rows.length ? rows[0] : null;
  const topKey = top?.poolKey || null;
  for (const row of rows) {
    row.key = row.poolKey;
    row.isTop = !!topKey && row.poolKey === topKey;
  }

  return {
    rows,
    top,
    referenceDepositCdp: SP_SIGNAL_REFERENCE_DEPOSIT_CDP,
  };
}

async function notifySubscribersOnFlip(client, db, { prevTopKey, nextTop }) {
  const nextTopKey = nextTop?.poolKey || null;
  if (!prevTopKey || !nextTopKey || prevTopKey === nextTopKey) return;

  const rows = db.prepare(`
    SELECT u.id AS user_id, u.discord_id, u.accepts_dm
    FROM sp_apr_subscriptions s
    JOIN users u ON u.id = s.user_id
    ORDER BY s.created_at
  `).all();

  const setUserDmStmt = db.prepare(
    `UPDATE users SET accepts_dm = ?, updated_at = datetime('now') WHERE id = ?`
  );

  const winner = getPoolShortLabel(nextTop);
  const msg = [
    "Stability signal:",
    "Return state changed.",
    `Current highest total return: ${winner}`
  ].join("\n");

  for (const row of rows) {
    const user = await client.users.fetch(row.discord_id).catch(() => null);
    if (!user) continue;
    try {
      await user.send(msg);
      setUserDmStmt.run(1, row.user_id);
    } catch (err) {
      setUserDmStmt.run(0, row.user_id);
      logger.warn("[sp-apr] DM failed", {
        userId: row.user_id,
        discordId: row.discord_id,
        error: err?.message || String(err),
      });
    }
  }
}

async function updateBoardMessage(client, db, state) {
  const cfg = getConfig(db);
  if (!cfg?.channel_id || !cfg?.message_id) {
    logger.warn("[sp-apr] missing sp_apr_config row; run !!postspapr");
    return { previousTopKey: cfg?.last_top_pool_key || null };
  }

  const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    logger.error(`[sp-apr] channel not found or not text-based: ${cfg.channel_id}`);
    return { previousTopKey: cfg?.last_top_pool_key || null };
  }

  const message = await channel.messages.fetch(cfg.message_id).catch(() => null);
  if (!message) {
    logger.error(`[sp-apr] message not found: ${cfg.message_id}`);
    return { previousTopKey: cfg?.last_top_pool_key || null };
  }

  const content = buildBoardMessage(state, getCdpUsdPrice(db));
  await message.edit(content);
  return { previousTopKey: cfg?.last_top_pool_key || null };
}

async function runOnce(client) {
  const db = getDb();
  const state = await readState(db);
  const { previousTopKey } = await updateBoardMessage(client, db, state);
  await notifySubscribersOnFlip(client, db, {
    prevTopKey: previousTopKey,
    nextTop: state.top,
  });
  setLastState(db, { topPoolKey: state.top?.poolKey || null });
}

async function readCurrentBoardStateForCommand() {
  const db = getDb();
  return readState(db);
}

function startStabilityAprJob(client) {
  const minutes = Math.max(1, Number.isFinite(SP_APR_POLL_MIN) ? Math.floor(SP_APR_POLL_MIN) : 60);
  const sched = `*/${minutes} * * * *`;
  if (!cron.validate(sched)) {
    logger.error(`[sp-apr] invalid schedule: ${sched}`);
    return null;
  }

  logger.startup(`[sp-apr] Using schedule: ${sched}`);

  let isRunning = false;
  async function wrappedRun() {
    if (isRunning) {
      logger.warn("[sp-apr] Previous run still running — skipping.");
      return;
    }
    isRunning = true;
    try {
      await runOnce(client);
    } catch (err) {
      logger.error("[sp-apr] run failed:", err?.message || err);
    } finally {
      isRunning = false;
    }
  }

  void wrappedRun();
  cron.schedule(sched, wrappedRun);
  return { setConfig, getConfig };
}

module.exports = {
  startStabilityAprJob,
  runOnce,
  readState,
  readCurrentBoardStateForCommand,
  setConfig,
  getConfig,
  buildBoardMessage,
  SP_APR_REACTION_EMOJI,
  SP_APR_CHANNEL_ID,
};
