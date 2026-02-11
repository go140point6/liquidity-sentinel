// commands/my-pool-share.js
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

const { getDb, getOrCreateUserId } = require("../db");
const { prepareQueries } = require("../db/queries");
const { ensureDmOnboarding } = require("../utils/discord/dm");
const { ephemeralFlags } = require("../utils/discord/ephemerals");
const { createDecimalFormatter } = require("../utils/intlNumberFormats");
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

const SNAPSHOT_STALE_WARN_MIN = requireNumberEnv("SNAPSHOT_STALE_WARN_MIN");
const SNAPSHOT_STALE_WARN_MS = Math.max(0, Math.floor(SNAPSHOT_STALE_WARN_MIN * 60 * 1000));
const fmtPct2 = createDecimalFormatter(2, 2);

function computePoolSharePct(liquidityRaw, poolLiquidityRaw) {
  if (!liquidityRaw || !poolLiquidityRaw) return null;
  try {
    const liq = BigInt(liquidityRaw);
    const pool = BigInt(poolLiquidityRaw);
    if (pool <= 0n) return null;
    const bps = (liq * 10000n) / pool; // 2 decimals
    return Number(bps) / 100;
  } catch {
    return null;
  }
}

function lpPoolKey(summary) {
  const chain = summary.chainId || "?";
  const protocol = summary.protocol || "UNKNOWN";
  const pair =
    summary.pairLabel ||
    `${summary.token0Symbol || summary.token0 || "?"}-${summary.token1Symbol || summary.token1 || "?"}`;
  return `${protocol}::${pair}::${chain}`;
}

function chunkFieldsBySize(fields, baseSize, maxChars) {
  const out = [];
  let current = [];
  let size = baseSize;
  for (const f of fields) {
    const fSize = (f.name?.length || 0) + (f.value?.length || 0);
    if (current.length >= 25 || size + fSize > maxChars) {
      if (current.length) out.push(current);
      current = [];
      size = baseSize;
    }
    current.push(f);
    size += fSize;
  }
  if (current.length) out.push(current);
  return out;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("my-pool-share")
    .setDescription("Show your total LP pool share by DEX/pair across all wallets."),

  async execute(interaction) {
    const ephFlags = ephemeralFlags();
    await interaction.deferReply({ flags: ephFlags });

    try {
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

      const { getLpSummaries } = require("../monitoring/lpMonitor");
      const summaries = await getLpSummaries(userId);
      const active = summaries.filter((s) => (s.status || "").toUpperCase() !== "INACTIVE");

      if (!active.length) {
        await interaction.editReply("No active LP positions are currently being monitored for you.");
        return;
      }

      const totals = new Map();
      const meta = new Map();
      for (const s of active) {
        const share = computePoolSharePct(s.liquidity, s.poolLiquidity);
        if (share == null || !Number.isFinite(share)) continue;
        const key = lpPoolKey(s);
        totals.set(key, (totals.get(key) || 0) + share);
        if (!meta.has(key)) {
          const pair =
            s.pairLabel ||
            `${s.token0Symbol || s.token0 || "?"}-${s.token1Symbol || s.token1 || "?"}`;
          meta.set(key, {
            protocol: s.protocol || "UNKNOWN",
            chainId: s.chainId || "?",
            pair,
          });
        }
      }

      if (!totals.size) {
        await interaction.editReply(
          "No pool-share data is currently available for your active LP positions."
        );
        return;
      }

      const fields = [];
      for (const [key, pct] of totals.entries()) {
        const m = meta.get(key);
        fields.push({
          name: `${m?.protocol || "UNKNOWN"} ${m?.pair || "?"} (${m?.chainId || "?"})`,
          value: `Total pool share: **${fmtPct2.format(pct)}%**`,
          inline: false,
          _pct: pct,
        });
      }
      fields.sort((a, b) => (b._pct || 0) - (a._pct || 0));

      const snapshotTimes = active
        .map((s) => (s.snapshotAt ? String(s.snapshotAt) : null))
        .filter(Boolean)
        .map((raw) => {
          const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
          const ts = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
          return Number.isFinite(ts) ? Math.floor(ts / 1000) : null;
        })
        .filter((v) => v != null);
      const latest = snapshotTimes.length ? Math.max(...snapshotTimes) : null;
      const stale = latest != null ? Date.now() - latest * 1000 > SNAPSHOT_STALE_WARN_MS : false;
      const warn = stale ? " ⚠️ Data may be stale." : "";
      const dataCaptured = latest != null ? `Data captured: <t:${latest}:f>${warn}` : "Data captured: n/a";

      const chunks = chunkFieldsBySize(fields, "My Pool Share".length + dataCaptured.length + 250, 5200);
      const embeds = chunks.map((chunk, idx) => {
        const e = new EmbedBuilder()
          .setTitle(idx === 0 ? "My Pool Share" : "My Pool Share (cont.)")
          .setColor("DarkBlue")
          .setThumbnail(interaction.client.user.displayAvatarURL())
          .addFields(chunk);
        if (idx === chunks.length - 1) {
          e.setDescription(dataCaptured);
          e.setTimestamp(new Date());
        }
        return e;
      });

      await interaction.editReply({ embeds: [embeds[0]] });
      for (let i = 1; i < embeds.length; i += 1) {
        await interaction.followUp({ embeds: [embeds[i]], flags: ephFlags });
      }
    } catch (err) {
      logger.error(`[my-pool-share] failed: ${err?.message || err}`);
      await interaction.editReply("Failed to load pool-share totals.");
    }
  },
};

