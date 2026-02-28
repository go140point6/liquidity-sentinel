const { getDb, getOrCreateUserId } = require("../db");
const { sendDmOrChannelNotice } = require("../utils/discord/dm");
const logger = require("../utils/logger");
const { SP_APR_REACTION_EMOJI } = require("../jobs/stabilityAprJob");

const FIRELIGHT_EMOJI = "🔥";

async function fetchIfPartial(reaction) {
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (_) {
      return null;
    }
  }
  if (reaction.message?.partial) {
    try {
      await reaction.message.fetch();
    } catch (_) {}
  }
  return reaction;
}

function getFirelightConfig(db) {
  return db
    .prepare(
      `
      SELECT channel_id, message_id
      FROM firelight_config
      WHERE id = 1
      LIMIT 1
    `
    )
    .get();
}

function getSpAprConfig(db) {
  return db
    .prepare(
      `
      SELECT channel_id, message_id
      FROM sp_apr_config
      WHERE id = 1
      LIMIT 1
    `
    )
    .get();
}

async function handleSubscriptionReaction({ reaction, user, isAdd, emoji, cfg, table, subscribeText, unsubscribeText, tag }) {
  if (!user || user.bot) return;
  if (!reaction || reaction.emoji?.name !== emoji) return;
  if (!cfg?.message_id || !cfg?.channel_id) return;
  if (reaction.message?.id !== cfg.message_id) return;
  if (reaction.message?.channel?.id !== cfg.channel_id) return;

  const db = getDb();
  const userId = getOrCreateUserId(db, {
    discordId: user.id,
    discordName: user.username,
  });

  const setUserDmStmt = db.prepare(
    `UPDATE users SET accepts_dm = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const acceptsRow = db
    .prepare(`SELECT accepts_dm FROM users WHERE id = ?`)
    .get(userId);
  const acceptsDm = acceptsRow?.accepts_dm || 0;

  const subExists = db
    .prepare(`SELECT 1 FROM ${table} WHERE user_id = ?`)
    .get(userId);

  if (isAdd) {
    if (subExists) return;

    const res = await sendDmOrChannelNotice({
      user,
      userId,
      discordId: user.id,
      acceptsDm,
      setUserDmStmt,
      channel: reaction.message.channel,
      dmContent: subscribeText,
    });

    if (!res?.canDm) {
      try {
        await reaction.users.remove(user.id);
      } catch (_) {}
      return;
    }

    db.prepare(`INSERT INTO ${table} (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING`).run(userId);
  } else {
    db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);

    await sendDmOrChannelNotice({
      user,
      userId,
      discordId: user.id,
      acceptsDm,
      setUserDmStmt,
      channel: reaction.message.channel,
      dmContent: unsubscribeText,
    });
  }

  logger.debug(`[${tag}] reaction subscription ${isAdd ? "add" : "remove"} user=${user.id}`);
}

async function onReactionAdd(reaction, user) {
  const r = await fetchIfPartial(reaction);
  if (!r) return;
  const db = getDb();

  try {
    await handleSubscriptionReaction({
      reaction: r,
      user,
      isAdd: true,
      emoji: FIRELIGHT_EMOJI,
      cfg: getFirelightConfig(db),
      table: "firelight_subscriptions",
      subscribeText: "Firelight subscription: You will be notified by DM when vault capacity changes.",
      unsubscribeText: "Firelight subscription: You have been unsubscribed. No further DMs will be sent.",
      tag: "firelight",
    });

    await handleSubscriptionReaction({
      reaction: r,
      user,
      isAdd: true,
      emoji: SP_APR_REACTION_EMOJI,
      cfg: getSpAprConfig(db),
      table: "sp_apr_subscriptions",
      subscribeText: "Stability APR subscription: You will be notified by DM when the top 24h APR Stability Pool changes.",
      unsubscribeText: "Stability APR subscription: You have been unsubscribed. No further DMs will be sent.",
      tag: "sp-apr",
    });
  } catch (err) {
    logger.error("[reaction] add failed:", err?.message || err);
  }
}

async function onReactionRemove(reaction, user) {
  const r = await fetchIfPartial(reaction);
  if (!r) return;
  const db = getDb();

  try {
    await handleSubscriptionReaction({
      reaction: r,
      user,
      isAdd: false,
      emoji: FIRELIGHT_EMOJI,
      cfg: getFirelightConfig(db),
      table: "firelight_subscriptions",
      subscribeText: "Firelight subscription: You will be notified by DM when vault capacity changes.",
      unsubscribeText: "Firelight subscription: You have been unsubscribed. No further DMs will be sent.",
      tag: "firelight",
    });

    await handleSubscriptionReaction({
      reaction: r,
      user,
      isAdd: false,
      emoji: SP_APR_REACTION_EMOJI,
      cfg: getSpAprConfig(db),
      table: "sp_apr_subscriptions",
      subscribeText: "Stability APR subscription: You will be notified by DM when the top 24h APR Stability Pool changes.",
      unsubscribeText: "Stability APR subscription: You have been unsubscribed. No further DMs will be sent.",
      tag: "sp-apr",
    });
  } catch (err) {
    logger.error("[reaction] remove failed:", err?.message || err);
  }
}

module.exports = { onReactionAdd, onReactionRemove };
