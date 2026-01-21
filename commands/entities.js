// commands/entities.js
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

const COOLDOWN_MS = 30_000;
const lastUsed = new Map();

function getCooldownRemainingMs(userId) {
  const last = lastUsed.get(userId) || 0;
  const now = Date.now();
  const remaining = COOLDOWN_MS - (now - last);
  return remaining > 0 ? remaining : 0;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("entities")
    .setDescription("Display system entities."),

  async execute(interaction) {
    const userId = interaction.user?.id;
    const remainingMs = userId ? getCooldownRemainingMs(userId) : 0;
    if (remainingMs > 0) {
      const waitSec = Math.ceil(remainingMs / 1000);
      await interaction.reply({
        content: `Cooldown active. Try again in ${waitSec}s.`,
        ephemeral: true,
      });
      return;
    }
    if (userId) lastUsed.set(userId, Date.now());

    const sentinelDesc = [
      "*Classification:* Observer  ",
      "*Function:* Monitors activity, patterns, and risk signals within this system.  ",
      "*Behavior:* Records, flags, and escalates.  ",
      "*Constraint:* Sentinel does not punish or intervene directly.",
    ].join("\n");

    const shieldDesc = [
      "*Classification:* Enforcer  ",
      "*Function:* Applies restriction, removal, and containment actions.  ",
      "*Behavior:* Acts decisively and without negotiation.  ",
      "*Constraint:* Shield does not warn publicly or justify enforcement.",
    ].join("\n");

    const automataDesc = [
      "*Classification:* System Processes  ",
      "*Function:* Logging, routing, access control, and automation.  ",
      "*Behavior:* Deterministic.  ",
      "*Constraint:* Automata do not exercise judgment.",
      "",
      "---",
      "",
      "*Not all system components are documented.*",
    ].join("\n");

    const sentinelTitleEmbed = new EmbedBuilder().setTitle("Liquidity Sentinel");
    const sentinelImageEmbed = new EmbedBuilder().setImage(
      "https://raw.githubusercontent.com/go140point6/liquidity-sentinel/main/img/liquidity-sentinel.png"
    );
    const sentinelBodyEmbed = new EmbedBuilder().setDescription(sentinelDesc);

    const shieldTitleEmbed = new EmbedBuilder().setTitle("Liquidity Shield");
    const shieldImageEmbed = new EmbedBuilder().setImage(
      "https://raw.githubusercontent.com/go140point6/liquidity-sentinel/main/img/liquidity-shield.png"
    );
    const shieldBodyEmbed = new EmbedBuilder().setDescription(shieldDesc);

    const automataTitleEmbed = new EmbedBuilder().setTitle("Automata");
    const automataBodyEmbed = new EmbedBuilder().setDescription(automataDesc);

    await interaction.reply({
      embeds: [
        sentinelTitleEmbed,
        sentinelImageEmbed,
        sentinelBodyEmbed,
        shieldTitleEmbed,
        shieldImageEmbed,
        shieldBodyEmbed,
        automataTitleEmbed,
        automataBodyEmbed,
      ],
    });
  },
};
