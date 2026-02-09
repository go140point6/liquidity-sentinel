// commands/test-heartbeat.js
const { SlashCommandBuilder } = require("discord.js");

const { setHeartbeatTestOverride } = require("../monitoring/heartbeatTest");
const { sendDailyHeartbeat } = require("../monitoring/dailyHeartbeat");
const { ephemeralFlags } = require("../utils/discord/ephemerals");

module.exports = {
  devOnly: true,
  data: new SlashCommandBuilder()
    .setName("test-heartbeat")
    .setDescription("Trigger daily heartbeat for your current TZ/hour (dev only)"),

  async execute(interaction) {
    const ephFlags = ephemeralFlags();
    await interaction.deferReply({ flags: ephFlags });

    const discordId = interaction.user.id;
    setHeartbeatTestOverride(discordId);

    try {
      await sendDailyHeartbeat(interaction.client);
      await interaction.editReply("Heartbeat test triggered (check your DMs).");
    } catch (err) {
      await interaction.editReply(
        `Heartbeat test failed: ${err?.message || String(err)}`
      );
    }
  },
};
