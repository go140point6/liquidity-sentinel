// commands/states.js
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
    .setName("states")
    .setDescription("Display authority states."),

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

    const description = [
      "### Authority States",
      "",
      "**⚪ Initiate**",
      "*Status:* Observed",
      "*Meaning:* Presence detected. Trust not established.",
      "*Notes:* Access is provisional.",
      "",
      "**👥 Minion**",
      "*Status:* Participant",
      "*Meaning:* Authorized to speak and observe.",
      "*Notes:* Participation does not confer influence.",
      "",
      "**🔥 Emberbearer**",
      "*Status:* Sustainer",
      "*Meaning:* Provides material support to system operation.",
      "*Notes:* Recognition only. No authority is implied.",
      "",
      "**🧩 Agent**",
      "*Status:* Contributor",
      "*Meaning:* Demonstrated helpful participation.",
      "*Notes:* Assistance is noted. Trust is not assumed.",
      "",
      "**🧠 Adept**",
      "*Status:* Trusted Helper",
      "*Meaning:* Demonstrated reliable judgment under observation.",
      "*Notes:* May be granted limited corrective capability. Final authority remains above.",
      "",
      "**🏰 Sentinel**",
      "*Status:* Moderator",
      "*Meaning:* Entrusted with observation, judgment, and escalation.",
      "*Notes:* Sentinels intervene to protect system integrity.",
      "",
      "**🜂 Archon**",
      "*Status:* Administrator",
      "*Meaning:* Defines policy and operational boundaries.",
      "*Notes:* Archons authorize force and set thresholds.",
      "",
      "**🧿 Overseer**",
      "*Status:* Final Authority",
      "*Meaning:* Absolute control of system state.",
      "*Notes:* Oversight is continuous. Visibility is optional.",
      "",
      "---",
      "",
      "*Not all states are visible at all times.*",
    ].join("\n");

    const embed = new EmbedBuilder()
      .setTitle("Authority States")
      .setDescription(description);

    await interaction.reply({ embeds: [embed] });
  },
};
