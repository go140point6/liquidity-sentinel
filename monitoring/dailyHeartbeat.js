// monitoring/dailyHeartbeat.js
const { getLoanSummaries } = require("./loanMonitor");
const { getLpSummaries } = require("./lpMonitor");
const { sendLongDM } = require("../utils/discord/sendLongDM");
const { getDb } = require("../db");
const logger = require("../utils/logger");

// -----------------------------
// Formatting helpers
// -----------------------------
function formatLoanLine(s) {
  const troveId = s.troveId ?? s.tokenId ?? s.positionId ?? "?";

  const parts = [];
  parts.push(`• **${s.protocol || "UNKNOWN"}** (${s.chainId || "?"}) — trove **${troveId}** — status **${s.status || "UNKNOWN"}**`);

  if (s.hasPrice && typeof s.price === "number" && typeof s.liquidationPrice === "number") {
    const ltvText = typeof s.ltvPct === "number" ? `${s.ltvPct.toFixed(2)}%` : "n/a";
    const bufferText =
      typeof s.liquidationBufferFrac === "number"
        ? `${(s.liquidationBufferFrac * 100).toFixed(2)}%`
        : "n/a";

    parts.push(
      `   LTV **${ltvText}**, price **${s.price.toFixed(5)}**, liq **${s.liquidationPrice.toFixed(5)}**, buffer **${bufferText}** (tier **${s.liquidationTier || "UNKNOWN"}**)`
    );
  } else {
    parts.push("   Price / liq: *(unavailable; cannot compute LTV / buffer)*");
  }

  if (typeof s.interestPct === "number") {
    let irLine = `   IR **${s.interestPct.toFixed(2)}% p.a.**`;
    if (typeof s.globalIrPct === "number") {
      irLine += ` vs global **${s.globalIrPct.toFixed(2)}%**`;
    }
    if (s.redemptionTier) {
      irLine += `, redemption tier **${s.redemptionTier}**`;
    }
    parts.push(irLine);
  }

  return parts.join("\n");
}

function formatLpLine(s) {
  const tokenId = s.tokenId ?? s.positionId ?? "?";
  const pair = s.pairLabel || `${s.token0Symbol || s.token0 || "?"}-${s.token1Symbol || s.token1 || "?"}`;

  const parts = [];
  parts.push(
    `• **${s.protocol || "UNKNOWN"}** ${pair} (${s.chainId || "?"}) — token **${tokenId}** — status **${s.status || "UNKNOWN"}**, range **${s.rangeStatus || "UNKNOWN"}**`
  );

  if (s.lpRangeTier && s.lpRangeTier !== "UNKNOWN") {
    parts.push(`   Range tier **${s.lpRangeTier}**${s.lpRangeLabel ? ` (${s.lpRangeLabel})` : ""}`);
  }

  if (
    typeof s.tickLower === "number" &&
    typeof s.tickUpper === "number" &&
    typeof s.currentTick === "number"
  ) {
    parts.push(`   Tick [${s.tickLower}, ${s.tickUpper}) current **${s.currentTick}**`);
  }

  if (s.liquidity) {
    parts.push(`   Liquidity \`${s.liquidity}\``);
  }

  return parts.join("\n");
}

// -----------------------------
// Recipient selection (DB-driven)
// -----------------------------
function getHeartbeatRecipients() {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT DISTINCT
      u.id           AS userId,
      u.discord_id   AS discordId,
      u.discord_name AS discordName
    FROM users u
    JOIN user_wallets uw
      ON uw.user_id = u.id
     AND uw.is_enabled = 1
    WHERE
      u.accepts_dm = 1
      AND u.discord_id IS NOT NULL
  `
    )
    .all();
}

// If DM is blocked, stop trying daily until user re-enables via onboarding.
function markUserCannotDm(userId) {
  try {
    const db = getDb();
    db.prepare(
      `
      UPDATE users
      SET accepts_dm = 0,
          updated_at = datetime('now')
      WHERE id = ?
    `
    ).run(userId);
  } catch (e) {
    logger.warn(`[Heartbeat] Failed to mark accepts_dm=0 for userId=${userId}:`, e?.message || e);
  }
}

// -----------------------------
// Message builder (per-user)
// -----------------------------
function buildHeartbeatMessage({ nowIso, loanSummaries, lpSummaries }) {
  const lines = [];
  lines.push("📊 **24h DeFi Heartbeat**");
  lines.push(`as of \`${nowIso}\``);
  lines.push("");

  // ---- Loans ----
  lines.push("**Loans**");
  if (!loanSummaries || loanSummaries.length === 0) {
    lines.push("*(no monitored loans)*");
  } else {
    loanSummaries
      .slice()
      .sort((a, b) => {
        const av = typeof a.ltvPct === "number" ? a.ltvPct : -1;
        const bv = typeof b.ltvPct === "number" ? b.ltvPct : -1;
        return bv - av;
      })
      .forEach((s) => lines.push(formatLoanLine(s)));
  }

  lines.push("");

  // ---- LPs ----
  lines.push("**LP Positions**");
  if (!lpSummaries || lpSummaries.length === 0) {
    lines.push("*(no monitored LP positions)*");
  } else {
    const order = { OUT_OF_RANGE: 0, UNKNOWN: 1, IN_RANGE: 2 };
    lpSummaries
      .slice()
      .sort((a, b) => {
        const ra = order[a.rangeStatus] ?? 99;
        const rb = order[b.rangeStatus] ?? 99;
        if (ra !== rb) return ra - rb;
        return (a.protocol || "").localeCompare(b.protocol || "");
      })
      .forEach((s) => lines.push(formatLpLine(s)));
  }

  return lines.join("\n");
}

// -----------------------------
// Main
// -----------------------------
async function sendDailyHeartbeat(client) {
  if (!client?.users?.fetch) {
    throw new Error("[Heartbeat] Discord client not available (client.users.fetch missing).");
  }

  const recipients = getHeartbeatRecipients();
  if (!recipients || recipients.length === 0) {
    logger.info("[Heartbeat] No recipients (accepts_dm=1 with enabled wallets).");
    return;
  }

  let allLoanSummaries = [];
  let allLpSummaries = [];
  try {
    [allLoanSummaries, allLpSummaries] = await Promise.all([getLoanSummaries(), getLpSummaries()]);
  } catch (err) {
    logger.error("[Heartbeat] Failed to fetch summaries:", err?.message || err);
    return;
  }

  const nowIso = new Date().toISOString();

  // Optional: cache Discord user fetches (in case of duplicate discordId rows)
  const userCache = new Map(); // discordId -> Discord.User

  for (const r of recipients) {
    const userIdKey = String(r.userId);
    const discordId = String(r.discordId);

    const userLoans = (allLoanSummaries || []).filter((s) => String(s.userId) === userIdKey);
    const userLps = (allLpSummaries || []).filter((s) => String(s.userId) === userIdKey);

    const msg = buildHeartbeatMessage({
      nowIso,
      loanSummaries: userLoans,
      lpSummaries: userLps,
    });

    try {
      let user = userCache.get(discordId);
      if (!user) {
        user = await client.users.fetch(discordId);
        userCache.set(discordId, user);
      }

      await sendLongDM(user, msg);

      logger.info(`[Heartbeat] Sent daily heartbeat to userId=${r.userId} discordId=${discordId}`);
    } catch (err) {
      const code = err?.code;
      const msgText = err?.message || String(err);

      logger.error(
        `[Heartbeat] Failed to send to discordId=${discordId} (userId=${r.userId}):`,
        msgText
      );

      // Discord "Cannot send messages to this user" => stop trying until onboarding succeeds again
      if (code === 50007) {
        markUserCannotDm(r.userId);
        logger.warn(`[Heartbeat] Marked accepts_dm=0 (DM blocked) for userId=${r.userId}`);
      }
    }
  }
}

module.exports = { sendDailyHeartbeat };
