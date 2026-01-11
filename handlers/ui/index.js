// handlers/ui/index.js
const { handleMyWalletsInteraction } = require("./my-wallets-ui");
const { handleIgnoreSpamTxInteraction } = require("./ignore-spam-tx-ui");

const routers = [handleMyWalletsInteraction, handleIgnoreSpamTxInteraction];

/**
 * Runs UI routers in order; first one that returns true "claims" the interaction.
 * Each router should return boolean:
 *   true  = handled (interaction acknowledged/replied/etc.)
 *   false = not mine
 */
async function handleUiInteractionRouters(interaction) {
  for (const router of routers) {
    if (await router(interaction)) return true;
  }
  return false;
}

module.exports = { handleUiInteractionRouters };
