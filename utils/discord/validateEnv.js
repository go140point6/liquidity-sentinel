// ./utils/discord/validateEnv.js

const log = require("../logger");

function validateEnv() {
  // Add any additional required env vars here
  const requiredVars = ["BOT_TOKEN", "CLIENT_ID", "GUILD_ID" ];

  const missing = requiredVars.filter(
    (key) => !process.env[key] || !process.env[key].trim()
  );

  if (missing.length > 0) {
    log.error(
      "Missing required environment variables:\n" +
        missing.map((v) => `  - ${v}`).join("\n") +
        "\n\nFix your .env file and restart the bot."
    );
    process.exit(1);
  }

}

module.exports = { validateEnv };
