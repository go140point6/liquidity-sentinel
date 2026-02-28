const cron = require("node-cron");
const { ethers } = require("ethers");

const stabilityPoolAbi = require("../abi/stabilityPool.json");
const erc20MetaAbi = require("../abi/erc20Metadata.json");
const { getProviderForChain } = require("../utils/ethers/providers");
const { getDb } = require("../db");
const { getStabilityPoolsForChain } = require("../utils/stabilityPoolConfig");
const logger = require("../utils/logger");

const CHAINS_CONFIG = {
  FLR: { rpcEnvKey: "FLR_MAINNET" },
};

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

function fmtPct(n) {
  if (!Number.isFinite(n)) return "n/a";
  return `${n.toFixed(2)}%`;
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

function buildBoardMessage(state) {
  const lines = [];
  lines.push("Stability signal:");
  lines.push("APR state (24h realized).");
  lines.push("");

  for (const row of state.rows) {
    const aprText = Number.isFinite(row.apr24hPct) ? fmtPct(row.apr24hPct) : "not yet realized";
    const shortLabel = String(row.collSymbol || row.label || "").toUpperCase().includes("WFLR")
      ? "WFLR"
      : String(row.collSymbol || row.label || "").toUpperCase().includes("FXRP")
        ? "FXRP"
        : row.label;
    lines.push(`${shortLabel}: ${aprText}`);
  }

  lines.push("");
  if (state.top) {
    const topLabel = String(state.top.collSymbol || state.top.label || "").toUpperCase().includes("WFLR")
      ? "WFLR"
      : String(state.top.collSymbol || state.top.label || "").toUpperCase().includes("FXRP")
        ? "FXRP"
        : state.top.label;
    lines.push(`Higher rate: ${topLabel}.`);
  } else {
    lines.push("Higher rate: undetermined.");
  }

  return lines.join("\n");
}

async function readPoolRow(provider, poolCfg, db) {
  const sp = new ethers.Contract(poolCfg.address, stabilityPoolAbi, provider);

  const [currentScaleRaw, pRaw, totalBoldDeposits, collToken] = await Promise.all([
    sp.currentScale(),
    sp.P(),
    sp.getTotalBoldDeposits(),
    sp.collToken(),
  ]);

  const currentScale = Number(currentScaleRaw);
  const bRaw = await sp.scaleToB(currentScaleRaw);

  // index ~ cumulative BOLD gain per 1 BOLD deposited (approx, 36-dec math)
  let indexValue = null;
  if (pRaw > 0n) {
    const ray = (BigInt(bRaw) * 10n ** 18n) / BigInt(pRaw);
    indexValue = Number(ethers.formatUnits(ray, 18));
  }

  const token = new ethers.Contract(collToken, erc20MetaAbi, provider);
  let collSymbol = poolCfg.label;
  try {
    collSymbol = await token.symbol();
  } catch (_) {}

  db.prepare(`
    INSERT INTO sp_apr_snapshots (
      chain_id, pool_key, pool_address, pool_label, coll_symbol,
      total_bold_deposits, current_scale, p_value, scale_b_value, index_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    poolCfg.chainId,
    poolCfg.key,
    poolCfg.address,
    poolCfg.label,
    collSymbol,
    String(totalBoldDeposits),
    String(currentScale),
    String(pRaw),
    String(bRaw),
    indexValue
  );

  const prev = db.prepare(`
    SELECT index_value, created_at
    FROM sp_apr_snapshots
    WHERE chain_id = ? AND pool_key = ? AND created_at <= datetime('now', '-24 hours')
      AND index_value IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(poolCfg.chainId, poolCfg.key);

  let apr24hPct = null;
  if (prev && Number.isFinite(Number(prev.index_value))) {
    const prevIndex = Number(prev.index_value);
    const prevTs = Date.parse(String(prev.created_at).replace(" ", "T") + "Z");
    const nowTs = Date.now();
    const elapsedHours = (nowTs - prevTs) / 3600000;
    if (elapsedHours > 0 && Number.isFinite(indexValue)) {
      const delta = indexValue - prevIndex;
      apr24hPct = delta * (24 / elapsedHours) * 365 * 100;
    }
  }

  return {
    chainId: poolCfg.chainId,
    key: poolCfg.key,
    label: poolCfg.label,
    poolAddress: poolCfg.address,
    collSymbol,
    totalBoldDeposits: String(totalBoldDeposits),
    indexValue,
    apr24hPct,
  };
}

async function readState(db) {
  const pools = getStabilityPoolsForChain("FLR");
  if (!pools.length) {
    return { rows: [], top: null };
  }

  const provider = getProviderForChain("FLR", CHAINS_CONFIG);
  const rows = [];

  for (const poolCfg of pools) {
    try {
      const row = await readPoolRow(provider, poolCfg, db);
      rows.push(row);
    } catch (err) {
      logger.warn(`[sp-apr] failed reading pool ${poolCfg.key} ${poolCfg.address}: ${err?.message || err}`);
      rows.push({
        chainId: poolCfg.chainId,
        key: poolCfg.key,
        label: poolCfg.label,
        poolAddress: poolCfg.address,
        collSymbol: null,
        totalBoldDeposits: null,
        indexValue: null,
        apr24hPct: null,
      });
    }
  }

  const finite = rows.filter((r) => Number.isFinite(r.apr24hPct));
  let top = null;
  if (finite.length) {
    top = [...finite].sort((a, b) => b.apr24hPct - a.apr24hPct)[0];
  }

  const topKey = top?.key || null;
  for (const r of rows) {
    r.isTop = !!topKey && r.key === topKey;
  }

  return { rows, top };
}

async function notifySubscribersOnFlip(client, db, { prevTopKey, nextTop }) {
  const nextTopKey = nextTop?.key || null;
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

  const winner = String(nextTop.collSymbol || nextTop.label || "").toUpperCase().includes("WFLR")
    ? "WFLR"
    : String(nextTop.collSymbol || nextTop.label || "").toUpperCase().includes("FXRP")
      ? "FXRP"
      : nextTop.label;
  const msg = [
    "Stability signal:",
    "APR state changed.",
    `Current higher rate: ${winner} (${fmtPct(nextTop.apr24hPct)}).`
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

  const content = buildBoardMessage(state);
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
  setLastState(db, { topPoolKey: state.top?.key || null });
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
};
