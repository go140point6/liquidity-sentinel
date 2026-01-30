// commands/test-firelight.js
const { SlashCommandBuilder } = require("discord.js");

const { getDb, getOrCreateUserId } = require("../db");
const { prepareQueries } = require("../db/queries");
const { ensureDmOnboarding } = require("../utils/discord/dm");
const { ephemeralFlags } = require("../utils/discord/ephemerals");
const {
  buildFirelightChannelMessage,
  buildFirelightDmMessage,
  setFirelightTestState,
  getFirelightTestState,
  updateFirelightMessage,
  STATE_OPEN,
  STATE_CLOSED,
  STATE_UNKNOWN,
} = require("../jobs/firelightJob");

module.exports = {
  devOnly: true,
  data: new SlashCommandBuilder()
    .setName("test-firelight")
    .setDescription("Send a Firelight test DM and override state (dev only)")
    .addStringOption((o) =>
      o
        .setName("state")
        .setDescription("Choose the Firelight state to simulate")
        .setRequired(true)
        .addChoices(
          { name: "open", value: "OPEN" },
          { name: "closed", value: "CLOSED" },
          { name: "unknown", value: "UNKNOWN" },
          { name: "reset", value: "RESET" }
        )
    )
    .addNumberOption((o) =>
      o
        .setName("amount")
        .setDescription("Unallocated amount (FXRP) when state=open")
        .setRequired(false)
        .setMinValue(0)
    ),

  async execute(interaction) {
    const ephFlags = ephemeralFlags();
    await interaction.deferReply({ flags: ephFlags });

    const choice = interaction.options.getString("state");
    if (choice === "RESET") {
      setFirelightTestState(null);
      await interaction.editReply("Firelight test override cleared.");
      return;
    }

    const amount = interaction.options.getNumber("amount");
    if (choice === "OPEN" && (amount == null || !Number.isFinite(amount))) {
      await interaction.editReply("Amount is required when state=open.");
      return;
    }

    const nextState = setFirelightTestState(choice);
    const state = nextState || STATE_UNKNOWN;

  const db = getDb();
  const q = prepareQueries(db);
  const { getConfig } = require("../jobs/firelightJob");

    const discordId = interaction.user.id;
    const discordName = interaction.user.globalName || interaction.user.username || null;
    const userId = getOrCreateUserId(db, { discordId, discordName });

    const userRow = q.selUser.get(userId);
    const acceptsDm = userRow?.accepts_dm ?? 0;

    const cfg = getConfig(db);
    const prevState = cfg?.last_state || null;
    const stateChanged = prevState !== state;

    const { updated } = await updateFirelightMessage(interaction.client, db, {
      state,
      capacityRemaining: choice === "OPEN" ? amount : null,
    });

    if (state === STATE_UNKNOWN) {
      await interaction.editReply(
        `Firelight test set to UNKNOWN. Channel message ${updated ? "updated" : "unchanged"}.`
      );
      return;
    }

    if (stateChanged) {
      await ensureDmOnboarding({
        interaction,
        userId,
        discordId,
        acceptsDm,
        setUserDmStmt: q.setUserDm,
      });

      try {
        await interaction.user.send(buildFirelightDmMessage(state));
        await interaction.editReply(
          `Firelight test sent via DM. Channel message ${updated ? "updated" : "unchanged"}.`
        );
      } catch (err) {
        await interaction.editReply(
          `Unable to send Firelight test DM (DMs may be closed). Channel message ${
            updated ? "updated" : "unchanged"
          }.`
        );
      }
      return;
    }

    await interaction.editReply(
      `Firelight test set to ${state}. Channel message ${updated ? "updated" : "unchanged"}.`
    );
  },
};
