const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

const { getDb, getOrCreateUserId } = require("../db");
const { prepareQueries } = require("../db/queries");
const { ensureDmOnboarding } = require("../utils/discord/dm");
const { ephemeralFlags } = require("../utils/discord/ephemerals");
const { createDecimalFormatter } = require("../utils/intlNumberFormats");
const { formatAddressLink } = require("../utils/links");
const { shortenAddress } = require("../utils/ethers/shortenAddress");
const logger = require("../utils/logger");

const fmt0 = createDecimalFormatter(0, 0);
const fmt2 = createDecimalFormatter(2, 2);

function getApiBaseUrl() {
  const raw = String(process.env.FIRELIGHT_POINTS_API_BASE || "").trim();
  if (!raw) return "https://api.sparkdex.ai/firelight";
  return raw.replace(/\/+$/, "");
}

function getTimeoutMs() {
  const raw = Number(process.env.FIRELIGHT_POINTS_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 12000;
  return Math.floor(raw);
}

function chunkLinesForEmbed(lines, maxLen = 1024) {
  const chunks = [];
  let cur = "";
  for (const raw of lines || []) {
    const line = String(raw || "");
    if (!line) continue;

    if (!cur) {
      cur = line.slice(0, maxLen);
      continue;
    }

    if (cur.length + 1 + line.length <= maxLen) {
      cur += `\n${line}`;
      continue;
    }

    chunks.push(cur);
    cur = line.slice(0, maxLen);
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function formatNumberish(v, { preferWhole = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (preferWhole) return fmt0.format(n);
  if (Number.isInteger(n)) return fmt0.format(n);
  return fmt2.format(n);
}

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error("Invalid JSON response");
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("my-firelight")
    .setDescription("Show Firelight points for your FLR wallets and current vault stats."),

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

      const wallets = q.selUserWalletsByChain.all(userId, "FLR");
      if (!wallets.length) {
        await interaction.editReply("No enabled FLR wallets are registered for you.");
        return;
      }

      const apiBase = getApiBaseUrl();
      const timeoutMs = getTimeoutMs();

      const pointsResults = await Promise.all(
        wallets.map(async (w) => {
          const addr = String(w.address_eip55 || "").trim();
          const out = { wallet: w, points: null, ok: false, err: null };
          if (!addr) {
            out.err = "wallet address missing";
            return out;
          }
          try {
            const json = await fetchJson(
              `${apiBase}/points/${encodeURIComponent(addr)}`,
              timeoutMs
            );
            const rows = Array.isArray(json) ? json : [];
            if (!rows.length) throw new Error("points rows missing");

            let points = 0;
            let found = 0;
            for (const row of rows) {
              const n = Number(row?.points);
              if (!Number.isFinite(n)) continue;
              points += n;
              found += 1;
            }
            if (!found) throw new Error("points values missing");

            out.points = points;
            out.ok = true;
            return out;
          } catch (e) {
            out.err = e?.message || "request failed";
            return out;
          }
        })
      );

      let vaults = [];
      let vaultsErr = null;
      try {
        const json = await fetchJson(`${apiBase}/vaults`, timeoutMs);
        vaults = Array.isArray(json) ? json : [];
      } catch (e) {
        vaultsErr = e?.message || "request failed";
      }

      const walletLines = [];
      let totalPoints = 0;
      let okCount = 0;
      let failCount = 0;

      for (const r of pointsResults) {
        const addr = r.wallet?.address_eip55 || "";
        const link = formatAddressLink("FLR", addr) || `**${shortenAddress(addr)}**`;
        const label = r.wallet?.label ? ` [${r.wallet.label}]` : "";
        if (r.ok) {
          okCount += 1;
          totalPoints += Number(r.points) || 0;
          walletLines.push(`• ${link}${label}: **${formatNumberish(r.points, { preferWhole: true })}**`);
        } else {
          failCount += 1;
          walletLines.push(`• ${link}${label}: ⚪ not fetchable`);
          logger.warn(
            `[my-firelight] points fetch failed wallet=${addr || "?"} err=${r.err || "unknown"}`
          );
        }
      }

      if (okCount > 0) {
        walletLines.push("");
        walletLines.push(`Total earned points: **${formatNumberish(totalPoints, { preferWhole: true })}**`);
      } else {
        walletLines.push("");
        walletLines.push("Total earned points: ⚪ unavailable");
      }

      const vaultLines = [];
      if (vaultsErr) {
        vaultLines.push("⚪ Vault data not fetchable.");
        logger.warn(`[my-firelight] vaults fetch failed err=${vaultsErr}`);
      } else if (!vaults.length) {
        vaultLines.push("No vault data returned.");
      } else {
        for (const v of vaults) {
          const name = String(v?.name || v?.vname || "Unknown");
          const tvl = formatNumberish(v?.tvl);
          const limit = formatNumberish(v?.limit);
          const points = formatNumberish(v?.points);
          const tvlTxt = tvl != null ? tvl : "n/a";
          const limitTxt = limit != null ? limit : "n/a";
          const pointsTxt = points != null ? points : "n/a";
          vaultLines.push(`• ${name}`);
          vaultLines.push(`  Vault current: **${tvlTxt}**`);
          vaultLines.push(`  Vault max: **${limitTxt}**`);
          vaultLines.push(`  Total points: **${pointsTxt}**`);
        }
      }

      const descLines = [
        "Current Firelight points by wallet and current vault metrics.",
      ];
      if (failCount > 0 || vaultsErr) {
        descLines.push("⚠️ Some values were not fetchable.");
      }

      const embed = new EmbedBuilder()
        .setColor("DarkOrange")
        .setTitle("My Firelight")
        .setDescription(descLines.join("\n"))
        .setTimestamp(new Date());

      if (interaction.client?.user) {
        embed.setThumbnail(interaction.client.user.displayAvatarURL());
      }

      const walletChunks = chunkLinesForEmbed(walletLines, 1024);
      for (let i = 0; i < walletChunks.length; i += 1) {
        const suffix = walletChunks.length > 1 ? ` (${i + 1}/${walletChunks.length})` : "";
        embed.addFields({
          name: `Wallet points${suffix}`,
          value: walletChunks[i],
          inline: false,
        });
      }

      const vaultChunks = chunkLinesForEmbed(vaultLines, 1024);
      for (let i = 0; i < vaultChunks.length; i += 1) {
        const suffix = vaultChunks.length > 1 ? ` (${i + 1}/${vaultChunks.length})` : "";
        embed.addFields({
          name: `Vault stats${suffix}`,
          value: vaultChunks[i],
          inline: false,
        });
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error(`[my-firelight] failed: ${err?.stack || err?.message || err}`);
      await interaction.editReply("Unable to load Firelight data right now.");
    }
  },
};
