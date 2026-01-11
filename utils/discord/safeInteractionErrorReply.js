// utils/discord/safeInteractionErrorReply.js

/**
 * Best-effort user-facing error reply to avoid "This interaction failed".
 * Safe to call inside a catch; swallows secondary failures.
 */
async function safeInteractionErrorReply(
  interaction,
  content = "❌ Something went wrong handling that interaction."
) {
  try {
    if (!interaction?.isRepliable?.()) return;

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch (_) {
    // Swallow secondary failures
  }
}

module.exports = { safeInteractionErrorReply };
