// ./utils/discord/validateEnv.js

const log = require("../logger");

function validateEnv() {
  // Add any additional required env vars here
  const requiredVars = [
    "BOT_TOKEN",
    "CLIENT_ID",
    "GUILD_ID",
    "DB_PATH",
    "FIRELIGHT_CHANNEL_ID",
    "FIRELIGHT_POLL_MIN",
    "FIRELIGHT_VAULT_ADDRESS",
    "FIRELIGHT_OPEN_BUFFER",
    "SP_APR_CHANNEL_ID",
    "SP_APR_POLL_MIN",
    "SP_SIGNAL_REFERENCE_DEPOSIT_CDP",
    "SP_APR_REACTION_EMOJI",
    "SP_SNAPSHOT_STALE_WARN_HOURS",
    "SP_POSITION_SNAPSHOT_STALE_WARN_MIN",
    "NODE_CRON_WARN_THROTTLE_MS",
    "EVENT_LOOP_LAG_CHECK_MS",
    "EVENT_LOOP_LAG_WARN_MS",
    "EVENT_LOOP_LAG_EXIT_MS",
    "EVENT_LOOP_LAG_STRIKES",
  ];

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
