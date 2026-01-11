// monitoring/alertEngine.js
// DB-backed alert state + logging + Discord DM alerts (NEW SCHEMA)

const crypto = require("crypto");
const { getDb } = require("../db");
const { sendLongDM } = require("../utils/discord/sendLongDM");

let _client = null;
function setAlertEngineClient(client) {
  _client = client;
}

function assertPresent(name, v) {
  if (v === undefined || v === null || v === "") {
    throw new Error(`[alertEngine] Missing required field: ${name}`);
  }
}

// -----------------------------
// Helpers
// -----------------------------

// Stable stringify to avoid phantom signature changes
function stableStringify(obj) {
  if (obj == null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return JSON.stringify(obj.map(stableStringify));
  const keys = Object.keys(obj).sort();
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return JSON.stringify(out);
}

function makeSignature(payload) {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function disableUserDm(userId, reason = null) {
  try {
    const db = getDb();
    db.prepare(
      `
      UPDATE users
      SET accepts_dm = 0
      WHERE id = ?
    `
    ).run(userId);

    if (reason) console.warn(`[dm] Disabled DMs for userId=${userId} (${reason})`);
    else console.warn(`[dm] Disabled DMs for userId=${userId}`);
  } catch (e) {
    console.error(`[dm] Failed to disable DMs for userId=${userId}:`, e.message);
  }
}

/**
 * Discord DM failure classifier.
 * Only disable DMs for strong signals that user can't be messaged.
 */
function shouldDisableDmForError(err) {
  const code = err?.code;
  const status = err?.status;

  // Strong Discord API signals
  if (code === 50007) return { disable: true, reason: "Cannot send messages to this user (50007)" };
  if (code === 10013) return { disable: true, reason: "Unknown user (10013)" };

  // discord.js sometimes yields REST/HTTP statuses
  if (status === 403 || status === 401) return { disable: true, reason: `HTTP ${status}` };

  const msg = String(err?.message || "").toLowerCase();

  if (msg.includes("cannot send messages to this user")) {
    return { disable: true, reason: "cannot send messages to this user" };
  }
  if (msg.includes("missing access") || msg.includes("missing permissions")) {
    return { disable: true, reason: "missing access/permissions" };
  }

  // Do NOT disable on timeouts / 5xx / rate limits
  if (msg.includes("timeout") || msg.includes("timed out")) return { disable: false, reason: null };
  if (status && status >= 500) return { disable: false, reason: null };
  if (status === 429) return { disable: false, reason: null };

  return { disable: false, reason: null };
}

function getUserDmTarget(userId) {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT discord_id, discord_name, accepts_dm
      FROM users
      WHERE id = ?
      LIMIT 1
    `
    )
    .get(userId);

  if (!row) return null;
  if (Number(row.accepts_dm) !== 1) return null;
  if (!row.discord_id) return null;

  return { discordId: row.discord_id, discordName: row.discord_name || null };
}

async function sendDmToUser({ userId, phase, alertType, logPrefix, message, meta }) {
  const target = getUserDmTarget(userId);
  if (!target) return;

  const client = _client;
  if (!client || !client.users) {
    console.error(`${logPrefix} [dm] Discord client not set. Call setAlertEngineClient(client) in onReady.`);
    return;
  }

  let user;
  try {
    user = await client.users.fetch(target.discordId);
  } catch (err) {
    console.error(`${logPrefix} [dm] Cannot fetch user ${target.discordId}:`, err?.message || err);
    const verdict = shouldDisableDmForError(err);
    if (verdict.disable) disableUserDm(userId, verdict.reason);
    return;
  }
  if (!user) return;

  const lines = [];
  lines.push(`${logPrefix} ${phase} ${alertType} ALERT`);
  lines.push(message);

  if (meta && Object.keys(meta).length > 0) {
    lines.push("");
    lines.push("Details:");
    for (const [k, v] of Object.entries(meta)) {
      lines.push(`• ${k}: ${v}`);
    }
  }

  try {
    // Use chunked DM sender to avoid 2000-char failures and be more rate-limit friendly.
    await sendLongDM(user, lines.join("\n"));
  } catch (err) {
    console.error(`${logPrefix} [dm] Failed to send DM to ${target.discordId}:`, err?.message || err);
    const verdict = shouldDisableDmForError(err);
    if (verdict.disable) disableUserDm(userId, verdict.reason);
  }
}

// -----------------------------
// Structured alert state/log (NEW SCHEMA)
// -----------------------------
function getPrevState({ userId, walletId, contractId, tokenId }) {
  const db = getDb();

  const row = db
    .prepare(
      `
      SELECT is_active AS isActive, signature, state_json AS stateJson
      FROM alert_state
      WHERE user_id = ?
        AND wallet_id = ?
        AND contract_id = ?
        AND token_id = ?
      LIMIT 1
    `
    )
    .get(userId, walletId, contractId, tokenId);

  return row || { isActive: 0, signature: null, stateJson: null };
}

function upsertAlertState({ userId, walletId, contractId, tokenId, isActive, signature, stateJson }) {
  const db = getDb();

  db.prepare(
    `
    INSERT INTO alert_state (
      user_id, wallet_id, contract_id, token_id,
      is_active, signature, state_json,
      last_seen_at, created_at
    ) VALUES (
      @userId, @walletId, @contractId, @tokenId,
      @isActive, @signature, @stateJson,
      datetime('now'), datetime('now')
    )
    ON CONFLICT(user_id, wallet_id, contract_id, token_id) DO UPDATE SET
      is_active    = excluded.is_active,
      signature    = excluded.signature,
      state_json   = excluded.state_json,
      last_seen_at = datetime('now')
  `
  ).run({
    userId,
    walletId,
    contractId,
    tokenId,
    isActive: isActive ? 1 : 0,
    signature: signature ?? null,
    stateJson: stateJson ?? null,
  });
}

function insertAlertLog({ userId, walletId, contractId, tokenId, alertType, phase, message, meta, signature }) {
  const db = getDb();
  const metaJson = meta && Object.keys(meta).length ? JSON.stringify(meta) : null;

  db.prepare(
    `
    INSERT INTO alert_log (
      user_id, wallet_id, contract_id, token_id,
      alert_type, phase, message, meta_json, signature, created_at
    )
    VALUES (
      @userId, @walletId, @contractId, @tokenId,
      @alertType, @phase, @message, @metaJson, @signature, datetime('now')
    )
  `
  ).run({
    userId,
    walletId,
    contractId,
    tokenId,
    alertType,
    phase,
    message,
    metaJson,
    signature: signature ?? null,
  });
}

// -----------------------------
// Core engine
// -----------------------------
async function processAlert({
  userId,
  walletId,
  contractId,
  tokenId,

  isActive,
  signaturePayload,
  state = null,
  logPrefix,
  message,
  meta = {},
  alertType = "GENERIC",
}) {
  assertPresent("userId", userId);
  assertPresent("walletId", walletId);
  assertPresent("contractId", contractId);
  assertPresent("tokenId", tokenId);

  const signature = makeSignature(signaturePayload);
  const stateJson = state && typeof state === "object" ? JSON.stringify(state) : null;

  const prev = getPrevState({ userId, walletId, contractId, tokenId });
  const prevActive = prev.isActive === 1;

  if (isActive && !prevActive) {
    console.warn(`${logPrefix} NEW ALERT: ${message}`, { ...meta });

    upsertAlertState({ userId, walletId, contractId, tokenId, isActive: true, signature, stateJson });
    insertAlertLog({ userId, walletId, contractId, tokenId, alertType, phase: "NEW", message, meta, signature });

    await sendDmToUser({ userId, phase: "NEW", alertType, logPrefix, message, meta });
    return;
  }

  if (isActive && prevActive && prev.signature !== signature) {
    console.warn(`${logPrefix} ALERT UPDATED: ${message}`, { ...meta });

    upsertAlertState({ userId, walletId, contractId, tokenId, isActive: true, signature, stateJson });
    insertAlertLog({ userId, walletId, contractId, tokenId, alertType, phase: "UPDATED", message, meta, signature });

    await sendDmToUser({ userId, phase: "UPDATED", alertType, logPrefix, message, meta });
    return;
  }

  if (isActive && prevActive && prev.signature === signature) {
    upsertAlertState({ userId, walletId, contractId, tokenId, isActive: true, signature, stateJson });
    return;
  }

  if (!isActive && prevActive) {
    console.log(`${logPrefix} RESOLVED: ${message}`, { ...meta });

    upsertAlertState({ userId, walletId, contractId, tokenId, isActive: false, signature: null, stateJson });
    insertAlertLog({ userId, walletId, contractId, tokenId, alertType, phase: "RESOLVED", message, meta, signature: null });
    return;
  }

  if (!isActive && !prevActive) {
    upsertAlertState({ userId, walletId, contractId, tokenId, isActive: false, signature: null, stateJson });
  }
}

// Small helper: coarsen a fraction into an integer bucket (prevents signature spam)
function fracBucket(x, step = 0.01) {
  if (x == null || !Number.isFinite(x)) return null;
  return Math.round(x / step);
}

/* ---------------------------
 * Public alert handlers
 * -------------------------- */

async function handleLiquidationAlert(data) {
  const {
    userId,
    walletId,
    contractId,
    positionId,
    isActive,
    tier,
    ltvPct,
    liquidationPrice,
    currentPrice,
    liquidationBufferFrac,
    protocol,
    wallet,
  } = data;

  const tokenId = String(positionId);
  const alertType = "LIQUIDATION";
  const message = `Loan at risk of liquidation (${protocol}, wallet=${wallet}, tier=${tier})`;

  // Signature: tier + coarse buffer bucket so meaningful movement updates without spamming
  const sig = {
    tier: String(tier || "UNKNOWN"),
    bufB: fracBucket(liquidationBufferFrac, 0.01), // 1% buckets
  };

  await processAlert({
    userId,
    walletId,
    contractId,
    tokenId,
    isActive,
    signaturePayload: sig,
    state: { kind: "LOAN", tier, ltvPct, liquidationPrice, currentPrice, liquidationBufferFrac },
    logPrefix: "[LIQ]",
    message,
    meta: {
      tier,
      ltvPct,
      liquidationPrice,
      currentPrice,
      liquidationBufferFrac,
    },
    alertType,
  });
}

async function handleRedemptionAlert(data) {
  const {
    userId,
    walletId,
    contractId,
    positionId,
    isActive,
    tier,
    cdpIR,
    globalIR,
    isCDPActive,
    protocol,
    wallet,
  } = data;

  const tokenId = String(positionId);
  const alertType = "REDEMPTION";
  const message = `CDP redemption candidate (${protocol}, wallet=${wallet}, tier=${tier}, CDP_ACTIVE=${isCDPActive})`;

  // Signature: tier + CDP flag + coarse diff bucket
  const diff = typeof cdpIR === "number" && typeof globalIR === "number" ? cdpIR - globalIR : null;

  await processAlert({
    userId,
    walletId,
    contractId,
    tokenId,
    isActive,
    signaturePayload: {
      tier: String(tier || "UNKNOWN"),
      isCDPActive: Boolean(isCDPActive),
      diffB: diff == null || !Number.isFinite(diff) ? null : Math.round(diff * 2), // 0.5pp buckets
    },
    state: { kind: "LOAN", tier, cdpIR, globalIR, isCDPActive },
    logPrefix: "[REDEMP]",
    message,
    meta: {
      tier,
      cdpIR,
      globalIR: globalIR == null ? "unavailable" : globalIR,
      isCDPActive,
    },
    alertType,
  });
}

async function handleLpRangeAlert(data) {
  const {
    userId,
    walletId,
    contractId,
    positionId,
    prevStatus,
    currentStatus,
    isActive,
    lpRangeTier,
    tickLower,
    tickUpper,
    currentTick,
    protocol,
    wallet,
  } = data;

  const tokenId = String(positionId);
  const alertType = "LP_RANGE";
  const message = `LP range change (${protocol}, wallet=${wallet}, token=${tokenId}): ${prevStatus} → ${currentStatus} (tier=${lpRangeTier})`;

  const state = {
    kind: "LP",
    rangeStatus: String(currentStatus || "UNKNOWN").toUpperCase(),
    lpRangeTier: String(lpRangeTier || "UNKNOWN").toUpperCase(),
    tickLower,
    tickUpper,
    currentTick,
  };

  // Signature: status + tier + coarse distance bucket if available
  // (distance isn't passed here; if you add it later, include it)
  await processAlert({
    userId,
    walletId,
    contractId,
    tokenId,
    isActive,
    signaturePayload: {
      currentStatus: String(currentStatus || "UNKNOWN").toUpperCase(),
      lpRangeTier: String(lpRangeTier || "UNKNOWN").toUpperCase(),
    },
    state,
    logPrefix: "[LP]",
    message,
    meta: {
      prevStatus,
      currentStatus,
      lpRangeTier,
      tickLower,
      tickUpper,
      currentTick,
    },
    alertType,
  });
}

module.exports = {
  setAlertEngineClient,
  handleLiquidationAlert,
  handleRedemptionAlert,
  handleLpRangeAlert,
};
