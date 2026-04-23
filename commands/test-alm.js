const { SlashCommandBuilder } = require("discord.js");
const { MessageFlags } = require("discord-api-types/v10");
const {
  getTestOffsets,
  adjustAlmFlowGlobal,
  clearAlmFlowGlobal,
} = require("../monitoring/testOffsets");

function formatState() {
  const s = getTestOffsets();
  const g = s.almFlowAll || { delta0: 0, delta1: 0 };
  const g0 = Number(g.delta0 || 0);
  const g1 = Number(g.delta1 || 0);
  const lines = [
    "ALM synthetic flow (global):",
    `- token0: ${g0 >= 0 ? "+" : ""}${g0}`,
    `- token1: ${g1 >= 0 ? "+" : ""}${g1}`,
  ];
  return lines.join("\n");
}

module.exports = {
  devOnly: true,
  data: new SlashCommandBuilder()
    .setName("test-alm")
    .setDescription("Adjust in-memory ALM synthetic add/remove flows (dev only)")
    .addSubcommand((sc) =>
      sc
        .setName("flow")
        .setDescription("Apply synthetic ALM add/remove globally to all ALM positions")
        .addStringOption((o) =>
          o
            .setName("direction")
            .setDescription("add or remove")
            .setRequired(true)
            .addChoices(
              { name: "add", value: "add" },
              { name: "remove", value: "remove" }
            )
        )
        .addNumberOption((o) =>
          o
            .setName("amount")
            .setDescription("Amount to apply to both token0 and token1")
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("reset")
        .setDescription("Clear global synthetic ALM flow override")
    )
    .addSubcommand((sc) =>
      sc
        .setName("status")
        .setDescription("Show current in-memory global ALM synthetic flow override")
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sub = interaction.options.getSubcommand();

    if (sub === "status") {
      await interaction.editReply(formatState());
      return;
    }

    if (sub === "reset") {
      clearAlmFlowGlobal();
      await interaction.editReply(`✅ Cleared global ALM synthetic flow override.\n${formatState()}`);
      return;
    }

    if (sub === "flow") {
      const direction = interaction.options.getString("direction", true);
      const amount = Number(interaction.options.getNumber("amount", true));

      if (!Number.isFinite(amount)) {
        await interaction.editReply("amount must be a valid number.");
        return;
      }
      if (amount <= 0) {
        await interaction.editReply("amount must be > 0.");
        return;
      }

      const sign = direction === "remove" ? -1 : 1;
      const delta = sign * amount;

      adjustAlmFlowGlobal(delta, delta);

      await interaction.editReply(
        `✅ Applied synthetic ${direction} globally: token0 ${delta >= 0 ? "+" : ""}${delta}, token1 ${delta >= 0 ? "+" : ""}${delta}\n` +
          `${formatState()}\n\n` +
          "Run a snapshot cycle to see updates in /my-lp and heartbeat."
      );
      return;
    }

    await interaction.editReply("Unknown subcommand.");
  },
};
