// dev/pruneUsers.js
// Remove all users except the primary dev user (id=1 / discord_id=567425551229386758).
// Uses the unified DB entrypoint to avoid path drift.
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const logger = require("../utils/logger");
const { openDb, dbFile } = require("../db");

const KEEP_USER_ID = 1;
const KEEP_DISCORD_ID = "567425551229386758";
const FIRELIGHT_CHANNEL_ID = process.env.FIRELIGHT_CHANNEL_ID;
const FIRELIGHT_MESSAGE_ID = "1465197144343449611";

const db = openDb({ fileMustExist: true });

try {
  const keepRow = db
    .prepare("SELECT id, discord_id, discord_name FROM users WHERE id = ?")
    .get(KEEP_USER_ID);

  if (!keepRow) {
    logger.error(
      `Abort: no users row with id=${KEEP_USER_ID}. Refusing to delete other users.`
    );
    process.exit(1);
  }

  if (String(keepRow.discord_id) !== KEEP_DISCORD_ID) {
    logger.error(
      `Abort: users.id=${KEEP_USER_ID} has discord_id=${keepRow.discord_id}, expected ${KEEP_DISCORD_ID}.`
    );
    process.exit(1);
  }

  const countAll = db.prepare("SELECT COUNT(*) AS cnt FROM users").get().cnt;
  const countToDelete = db
    .prepare("SELECT COUNT(*) AS cnt FROM users WHERE id <> ?")
    .get(KEEP_USER_ID).cnt;

  const tx = db.transaction(() => {
    if (countToDelete > 0) {
      db.prepare("DELETE FROM users WHERE id <> ?").run(KEEP_USER_ID);
    }

    if (FIRELIGHT_CHANNEL_ID) {
      db.prepare(
        `
        INSERT INTO firelight_config (id, channel_id, message_id)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          channel_id = excluded.channel_id,
          message_id = excluded.message_id
      `
      ).run(String(FIRELIGHT_CHANNEL_ID), String(FIRELIGHT_MESSAGE_ID));
    }
  });
  tx();

  const countRemaining = db.prepare("SELECT COUNT(*) AS cnt FROM users").get().cnt;
  logger.info(
    `Deleted ${countToDelete} user(s). Remaining users=${countRemaining}. Kept id=${KEEP_USER_ID}.`
  );
  if (FIRELIGHT_CHANNEL_ID) {
    logger.info(
      `Updated firelight channel_id to ${FIRELIGHT_CHANNEL_ID} and message_id to ${FIRELIGHT_MESSAGE_ID}.`
    );
  } else {
    logger.warn("FIRELIGHT_CHANNEL_ID not set; firelight_config not updated.");
  }
} catch (err) {
  logger.error("Failed to prune users:", err?.message || err);
  process.exit(1);
} finally {
  db.close();
}
