const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

const { getDb, getOrCreateUserId } = require("../db");
const { prepareQueries } = require("../db/queries");
const { ensureDmOnboarding } = require("../utils/discord/dm");
const { ephemeralFlags } = require("../utils/discord/ephemerals");
const { createDecimalFormatter } = require("../utils/intlNumberFormats");
const { formatLoanTroveLink, formatAddressLink } = require("../utils/links");
const { shortenAddress } = require("../utils/ethers/shortenAddress");
const { shortenTroveId } = require("../utils/ethers/shortenTroveId");
const logger = require("../utils/logger");

function requireNumberEnv(name) {
  const raw = process.env[name];
  if (!raw || String(raw).trim() === "") {
    throw new Error(`Missing env var ${name}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be numeric (got "${raw}")`);
  return n;
}

const LOAN_SNAPSHOT_STALE_WARN_MIN = requireNumberEnv("LOAN_SNAPSHOT_STALE_WARN_MIN");
const LOAN_SNAPSHOT_STALE_WARN_MS = Math.max(
  0,
  Math.floor(LOAN_SNAPSHOT_STALE_WARN_MIN * 60 * 1000)
);

const fmt2 = createDecimalFormatter(0, 2);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function safeJsonParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseSqliteUtcToUnix(ts) {
  if (!ts) return null;
  const iso = String(ts).includes("T") ? String(ts) : String(ts).replace(" ", "T");
  const ms = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function fmtPct(v) {
  return typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "n/a";
}

function fmtNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? fmt2.format(v) : "n/a";
}

function fmtIr(v) {
  return typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(2)}%` : "n/a";
}

function stageLabel(stage) {
  const s = Number(stage);
  if (!Number.isFinite(s)) return "n/a";
  if (s === 0) return "NEW (<25%)";
  return `${s}% reached`;
}

function currentColor(levels) {
  const maxStage = Math.max(0, ...levels.map((v) => Number(v) || 0));
  if (maxStage >= 75) return "Red";
  if (maxStage >= 25) return "Orange";
  return "DarkOrange";
}

function getActiveRedemptionSessions(db, userId) {
  const rows = db
    .prepare(
      `
      SELECT
        ast.wallet_id AS wallet_id,
        ast.contract_id AS contract_id,
        ast.token_id AS token_id,
        ast.state_json AS state_json,
        c.protocol AS protocol,
        c.chain_id AS chain_id,
        uw.address_eip55 AS wallet_address,
        uw.label AS wallet_label,
        s.snapshot_at AS snapshot_at,
        s.snapshot_json AS snapshot_json
      FROM alert_state ast
      JOIN contracts c
        ON c.id = ast.contract_id
      JOIN user_wallets uw
        ON uw.id = ast.wallet_id
      LEFT JOIN loan_position_snapshots s
        ON s.user_id = ast.user_id
       AND s.wallet_id = ast.wallet_id
       AND s.contract_id = ast.contract_id
       AND s.token_id = ast.token_id
      WHERE ast.user_id = ?
        AND ast.alert_type = 'REDEMPTION_EVENT'
        AND ast.is_active = 1
      ORDER BY c.chain_id, c.protocol, ast.token_id
    `
    )
    .all(userId);

  return rows
    .map((row) => {
      const state = safeJsonParse(row.state_json);
      const snapshot = safeJsonParse(row.snapshot_json);
      const session = state?.session || null;
      if (!session) return null;

      const latestEventUnix =
        typeof session.latestBlockTimestamp === "number" && Number.isFinite(session.latestBlockTimestamp)
          ? Math.floor(session.latestBlockTimestamp)
          : null;

      return {
        protocol: row.protocol,
        chainId: row.chain_id,
        walletAddress: row.wallet_address,
        walletLabel: row.wallet_label || snapshot?.walletLabel || null,
        tokenId: row.token_id,
        snapshotAt: row.snapshot_at || state?.snapshotAt || null,
        snapshotUnix:
          parseSqliteUtcToUnix(row.snapshot_at) || parseSqliteUtcToUnix(state?.snapshotAt) || null,
        currentStatus: snapshot?.status || "UNKNOWN",
        currentDebtAmount:
          typeof snapshot?.debtAmount === "number" && Number.isFinite(snapshot.debtAmount)
            ? snapshot.debtAmount
            : null,
        debtSymbol: snapshot?.debtSymbol || "",
        collSymbol: snapshot?.collSymbol || null,
        currentInterestPct:
          typeof snapshot?.interestPct === "number" && Number.isFinite(snapshot.interestPct)
            ? snapshot.interestPct
            : null,
        sessionInterestPct:
          typeof session.sessionInterestPct === "number" && Number.isFinite(session.sessionInterestPct)
            ? session.sessionInterestPct
            : null,
        sessionRedeemedPct:
          typeof session.sessionRedeemedPct === "number" && Number.isFinite(session.sessionRedeemedPct)
            ? session.sessionRedeemedPct
            : null,
        sessionRedeemedDebt:
          typeof session.sessionRedeemedDebt === "number" && Number.isFinite(session.sessionRedeemedDebt)
            ? session.sessionRedeemedDebt
            : null,
        sessionRedeemedColl:
          typeof session.sessionRedeemedColl === "number" && Number.isFinite(session.sessionRedeemedColl)
            ? session.sessionRedeemedColl
            : null,
        currentStage:
          typeof session.currentStage === "number" && Number.isFinite(session.currentStage)
            ? session.currentStage
            : null,
        latestEventUnix,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const sa = Number(a.currentStage) || 0;
      const sb = Number(b.currentStage) || 0;
      if (sb !== sa) return sb - sa;
      const pa = typeof a.sessionRedeemedPct === "number" ? a.sessionRedeemedPct : -1;
      const pb = typeof b.sessionRedeemedPct === "number" ? b.sessionRedeemedPct : -1;
      if (pb !== pa) return pb - pa;
      const ta = a.latestEventUnix || 0;
      const tb = b.latestEventUnix || 0;
      return tb - ta;
    });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("my-redemptions")
    .setDescription("Show current active redemption-session state for your monitored loans."),

  async execute(interaction) {
    const ephFlags = ephemeralFlags();

    try {
      await interaction.deferReply({ flags: ephFlags });

      const db = getDb();
      const q = prepareQueries(db);
      const discordId = interaction.user.id;
      const discordName = interaction.user.globalName || interaction.user.username || null;
      const userId = getOrCreateUserId(db, { discordId, discordName });

      const userRow = q.selUser.get(userId);
      const acceptsDm = userRow?.accepts_dm ?? 0;
      await ensureDmOnboarding({
        interaction,
        userId,
        discordId,
        acceptsDm,
        setUserDmStmt: q.setUserDm,
      });

      const sessions = getActiveRedemptionSessions(db, userId);
      const latestLoanSnapshotRow = db
        .prepare(
          `
          SELECT MAX(snapshot_at) AS snapshot_at
          FROM loan_position_snapshots
          WHERE user_id = ?
        `
        )
        .get(userId);
      const latestLoanSnapshotUnix = parseSqliteUtcToUnix(latestLoanSnapshotRow?.snapshot_at);

      const descLines = [
        "Current active redemption-session state for your monitored loans.",
        "_A session stays open until your loan IR changes or the redemption session completes._",
      ];

      const freshestUnix =
        Math.max(
          0,
          ...sessions.map((s) => s.snapshotUnix || 0),
          latestLoanSnapshotUnix || 0
        ) || null;

      if (freshestUnix) {
        const ageMs = Date.now() - freshestUnix * 1000;
        const stale = ageMs > LOAN_SNAPSHOT_STALE_WARN_MS;
        descLines.push("");
        descLines.push(`Data captured: <t:${freshestUnix}:f>${stale ? " ⚠️ Data may be stale." : ""}`);
      }

      if (!sessions.length) {
        descLines.push("");
        descLines.push("No active redemption sessions are currently open in the tracked window.");

        const embed = new EmbedBuilder()
          .setColor("DarkBlue")
          .setTitle("My Redemptions")
          .setDescription(descLines.join("\n"))
          .setTimestamp(new Date());
        if (interaction.client?.user) {
          embed.setThumbnail(interaction.client.user.displayAvatarURL());
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      descLines.push("");
      descLines.push(`Open sessions: **${sessions.length}**`);

      const fields = sessions.map((s) => {
        const walletText =
          formatAddressLink(s.chainId, s.walletAddress) || `**${shortenAddress(s.walletAddress)}**`;
        const troveText = formatLoanTroveLink(s.protocol, s.tokenId, shortenTroveId(s.tokenId));

        const lines = [
          `Trove: ${troveText}`,
          `Wallet: ${walletText}`,
        ];
        if (s.walletLabel) lines.push(`Label: **${s.walletLabel}**`);
        lines.push(`Status: **${s.currentStatus || "UNKNOWN"}**`);
        lines.push(`Current level: **${stageLabel(s.currentStage)}**`);
        lines.push(`Redeemed in current window: **${fmtPct(s.sessionRedeemedPct)}**`);
        lines.push(`Debt redeemed: **${fmtNum(s.sessionRedeemedDebt)}**`);
        lines.push(
          `Collateral redeemed: **${fmtNum(s.sessionRedeemedColl)}${s.collSymbol ? ` ${s.collSymbol}` : ""}**`
        );
        if (typeof s.currentDebtAmount === "number" && Number.isFinite(s.currentDebtAmount)) {
          lines.push(
            `Current debt: **${fmtNum(s.currentDebtAmount)}${s.debtSymbol ? ` ${s.debtSymbol}` : ""}**`
          );
        }
        lines.push(`Current IR / Session IR: **${fmtIr(s.currentInterestPct)} / ${fmtIr(s.sessionInterestPct)}**`);
        if (s.latestEventUnix) {
          lines.push(`Latest redemption: <t:${s.latestEventUnix}:f>`);
        }

        return {
          name: `${s.protocol || "UNKNOWN_PROTOCOL"} (${s.chainId || "?"})`,
          value: lines.join("\n").slice(0, 1024),
          inline: false,
        };
      });

      const embeds = chunk(fields, 8).map((group, idx, arr) => {
        const embed = new EmbedBuilder()
          .setColor(currentColor(sessions.map((s) => s.currentStage)))
          .setTitle(arr.length > 1 ? `My Redemptions (${idx + 1}/${arr.length})` : "My Redemptions")
          .setDescription(descLines.join("\n"))
          .addFields(group)
          .setTimestamp(new Date());
        if (interaction.client?.user) {
          embed.setThumbnail(interaction.client.user.displayAvatarURL());
        }
        return embed;
      });

      await interaction.editReply({ embeds });
    } catch (err) {
      logger.error(`[my-redemptions] failed: ${err?.stack || err?.message || err}`);
      await interaction.editReply("An error occurred while processing `/my-redemptions`.");
    }
  },
};
