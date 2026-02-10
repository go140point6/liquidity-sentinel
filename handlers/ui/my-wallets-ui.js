// handlers/ui/my-wallets-ui.js
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require("discord.js");

const logger = require("../../utils/logger");

const { getDb, getOrCreateUserId, getOrCreateWalletId } = require("../../db");
const { prepareQueries } = require("../../db/queries");
const { ephemeralFlags } = require("../../utils/discord/ephemerals");
const { shortenAddress } = require("../../utils/ethers/shortenAddress");
const { formatAddressLink } = require("../../utils/links");

const DEFAULT_HEARTBEAT_TZ = "America/Los_Angeles";
const TZ_LIST = typeof Intl.supportedValuesOf === "function"
  ? Intl.supportedValuesOf("timeZone")
  : [
      "UTC",
      "America/Los_Angeles",
      "America/Denver",
      "America/Chicago",
      "America/New_York",
      "Europe/London",
      "Europe/Berlin",
      "Asia/Tokyo",
      "Asia/Singapore",
    ];

function getTzRegions() {
  const regions = new Set();
  for (const tz of TZ_LIST) {
    const [region] = tz.split("/");
    regions.add(region || "Other");
  }
  return Array.from(regions).sort();
}

function getTzForRegion(region) {
  return TZ_LIST.filter((tz) => {
    const [r] = tz.split("/");
    return (r || "Other") === region;
  }).sort();
}

function getRegionFromTz(tz) {
  if (!tz) return null;
  const [region] = String(tz).split("/");
  return region || null;
}

function formatHourLabel(hour) {
  if (!Number.isInteger(hour)) return "n/a";
  const h = hour % 24;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, "0")}:00 ${suffix}`;
}

// ===================== UI LOCK START =====================
// One in-flight mw action per user. Everything else is ACKed and ignored.
const MW_LOCK_TTL_MS = 2500;
const mwLocks = new Map(); // actorId -> { until:number, seq:number }

function nowMs() {
  return Date.now();
}

function acquireLock(actorId) {
  const t = nowMs();
  const cur = mwLocks.get(actorId);
  if (cur && cur.until > t) return null; // locked

  const next = { until: t + MW_LOCK_TTL_MS, seq: (cur?.seq || 0) + 1 };
  mwLocks.set(actorId, next);
  return next.seq;
}

function releaseLock(actorId, seq) {
  const cur = mwLocks.get(actorId);
  if (!cur) return;
  if (cur.seq !== seq) return;
  mwLocks.delete(actorId);
}
// ====================== UI LOCK END ======================

// ---------------- UI helpers ----------------

function buildWalletsEmbed({ discordName, wallets, heartbeatHour, heartbeatTz, heartbeatEnabled }) {
  const hbTz = heartbeatTz || DEFAULT_HEARTBEAT_TZ;
  const hbHour = Number.isInteger(heartbeatHour) ? heartbeatHour : 3;
  const hbEnabled = heartbeatEnabled !== 0;
  const hbLine = `Heartbeat: **${formatHourLabel(hbHour)}** (${hbTz})${
    hbEnabled ? "" : " — _disabled_"
  }`;
  const embed = new EmbedBuilder()
    .setTitle("My Wallets")
    .setDescription(
      [
        discordName ? `User: **${discordName}**` : null,
        hbLine,
      ]
        .filter(Boolean)
        .join("\n")
    );

  const enabled = (wallets || []).filter((w) => w.is_enabled === 1);

  if (!enabled.length) {
    embed.addFields({ name: "Wallets", value: "_No wallets added yet._" });
    return embed;
  }

  const byChain = new Map();
  for (const w of enabled) {
    const k = w.chain_id || "UNKNOWN";
    if (!byChain.has(k)) byChain.set(k, []);
    byChain.get(k).push(w);
  }

  for (const [chain, list] of byChain.entries()) {
    const lines = list.map((w) => {
      const label = w.label ? `**${w.label}** ` : "";
      const walletLink = formatAddressLink(w.chain_id, w.address_eip55);
      const lpMode = w.lp_alerts_status_only === 1 ? "LP alerts: status only" : "LP alerts: status + tier";
      return `• ${label}${walletLink} _(${lpMode})_`;
    });
    embed.addFields({ name: chain, value: lines.join("\n"), inline: false });
  }

  return embed;
}

function mainButtonsRow({ userKey }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mw:add:${userKey}`)
      .setLabel("Add wallet")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`mw:remove:${userKey}`)
      .setLabel("Remove wallet")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mw:flags:${userKey}`)
      .setLabel("Flags")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mw:heartbeat:${userKey}`)
      .setLabel("Heartbeat")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mw:done:${userKey}`)
      .setLabel("Done")
      .setStyle(ButtonStyle.Success)
  );
}

function cancelRow({ userKey }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mw:cancel:${userKey}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

function chainSelectRow({ userKey, chains }) {
  const options = (chains || [])
    .filter((c) => c && c.id != null && String(c.id).trim() !== "")
    .map((c) => ({
      label: `${String(c.id).trim()} — ${c.name != null ? String(c.name) : ""}`.trim(),
      value: String(c.id).trim(),
    }))
    .slice(0, 25);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mw:chain:${userKey}`)
    .setPlaceholder("Select a chain")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

function removeSelectRow({ userKey, wallets }) {
  const enabled = (wallets || []).filter((w) => w.is_enabled === 1);

  const options = enabled.slice(0, 25).map((w) => ({
    label: `${w.chain_id} ${w.label ? `— ${w.label}` : ""}`.trim(),
    description: shortenAddress(w.address_eip55),
    value: String(w.id),
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mw:rmselect:${userKey}`)
    .setPlaceholder("Select a wallet to disable")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

function flagsSelectRow({ userKey, wallets }) {
  const enabled = (wallets || []).filter((w) => w.is_enabled === 1);

  const options = enabled.slice(0, 25).map((w) => {
    const lpMode = w.lp_alerts_status_only === 1 ? "LP: status only" : "LP: status + tier";
    return {
      label: `${w.chain_id} ${w.label ? `— ${w.label}` : ""}`.trim(),
      description: `${shortenAddress(w.address_eip55)} · ${lpMode}`,
      value: String(w.id),
    };
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mw:flagsel:${userKey}`)
    .setPlaceholder("Select a wallet to toggle LP alert mode")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

function walletModal({ userKey, chainId }) {
  const modal = new ModalBuilder()
    .setCustomId(`mw:modal:${userKey}:${chainId}`)
    .setTitle(`Add Wallet (${chainId})`);

  const addressInput = new TextInputBuilder()
    .setCustomId("address")
    .setLabel("Wallet address (0x… or xdc…)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const labelInput = new TextInputBuilder()
    .setCustomId("label")
    .setLabel("Label (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(addressInput),
    new ActionRowBuilder().addComponents(labelInput)
  );

  return modal;
}

function heartbeatRegionRow({ userKey }) {
  const regions = getTzRegions().slice(0, 25).map((r) => ({
    label: r,
    value: r,
  }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mw:hbregion:${userKey}`)
    .setPlaceholder("Select a region")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(regions);
  return new ActionRowBuilder().addComponents(menu);
}

function heartbeatTzRow({ userKey, region, page }) {
  const all = getTzForRegion(region);
  const pageSize = 23; // leave room for Prev/Next options
  const maxPage = Math.max(0, Math.ceil(all.length / pageSize) - 1);
  const safePage = Math.min(Math.max(page, 0), maxPage);
  const slice = all.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const options = slice.map((tz) => ({ label: tz, value: tz }));

  if (safePage > 0) {
    options.unshift({ label: "← Prev page", value: "__prev__" });
  }
  if (safePage < maxPage) {
    options.push({ label: "Next page →", value: "__next__" });
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mw:hbtz:${userKey}:${region}:${safePage}`)
    .setPlaceholder(`Select a timezone (${region})`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);
  return new ActionRowBuilder().addComponents(menu);
}

function heartbeatTzPager({ userKey, region, page }) {
  const all = getTzForRegion(region);
  const pageSize = 23; // keep in sync with heartbeatTzRow
  const maxPage = Math.max(0, Math.ceil(all.length / pageSize) - 1);
  const safePage = Math.min(Math.max(page, 0), maxPage);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mw:hbpage:${userKey}:${region}:${safePage - 1}`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId(`mw:hbpage:${userKey}:${region}:${safePage + 1}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= maxPage),
    new ButtonBuilder()
      .setCustomId(`mw:hbkeep:${userKey}`)
      .setLabel("Use current TZ")
      .setStyle(ButtonStyle.Primary)
  );
}

function heartbeatModal({ userKey, currentHour, enabled }) {
  const modal = new ModalBuilder()
    .setCustomId(`mw:hbmodal:${userKey}`)
    .setTitle("Daily Heartbeat Schedule");

  const hourInput = new TextInputBuilder()
    .setCustomId("hour")
    .setLabel("Hour (0-23, your local time)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  if (Number.isInteger(currentHour)) {
    hourInput.setValue(String(currentHour));
  }

  const enabledInput = new TextInputBuilder()
    .setCustomId("enabled")
    .setLabel("Enable heartbeat? (yes/no)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  if (enabled === 0) enabledInput.setValue("no");
  if (enabled === 1) enabledInput.setValue("yes");

  modal.addComponents(
    new ActionRowBuilder().addComponents(hourInput),
    new ActionRowBuilder().addComponents(enabledInput)
  );

  return modal;
}

function heartbeatModalWithTz({ userKey, tz, currentHour, enabled }) {
  const modal = new ModalBuilder()
    .setCustomId(`mw:hbmodal:${userKey}:${tz}`)
    .setTitle("Daily Heartbeat Schedule");

  const hourInput = new TextInputBuilder()
    .setCustomId("hour")
    .setLabel("Hour (0-23, your local time)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  if (Number.isInteger(currentHour)) {
    hourInput.setValue(String(currentHour));
  }

  const enabledInput = new TextInputBuilder()
    .setCustomId("enabled")
    .setLabel("Enable heartbeat? (yes/no)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  if (enabled === 0) enabledInput.setValue("no");
  if (enabled === 1) enabledInput.setValue("yes");

  modal.addComponents(
    new ActionRowBuilder().addComponents(hourInput),
    new ActionRowBuilder().addComponents(enabledInput)
  );

  return modal;
}

// ---------------- Renders ----------------

function renderMain({ actorId, discordName, userId, q }) {
  const wallets = q.selUserWallets.all(userId);
  const userRow = q.selUser.get(userId);
  const embed = buildWalletsEmbed({
    discordName,
    wallets,
    heartbeatHour: userRow?.heartbeat_hour,
    heartbeatTz: userRow?.heartbeat_tz,
    heartbeatEnabled: userRow?.heartbeat_enabled,
  });
  return { content: "", embeds: [embed], components: [mainButtonsRow({ userKey: actorId })] };
}

function renderChainPick({ actorId, q }) {
  const chainsRaw = q.selChains.all();
  const chains = (chainsRaw || []).filter((c) => c && c.id != null && String(c.id).trim() !== "");

  const embed = new EmbedBuilder()
    .setTitle("Add Wallet")
    .setDescription("Pick the chain for the wallet you want to add.");

  if (!chains.length) {
    embed.addFields({
      name: "No chains configured",
      value: "The `chains` table has no valid chain IDs.",
    });
    return { content: "", embeds: [embed], components: [cancelRow({ userKey: actorId })] };
  }

  return {
    content: "",
    embeds: [embed],
    components: [chainSelectRow({ userKey: actorId, chains }), cancelRow({ userKey: actorId })],
  };
}

function renderRemovePick({ actorId, userId, q }) {
  const wallets = q.selUserWallets.all(userId);
  const enabled = wallets.filter((w) => w.is_enabled === 1);

  const embed = new EmbedBuilder()
    .setTitle("Remove Wallet")
    .setDescription("Select a wallet to disable (it won’t be monitored).");

  if (!enabled.length) {
    embed.addFields({ name: "Wallets", value: "_No enabled wallets to remove._" });
    return { content: "", embeds: [embed], components: [cancelRow({ userKey: actorId })] };
  }

  return {
    content: "",
    embeds: [embed],
    components: [removeSelectRow({ userKey: actorId, wallets }), cancelRow({ userKey: actorId })],
  };
}

function renderFlagsPick({ actorId, userId, q }) {
  const wallets = q.selUserWallets.all(userId);
  const enabled = wallets.filter((w) => w.is_enabled === 1);

  const embed = new EmbedBuilder()
    .setTitle("LP Alert Mode")
    .setDescription(
      [
        "Toggle LP alert mode for a wallet (status-only vs status + tier).",
        "Status = In Range or Out of Range.",
        "Tier = how close you are to the edge within that status.",
      ].join("\n")
    );

  if (!enabled.length) {
    embed.addFields({ name: "Wallets", value: "_No enabled wallets to update._" });
    return { content: "", embeds: [embed], components: [cancelRow({ userKey: actorId })] };
  }

  return {
    content: "",
    embeds: [embed],
    components: [flagsSelectRow({ userKey: actorId, wallets }), cancelRow({ userKey: actorId })],
  };
}

// ---------------- ACK helpers ----------------

async function ackUpdate(i) {
  // Buttons/selects only (silent)
  if (i.deferred || i.replied) return;
  try {
    await i.deferUpdate();
  } catch (_) {}
}

async function replyOnce(i, content, flags) {
  // Used only for real errors; avoid spamming confirmations
  try {
    if (i.deferred || i.replied) {
      await i.followUp({ content, flags });
    } else {
      await i.reply({ content, flags });
    }
  } catch (_) {}
}

/**
 * Handle all mw:* interactions.
 * Returns true if handled, false if not ours.
 */
async function handleMyWalletsInteraction(interaction) {
  const isMw = typeof interaction.customId === "string" && interaction.customId.startsWith("mw:");
  const isRelevantType =
    interaction.isButton?.() ||
    interaction.isStringSelectMenu?.() ||
    interaction.isModalSubmit?.();

  if (!isRelevantType || !isMw) return false;

  const actorId = interaction.user?.id;
  if (!actorId) return false;

  // Decide ephemeral/public once for this interaction
  const ephFlags = ephemeralFlags();

  // Parse early
  const parts = interaction.customId.split(":");
  const ns = parts[0];
  const action = parts[1];
  if (ns !== "mw") return false;

  // Scope check (mw:<action>:<userKey> or mw:modal:<userKey>:<chainId>)
  const userKey = parts[2];
  if (!userKey || userKey !== actorId) {
    await ackUpdate(interaction);
    return true;
  }

  // Acquire lock per user
  const seq = acquireLock(actorId);
  if (!seq) {
    await ackUpdate(interaction);
    return true;
  }

  const db = getDb();
  const q = prepareQueries(db);

  try {
    const discordName = interaction.user.globalName || interaction.user.username || null;

    // NEW: Canonical user lookup/creation (no selUserByDiscordId dependency)
    const userId = getOrCreateUserId(db, { discordId: actorId, discordName });
    if (!userId) {
      await ackUpdate(interaction);
      await replyOnce(interaction, "❌ Could not create/load your user record. Try /my-wallets again.", ephFlags);
      return true;
    }

    // ---------------- Modal submit ----------------
    if (interaction.isModalSubmit?.() && action === "modal") {
      const chainId = parts[3];

      // ACK the modal submit
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: ephFlags }).catch(() => {});
      }

      const addressInput = interaction.fields.getTextInputValue("address");
      const labelInput = (interaction.fields.getTextInputValue("label") || "").trim() || null;

      try {
        getOrCreateWalletId(db, { userId, chainId, addressInput, label: labelInput });
      } catch (err) {
        await interaction.editReply({ content: `❌ Could not save wallet: ${err.message}` }).catch(() => {});
        return true;
      }

      // Render the updated UI as the modal response (reliable)
      await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
      return true;
    }

    if (interaction.isModalSubmit?.() && action === "hbmodal") {
      const canUpdate = Boolean(interaction.message);
      if (!canUpdate && !interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: ephFlags }).catch(() => {});
      }

      const tzFromCustom = parts[3];
      if (tzFromCustom && !TZ_LIST.includes(tzFromCustom)) {
        await interaction.editReply({
          content: "❌ Invalid timezone selection. Please try again.",
        }).catch(() => {});
        return true;
      }
      const hourRaw = (interaction.fields.getTextInputValue("hour") || "").trim();
      const enabledRaw = (interaction.fields.getTextInputValue("enabled") || "").trim().toLowerCase();

      const hour = Number(hourRaw);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        await interaction.editReply({
          content: "❌ Hour must be an integer from 0–23.",
        }).catch(() => {});
        return true;
      }

      let enabled = 1;
      if (enabledRaw) {
        if (["no", "n", "off", "disable", "disabled", "0"].includes(enabledRaw)) enabled = 0;
        else if (["yes", "y", "on", "enable", "enabled", "1"].includes(enabledRaw)) enabled = 1;
        else {
          await interaction.editReply({
            content: "❌ Enable must be yes/no (or leave blank).",
          }).catch(() => {});
          return true;
        }
      }

      const userRow = q.selUser.get(userId);
      const tz = tzFromCustom || userRow?.heartbeat_tz || DEFAULT_HEARTBEAT_TZ;
      q.setUserHeartbeat.run(hour, enabled, tz, userId);
      if (canUpdate) {
        await interaction.update(renderMain({ actorId, discordName, userId, q })).catch(() => {});
      } else {
        await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
      }
      return true;
    }

    // ---------------- Buttons ----------------
    if (interaction.isButton?.()) {
      if (action === "done") {
        await interaction.update({ content: "✅ Done.", embeds: [], components: [] }).catch(() => {});
        return true;
      }

      if (action === "cancel") {
        await interaction.update(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        return true;
      }

      if (action === "add") {
        await interaction.update(renderChainPick({ actorId, q })).catch(() => {});
        return true;
      }

      if (action === "remove") {
        await interaction.update(renderRemovePick({ actorId, userId, q })).catch(() => {});
        return true;
      }

      if (action === "flags") {
        await interaction.update(renderFlagsPick({ actorId, userId, q })).catch(() => {});
        return true;
      }

      if (action === "heartbeat") {
        const userRow = q.selUser.get(userId);
        const userRegion = getRegionFromTz(userRow?.heartbeat_tz) || "America";
        try {
          const embed = new EmbedBuilder()
            .setTitle("Daily Heartbeat")
            .setDescription(
              [
                "Select a region, then pick your timezone.",
                "Or choose **Use current TZ** to keep your existing timezone.",
              ].join("\n")
            );
          await interaction.update({
            embeds: [embed],
            components: [
              heartbeatRegionRow({ userKey: actorId }),
              heartbeatTzPager({ userKey: actorId, region: userRegion, page: 0 }),
              cancelRow({ userKey: actorId }),
            ],
          });
        } catch (err) {
          await ackUpdate(interaction);
          await replyOnce(interaction, `❌ Could not open the modal: ${err.message}`, ephFlags);
        }
        return true;
      }

      if (action === "hbkeep") {
        const userRow = q.selUser.get(userId);
        try {
          await interaction.showModal(
            heartbeatModalWithTz({
              userKey: actorId,
              tz: userRow?.heartbeat_tz || DEFAULT_HEARTBEAT_TZ,
              currentHour: userRow?.heartbeat_hour ?? null,
              enabled: userRow?.heartbeat_enabled ?? 1,
            })
          );
        } catch (err) {
          await ackUpdate(interaction);
          await replyOnce(interaction, `❌ Could not open the modal: ${err.message}`, ephFlags);
        }
        return true;
      }

      if (action === "hbpage") {
        const region = parts[3];
        const page = Number(parts[4]);
        const embed = new EmbedBuilder()
          .setTitle("Daily Heartbeat")
          .setDescription(`Select a timezone in **${region}**.`);
        await interaction.update({
          embeds: [embed],
          components: [
            heartbeatTzRow({ userKey: actorId, region, page }),
            heartbeatTzPager({ userKey: actorId, region, page }),
            cancelRow({ userKey: actorId }),
          ],
        });
        return true;
      }

      await ackUpdate(interaction);
      return true;
    }

    // ---------------- Select menus ----------------
    if (interaction.isStringSelectMenu?.()) {
      if (action === "chain") {
        const chainId = interaction.values?.[0];

        // showModal is the ACK for select menu interactions
        try {
          await interaction.showModal(walletModal({ userKey: actorId, chainId }));
        } catch (err) {
          await ackUpdate(interaction);
          await replyOnce(interaction, `❌ Could not open the modal: ${err.message}`, ephFlags);
          await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        }
        return true;
      }

      if (action === "rmselect") {
        const walletIdStr = interaction.values?.[0];
        const walletId = Number(walletIdStr);

        if (!Number.isFinite(walletId)) {
          await interaction.update(renderMain({ actorId, discordName, userId, q })).catch(() => {});
          await replyOnce(interaction, "❌ Invalid wallet selection.", ephFlags);
          return true;
        }

        q.disableWallet.run(walletId, userId);
        await interaction.update(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        return true;
      }

      if (action === "flagsel") {
        const walletIdStr = interaction.values?.[0];
        const walletId = Number(walletIdStr);

        if (!Number.isFinite(walletId)) {
          await interaction.update(renderMain({ actorId, discordName, userId, q })).catch(() => {});
          await replyOnce(interaction, "❌ Invalid wallet selection.", ephFlags);
          return true;
        }

        const walletRow = q.selUserWalletByIdForUser.get(walletId, userId);
        if (!walletRow) {
          await interaction.update(renderMain({ actorId, discordName, userId, q })).catch(() => {});
          await replyOnce(interaction, "❌ Wallet not found for your user.", ephFlags);
          return true;
        }

        const nextVal = walletRow.lp_alerts_status_only === 1 ? 0 : 1;
        q.setWalletLpStatusOnly.run(nextVal, walletId, userId);

        await interaction.update(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        return true;
      }

      if (action === "hbregion") {
        const region = interaction.values?.[0];
        const embed = new EmbedBuilder()
          .setTitle("Daily Heartbeat")
          .setDescription(`Select a timezone in **${region}**.`);
        await interaction.update({
          embeds: [embed],
          components: [
            heartbeatTzRow({ userKey: actorId, region, page: 0 }),
            heartbeatTzPager({ userKey: actorId, region, page: 0 }),
            cancelRow({ userKey: actorId }),
          ],
        });
        return true;
      }

      if (action === "hbtz") {
        const region = parts[3];
        const page = Number(parts[4] || 0);
        const tz = interaction.values?.[0];

        if (tz === "__next__" || tz === "__prev__") {
          const nextPage = tz === "__next__" ? page + 1 : page - 1;
          const embed = new EmbedBuilder()
            .setTitle("Daily Heartbeat")
            .setDescription(`Select a timezone in **${region}**.`);
          await interaction.update({
            embeds: [embed],
            components: [
              heartbeatTzRow({ userKey: actorId, region, page: nextPage }),
              heartbeatTzPager({ userKey: actorId, region, page: nextPage }),
              cancelRow({ userKey: actorId }),
            ],
          });
          return true;
        }
        const userRow = q.selUser.get(userId);
        try {
          await interaction.showModal(
            heartbeatModalWithTz({
              userKey: actorId,
              tz,
              currentHour: userRow?.heartbeat_hour ?? null,
              enabled: userRow?.heartbeat_enabled ?? 1,
            })
          );
        } catch (err) {
          await ackUpdate(interaction);
          await replyOnce(interaction, `❌ Could not open the modal: ${err.message}`, ephFlags);
        }
        return true;
      }
    }

    await ackUpdate(interaction);
    return true;
  } catch (err) {
    logger.error("[my-wallets-ui] router error:", err);
    await ackUpdate(interaction);
    await replyOnce(interaction, `❌ Error: ${err.message}`, ephFlags);
    return true;
  } finally {
    releaseLock(actorId, seq);
  }
}

module.exports = {
  handleMyWalletsInteraction,
  renderMain,
};
