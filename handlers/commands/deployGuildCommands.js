// handlers/commands/deployGuildCommands.js
const { REST, Routes } = require("discord.js");

const logger = require("../../utils/logger");

async function deployGuildCommands(commandsJson) {
  const { BOT_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  try {
    const data = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commandsJson }
    );

    logger.startup(`Successfully loaded ${data.length} application (/) commands.`);
  } catch (error) {
    logger.error("[deployGuildCommands] error:", error);
  }
}

module.exports = { deployGuildCommands };

