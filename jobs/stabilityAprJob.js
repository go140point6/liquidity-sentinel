const cron = require("node-cron");

const { getDb } = require("../db");
const { getStabilityPoolsForChain } = require("../utils/stabilityPoolConfig");
const logger = require("../utils/logger");

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
const GLOBAL_IR_URL = requireEnv("GLOBAL_IR_URL");

function fmtPct(n) {
  if (!Number.isFinite(n)) return "n/a";
  return `${n.toFixed(2)}%`;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function inferBranchKey(poolCfg) {
  const t = `${poolCfg.key || ""} ${poolCfg.label || ""}`.toUpperCase();
  if (t.includes("FXRP")) return "FXRP";
  if (t.includes("WFLR")) return "WFLR";
  return null;
}

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
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

function parseBranchApr(branchObj) {
  if (!branchObj || typeof branchObj !== "object") {
    return { totalPct: null, feePct: null, apsPct: null, rflrPct: null };
  }

  const total = toNumber(branchObj.sp_apy_1d_total);
  const fee = toNumber(branchObj.sp_apy_avg_1d);
  const aps = toNumber(branchObj?.incentives?.aps?.apy_1d);
  const rflr = toNumber(branchObj?.incentives?.rflr?.apy_1d);

  const summed =
    (fee == null ? 0 : fee) +
    (aps == null ? 0 : aps) +
    (rflr == null ? 0 : rflr);

  return {
    totalPct: total != null ? total * 100 : (fee != null || aps != null || rflr != null ? summed * 100 : null),
    feePct: fee == null ? null : fee * 100,
    apsPct: aps == null ? null : aps * 100,
    rflrPct: rflr == null ? null : rflr * 100,
  };
}

async function readState(_db) {
  const pools = getStabilityPoolsForChain("FLR");
  if (!pools.length) {
    return { rows: [], top: null };
  }

  let json;
  try {
    json = await fetchJson(GLOBAL_IR_URL);
  } catch (err) {
    logger.warn(`[sp-apr] failed to fetch json: ${err?.message || err}`);
    return {
      rows: pools.map((poolCfg) => ({
        chainId: poolCfg.chainId,
        key: poolCfg.key,
        label: poolCfg.label,
        collSymbol: inferBranchKey(poolCfg) || null,
        apr24hPct: null,
      })),
      top: null,
    };
  }

  const rows = pools.map((poolCfg) => {
    const branchKey = inferBranchKey(poolCfg);
    const branchObj = branchKey ? json?.branch?.[branchKey] : null;
    const apr = parseBranchApr(branchObj);

    return {
      chainId: poolCfg.chainId,
      key: poolCfg.key,
      label: poolCfg.label,
      collSymbol: branchKey,
      apr24hPct: apr.totalPct,
      fee24hPct: apr.feePct,
      aps24hPct: apr.apsPct,
      rflr24hPct: apr.rflrPct,
    };
  });

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
