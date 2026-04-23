const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

const { getDb } = require("../db");
const { ephemeralFlags } = require("../utils/discord/ephemerals");
const { createDecimalFormatter } = require("../utils/intlNumberFormats");
const logger = require("../utils/logger");
const { loadPriceCache } = require("../utils/priceCache");
const {
  getLatestStabilityPoolSnapshots,
  getPoolShortLabel,
  recommendSinglePoolAllocation,
} = require("../utils/stabilityPoolSignals");

function requireNumberEnv(name) {
  const raw = process.env[name];
  if (!raw || String(raw).trim() === "") {
    throw new Error(`Missing env var ${name}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive number (got "${raw}")`);
  }
  return n;
}

const SP_SNAPSHOT_STALE_WARN_HOURS = requireNumberEnv("SP_SNAPSHOT_STALE_WARN_HOURS");

const fmt2 = createDecimalFormatter(2, 2);

function fmtPct(v) {
  if (!Number.isFinite(v)) return "n/a";
  return `${fmt2.format(v)}%`;
}

function fmtCdp(v) {
  if (!Number.isFinite(v)) return "n/a";
  return `${fmt2.format(v)} CDP`;
}

function fmtUsdFromCdp(v, cdpUsdPrice) {
  if (!Number.isFinite(v)) return "n/a";
  if (!Number.isFinite(cdpUsdPrice) || cdpUsdPrice <= 0) return "n/a";
  return `$${fmt2.format(v * cdpUsdPrice)}`;
}

function parseSnapshotTime(raw) {
  if (!raw) return null;
  const iso = String(raw).includes("T") ? String(raw) : String(raw).replace(" ", "T");
  const ms = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (!Number.isFinite(ms)) return null;
  return {
    ms,
    sec: Math.floor(ms / 1000),
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("best-sp-deposit")
    .setDescription("Estimate the best single Stability Pool for a CDP deposit.")
    .addNumberOption((o) =>
      o
        .setName("amount")
        .setDescription("Amount of CDP you want to deposit")
        .setRequired(true)
        .setMinValue(0.000001)
    )
    .addStringOption((o) =>
      o
        .setName("preference")
        .setDescription("Reward preference for ranking")
        .setRequired(true)
        .addChoices(
          { name: "Overall", value: "OVERALL" },
          { name: "CDP", value: "CDP" },
          { name: "APS", value: "APS" },
          { name: "RFLR", value: "RFLR" }
        )
    ),

  async execute(interaction) {
    const ephFlags = ephemeralFlags();
    await interaction.deferReply({ flags: ephFlags });

    try {
      const amount = Number(interaction.options.getNumber("amount", true));
      const preference = String(interaction.options.getString("preference") || "OVERALL").toUpperCase();
      if (!Number.isFinite(amount) || amount <= 0) {
        await interaction.editReply("Amount must be greater than 0.");
        return;
      }

      const db = getDb();
      const priceMap = loadPriceCache(db).get("FLR");
      const cdpUsdPrice = Number(priceMap?.get("CDP"));
      const snapshots = getLatestStabilityPoolSnapshots(db, "FLR");
      if (!snapshots.length) {
        await interaction.editReply("No Stability Pool snapshots are available yet. Run the hourly snapshot job first.");
        return;
      }

      let ranked = recommendSinglePoolAllocation(snapshots, amount);
      const rankValue = (row) => {
        if (preference === "CDP") return Number(row.dailyFeeReturn);
        if (preference === "APS") return Number(row.dailyApsReturn);
        if (preference === "RFLR") return Number(row.dailyRflrReturn);
        return Number(row.dailyReturn);
      };
      ranked = ranked.slice().sort((a, b) => {
        const av = rankValue(a);
        const bv = rankValue(b);
        const safeA = Number.isFinite(av) ? av : -Infinity;
        const safeB = Number.isFinite(bv) ? bv : -Infinity;
        if (safeB !== safeA) return safeB - safeA;
        return (Number(b.dailyReturn) || 0) - (Number(a.dailyReturn) || 0);
      });
      if (!ranked.length) {
        await interaction.editReply("No Stability Pool recommendation is available yet. Wait for a successful hourly snapshot.");
        return;
      }

      const newestMs = Math.max(...ranked.map((row) => parseSnapshotTime(row.snapshotAt)?.ms || 0));
      const newestSec = Math.floor(newestMs / 1000);
      const staleWarnMs = SP_SNAPSHOT_STALE_WARN_HOURS * 60 * 60 * 1000;
      const isStale = Number.isFinite(newestMs) && newestMs > 0 && (Date.now() - newestMs) >= staleWarnMs;
      const best = ranked[0];

      const embed = new EmbedBuilder()
        .setColor("DarkOrange")
        .setTitle("Best Stability Pool Deposit")
        .setDescription(
          [
            `Best single-pool allocation for **${fmtCdp(amount)}** based on the latest stored 24h realized snapshots and post-deposit dilution.`,
            `Preference: **${preference === "OVERALL" ? "Overall" : preference}**.`,
            `Recommendation: **${getPoolShortLabel(best)}**.`,
            Number.isFinite(newestSec) && newestSec > 0
              ? `Snapshot: <t:${newestSec}:f>${isStale ? " ⚠️ Data may be stale." : ""}`
              : null,
          ].filter(Boolean).join("\n")
        )
        .setTimestamp(new Date());

      if (interaction.client?.user) {
        embed.setThumbnail(interaction.client.user.displayAvatarURL());
      }

      for (const [idx, row] of ranked.entries()) {
        const breakdown = [
          Number.isFinite(row.feeAprPct) ? fmtPct(row.feeAprPct) : "n/a",
          Number.isFinite(row.apsAprPct) ? fmtPct(row.apsAprPct) : "n/a",
          Number.isFinite(row.rflrAprPct) ? fmtPct(row.rflrAprPct) : "n/a",
        ].join(" / ");
        const preferredReturn =
          preference === "CDP"
            ? row.dailyFeeReturn
            : preference === "APS"
              ? row.dailyApsReturn
              : preference === "RFLR"
                ? row.dailyRflrReturn
                : row.dailyReturn;
        const preferredWeeklyReturn =
          preference === "CDP"
            ? row.weeklyFeeReturn
            : preference === "APS"
              ? row.weeklyApsReturn
              : preference === "RFLR"
                ? row.weeklyRflrReturn
                : row.weeklyReturn;

        embed.addFields({
          name: `${idx + 1}. ${getPoolShortLabel(row)}`,
          value: [
            `Current 24h realized APR: **${fmtPct(row.aprPct)}**`,
            `Estimated post-deposit APR: **${fmtPct(row.dilutedAprPct)}**`,
            `APR breakdown (fees / APS / rFLR): **${breakdown}**`,
            `Estimated daily return: **${fmtUsdFromCdp(row.dailyReturn, cdpUsdPrice)}**`,
            `Preferred daily return (${preference === "OVERALL" ? "overall" : preference}): **${fmtUsdFromCdp(preferredReturn, cdpUsdPrice)}**`,
            `Daily return breakdown: **${[
              `fees ${fmtUsdFromCdp(row.dailyFeeReturn, cdpUsdPrice)}`,
              `APS ${fmtUsdFromCdp(row.dailyApsReturn, cdpUsdPrice)}`,
              `rFLR ${fmtUsdFromCdp(row.dailyRflrReturn, cdpUsdPrice)}`,
            ].join(" / ")}**`,
            `Estimated weekly return: **${fmtUsdFromCdp(row.weeklyReturn, cdpUsdPrice)}**`,
            `Preferred weekly return (${preference === "OVERALL" ? "overall" : preference}): **${fmtUsdFromCdp(preferredWeeklyReturn, cdpUsdPrice)}**`,
            `Weekly return breakdown: **${[
              `fees ${fmtUsdFromCdp(row.weeklyFeeReturn, cdpUsdPrice)}`,
              `APS ${fmtUsdFromCdp(row.weeklyApsReturn, cdpUsdPrice)}`,
              `rFLR ${fmtUsdFromCdp(row.weeklyRflrReturn, cdpUsdPrice)}`,
            ].join(" / ")}**`,
            `Your deposit vs pool: **${fmtPct(row.depositPctOfPool)}**`,
            `Current pool size: **${fmtCdp(row.poolSize)}**`,
          ].join("\n"),
          inline: false,
        });
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error(`[best-sp-deposit] failed: ${err?.stack || err?.message || err}`);
      await interaction.editReply("Unable to load a Stability Pool recommendation right now.");
    }
  },
};
