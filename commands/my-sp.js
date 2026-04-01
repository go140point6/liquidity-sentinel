const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

const { getDb, getOrCreateUserId } = require("../db");
const { prepareQueries } = require("../db/queries");
const { ensureDmOnboarding } = require("../utils/discord/dm");
const { ephemeralFlags } = require("../utils/discord/ephemerals");
const { createDecimalFormatter } = require("../utils/intlNumberFormats");
const { formatAddressLink } = require("../utils/links");
const { shortenAddress } = require("../utils/ethers/shortenAddress");
const logger = require("../utils/logger");
const { getSpPositionSummaries, parseSnapshotTime } = require("../utils/stabilityPoolPositions");

function requireNumberEnv(name) {
  const raw = process.env[name];
  if (!raw || String(raw).trim() === "") {
    throw new Error(`Missing env var ${name}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be numeric (got "${raw}")`);
  return n;
}

const SP_POSITION_SNAPSHOT_STALE_WARN_MIN = requireNumberEnv("SP_POSITION_SNAPSHOT_STALE_WARN_MIN");
const STALE_WARN_MS = Math.max(0, Math.floor(SP_POSITION_SNAPSHOT_STALE_WARN_MIN * 60 * 1000));
const fmt2 = createDecimalFormatter(0, 2);
const fmt4 = createDecimalFormatter(0, 4);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fmtNum(n, digits = 2) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return (digits >= 4 ? fmt4 : fmt2).format(n);
}

function fmtPct(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return `${fmt2.format(n)}%`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("my-sp")
    .setDescription("Show current monitored Stability Pool positions."),

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

      const summaries = getSpPositionSummaries(db, userId);
      if (!summaries.length) {
        await interaction.editReply("No Stability Pool positions are currently being monitored for you.");
        return;
      }

      summaries.sort((a, b) => {
        const av = Number(a.compoundedDeposit) || 0;
        const bv = Number(b.compoundedDeposit) || 0;
        if (bv !== av) return bv - av;
        return String(a.poolLabel || "").localeCompare(String(b.poolLabel || ""));
      });

      const snapshotTimes = summaries
        .map((s) => parseSnapshotTime(s.snapshotAt)?.sec || null)
        .filter((v) => v != null);

      const descLines = [
        "Current status of your monitored Stability Pool positions.",
        "_Current deposit is your compounded CDP deposit. Claimable collateral includes stashed + newly accrued collateral._",
      ];
      if (snapshotTimes.length) {
        const latest = Math.max(...snapshotTimes);
        const ageMs = Date.now() - latest * 1000;
        const stale = ageMs > STALE_WARN_MS;
        descLines.push("");
        descLines.push(`Data captured: <t:${latest}:f>${stale ? " ⚠️ Data may be stale." : ""}`);
      }

      const fields = summaries.map((s) => {
        const walletText = formatAddressLink("FLR", s.walletAddress) || `**${shortenAddress(s.walletAddress)}**`;
        const lines = [
          `Pool: **${s.poolLabel || s.poolKey || "Unknown"}**`,
          `Wallet: ${walletText}`,
        ];
        if (s.walletLabel) lines.push(`Label: **${s.walletLabel}**`);
        lines.push(`Current deposit: **${fmtNum(Number(s.compoundedDeposit))} CDP**`);
        lines.push(`Pending CDP yield: **${fmtNum(Number(s.yieldGain))} CDP**`);
        lines.push(`Claimable collateral: **${fmtNum(Number(s.claimableCollateral), 4)} ${s.collSymbol || "COLL"}**`);
        lines.push(`Pool share: **${fmtPct(Number(s.poolSharePct))}**`);

        return {
          name: `${s.poolLabel || s.poolKey} (FLR)`,
          value: lines.join("\n"),
          inline: false,
        };
      });

      const embeds = chunk(fields, 8).map((group, idx, arr) => {
        const e = new EmbedBuilder()
          .setColor("DarkOrange")
          .setTitle(arr.length > 1 ? `My Stability Pools (${idx + 1}/${arr.length})` : "My Stability Pools")
          .setDescription(descLines.join("\n"))
          .addFields(group)
          .setTimestamp(new Date());
        if (interaction.client?.user) e.setThumbnail(interaction.client.user.displayAvatarURL());
        return e;
      });

      if (embeds.length === 1) {
        await interaction.editReply({ embeds: [embeds[0]] });
      } else {
        await interaction.editReply({ embeds });
      }
    } catch (err) {
      logger.error(`[my-sp] failed: ${err?.stack || err?.message || err}`);
      await interaction.editReply("An error occurred while processing `/my-sp`.");
    }
  },
};
