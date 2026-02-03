// commands/stats.js
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

const { getDb } = require("../db");
const { createDecimalFormatter } = require("../utils/intlNumberFormats");
const { loadPriceCache, isStableUsd, normalizeSymbol } = require("../utils/priceCache");
const { ephemeralFlags } = require("../utils/discord/ephemerals");
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

const fmt0 = createDecimalFormatter(0, 0);
const fmt2 = createDecimalFormatter(0, 2);

function parseSnapshotTime(raw) {
  if (!raw) return null;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const ts = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  return Number.isFinite(ts) ? Math.floor(ts / 1000) : null;
}

function getActiveLoanSnapshots(db) {
  const rows = db
    .prepare(
      `
      SELECT s.user_id, s.snapshot_json, s.snapshot_at
      FROM loan_position_snapshots s
      LEFT JOIN position_ignores pi
        ON pi.user_id = s.user_id
       AND pi.wallet_id = s.wallet_id
       AND pi.contract_id = s.contract_id
       AND pi.position_kind = 'LOAN'
       AND (pi.token_id IS NULL OR pi.token_id = s.token_id)
      WHERE pi.id IS NULL
    `
    )
    .all();

  const out = [];
  for (const r of rows) {
    try {
      const obj = JSON.parse(r.snapshot_json);
      if (!obj || typeof obj !== "object") continue;
      if ((obj.status || "").toString().toUpperCase() === "CLOSED") continue;
      out.push({ userId: r.user_id, snapshotAt: r.snapshot_at, data: obj });
    } catch (_) {}
  }
  return out;
}

function getActiveLpSnapshots(db) {
  const rows = db
    .prepare(
      `
      SELECT s.user_id, s.snapshot_json, s.snapshot_at
      FROM lp_position_snapshots s
      LEFT JOIN position_ignores pi
        ON pi.user_id = s.user_id
       AND pi.wallet_id = s.wallet_id
       AND pi.contract_id = s.contract_id
       AND pi.position_kind = 'LP'
       AND (pi.token_id IS NULL OR pi.token_id = s.token_id)
      WHERE pi.id IS NULL
    `
    )
    .all();

  const out = [];
  for (const r of rows) {
    try {
      const obj = JSON.parse(r.snapshot_json);
      if (!obj || typeof obj !== "object") continue;
      if ((obj.status || "").toString().toUpperCase() === "INACTIVE") continue;
      out.push({ userId: r.user_id, snapshotAt: r.snapshot_at, data: obj });
    } catch (_) {}
  }
  return out;
}

module.exports = {
  data: new SlashCommandBuilder().setName("stats").setDescription("Show system-wide tracking stats."),

  async execute(interaction) {
    try {
      await interaction.deferReply({ flags: 0 });

      const db = getDb();

      const loanSnaps = getActiveLoanSnapshots(db);
      const lpSnaps = getActiveLpSnapshots(db);

      const userIds = new Set();
      loanSnaps.forEach((r) => userIds.add(r.userId));
      lpSnaps.forEach((r) => userIds.add(r.userId));

      const userChains = new Map();
      for (const r of loanSnaps) {
        if (!userChains.has(r.userId)) userChains.set(r.userId, new Set());
        if (r.data?.chainId) userChains.get(r.userId).add(r.data.chainId);
      }
      for (const r of lpSnaps) {
        if (!userChains.has(r.userId)) userChains.set(r.userId, new Set());
        if (r.data?.chainId) userChains.get(r.userId).add(r.data.chainId);
      }

      const walletIds = new Set();
      loanSnaps.forEach((r) => {
        const id = r.data?.walletId;
        if (id != null) walletIds.add(id);
      });
      lpSnaps.forEach((r) => {
        const id = r.data?.walletId;
        if (id != null) walletIds.add(id);
      });

      const activeLoanCount = loanSnaps.length;
      const activeLpCount = lpSnaps.length;
      const totalUsers = userIds.size;

      let flareOnly = 0;
      let xdcOnly = 0;
      let multiChain = 0;
      for (const [userId, chains] of userChains.entries()) {
        const hasFlr = chains.has("FLR");
        const hasXdc = chains.has("XDC");
        if (hasFlr && hasXdc) multiChain += 1;
        else if (hasFlr) flareOnly += 1;
        else if (hasXdc) xdcOnly += 1;
      }

      const flarePct = totalUsers > 0 ? (flareOnly / totalUsers) * 100 : 0;
      const xdcPct = totalUsers > 0 ? (xdcOnly / totalUsers) * 100 : 0;
      const multiPct = totalUsers > 0 ? (multiChain / totalUsers) * 100 : 0;

      let totalLoanDebt = 0;
      for (const r of loanSnaps) {
        const n = Number(r.data?.debtAmount);
        if (Number.isFinite(n)) totalLoanDebt += n;
      }

      const priceCache = loadPriceCache(db);
      let totalLpTvl = 0;
      let pricedLpCount = 0;
      const pricedDetails = [];
      for (const r of lpSnaps) {
        const obj = r.data || {};
        const chainId = String(obj.chainId || "").toUpperCase();
        const priceMap = priceCache.get(chainId);

        const baseSym = normalizeSymbol(obj.priceBaseSymbol || obj.token0Symbol);
        const quoteSym = normalizeSymbol(obj.priceQuoteSymbol || obj.token1Symbol);
        const price = Number(obj.currentPrice);

        let priceBase = Number(priceMap?.get(baseSym));
        let priceQuote = Number(priceMap?.get(quoteSym));

        if (!Number.isFinite(priceBase) && isStableUsd(chainId, baseSym)) priceBase = 1;
        if (!Number.isFinite(priceQuote) && isStableUsd(chainId, quoteSym)) priceQuote = 1;

        if (!Number.isFinite(priceBase) && Number.isFinite(priceQuote) && Number.isFinite(price) && price > 0) {
          // price = quote per base (token1 per token0)
          priceBase = priceQuote * price;
        } else if (
          !Number.isFinite(priceQuote) &&
          Number.isFinite(priceBase) &&
          Number.isFinite(price) &&
          price > 0
        ) {
          priceQuote = priceBase / price;
        }

        if (!Number.isFinite(priceBase) || !Number.isFinite(priceQuote)) continue;

        const amount0 = Number(obj.amount0);
        const amount1 = Number(obj.amount1);
        if (!Number.isFinite(amount0) || !Number.isFinite(amount1)) continue;

        const tvl = amount0 * priceBase + amount1 * priceQuote;
        totalLpTvl += tvl;
        pricedLpCount += 1;

        pricedDetails.push({
          chainId,
          protocol: obj.protocol,
          tokenId: obj.tokenId,
          amount0,
          amount1,
          priceBase,
          priceQuote,
          baseSym,
          quoteSym,
          tvl,
        });
      }

      const lpCoveragePct = activeLpCount > 0 ? (pricedLpCount / activeLpCount) * 100 : null;

      if (pricedDetails.length) {
        const top = [...pricedDetails]
          .sort((a, b) => b.tvl - a.tvl)
          .slice(0, 50);
        for (const p of top) {
          logger.debug(
            `[stats] LP TVL ${p.chainId} ${p.protocol} token=${p.tokenId} ` +
              `${p.amount0.toFixed(4)} ${p.baseSym} @ ${p.priceBase.toFixed(6)} + ` +
              `${p.amount1.toFixed(4)} ${p.quoteSym} @ ${p.priceQuote.toFixed(6)} ` +
              `= $${p.tvl.toFixed(2)}`
          );
        }
      }

      const firelightSubs = db.prepare("SELECT COUNT(1) AS cnt FROM firelight_subscriptions").get()?.cnt || 0;

      const snapshotTimes = [...loanSnaps, ...lpSnaps]
        .map((r) => parseSnapshotTime(r.snapshotAt))
        .filter((v) => v != null);

      const latest = snapshotTimes.length ? Math.max(...snapshotTimes) : null;
      const ageMs = latest != null ? Date.now() - latest * 1000 : null;
      const stale = ageMs != null ? ageMs > SNAPSHOT_STALE_WARN_MS : false;
      const warn = stale ? " ⚠️ Data may be stale." : "";

      const descLines = [];
      if (latest != null) {
        descLines.push(`Data captured: <t:${latest}:f>${warn}`);
      } else {
        descLines.push("Data captured: n/a");
      }

      const embed = new EmbedBuilder()
        .setTitle("System Stats")
        .setColor(0x4b5563)
        .setThumbnail(interaction.client.user.displayAvatarURL())
        .setDescription(descLines.join("\n"))
        .addFields(
          { name: "Users tracking", value: fmt0.format(userIds.size), inline: true },
          { name: "Wallets tracking", value: fmt0.format(walletIds.size), inline: true },
          { name: "\u200b", value: "\u200b", inline: true },
          { name: "Active loans", value: fmt0.format(activeLoanCount), inline: true },
          { name: "Active LPs", value: fmt0.format(activeLpCount), inline: true },
          { name: "\u200b", value: "\u200b", inline: true },
          {
            name: "Flare users only",
            value: `${fmt0.format(flareOnly)} (${fmt0.format(flarePct)}%)`,
            inline: true,
          },
          {
            name: "XDC Network users only",
            value: `${fmt0.format(xdcOnly)} (${fmt0.format(xdcPct)}%)`,
            inline: true,
          },
          {
            name: "Multi-chain users",
            value: `${fmt0.format(multiChain)} (${fmt0.format(multiPct)}%)`,
            inline: true,
          },
          { name: "Total loan debt (USD)", value: `$${fmt2.format(totalLoanDebt)}`, inline: true },
          { name: "Total LP TVL (USD)", value: `$${fmt2.format(totalLpTvl)}`, inline: true },
          {
            name: "TVL coverage",
            value:
              lpCoveragePct == null
                ? "n/a"
                : `${fmt0.format(pricedLpCount)} / ${fmt0.format(activeLpCount)} (${fmt0.format(
                    lpCoveragePct
                  )}%)`,
            inline: true,
          },
          { name: "Firelight subscribers", value: fmt0.format(firelightSubs), inline: true },
          { name: "\u200b", value: "\u200b", inline: true },
          { name: "\u200b", value: "\u200b", inline: true }
        );
      embed.setTimestamp(new Date());

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error(`[stats] failed: ${err.message || err}`);
      await interaction.editReply("Failed to load stats.");
    }
  },
};
