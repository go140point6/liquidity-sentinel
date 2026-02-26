#!/usr/bin/env node
"use strict";

// dev/pruneUsers.js
// Keep one Discord user and prune all other user-linked data.
// Dry-run by default; pass --execute to apply.

const path = require("path");
const Database = require("better-sqlite3");
const dotenv = require("dotenv");

const ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const DEFAULT_KEEP_DISCORD_ID = "567425551229386758";
const DEFAULT_FIRELIGHT_MESSAGE_ID = "1465197144343449611";

function parseArgs(argv) {
  const args = {
    keepDiscordId: DEFAULT_KEEP_DISCORD_ID,
    firelightMessageId: DEFAULT_FIRELIGHT_MESSAGE_ID,
    firelightChannelId: process.env.FIRELIGHT_CHANNEL_ID || null,
    dbPath: process.env.DB_PATH || "./data/liquidity-sentinel.sqlite",
    execute: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--execute") {
      args.execute = true;
      continue;
    }
    if (a.startsWith("--keep-discord-id=")) {
      args.keepDiscordId = a.split("=")[1];
      continue;
    }
    if (a.startsWith("--firelight-message-id=")) {
      args.firelightMessageId = a.split("=")[1];
      continue;
    }
    if (a.startsWith("--firelight-channel-id=")) {
      args.firelightChannelId = a.split("=")[1];
      continue;
    }
    if (a.startsWith("--db=")) {
      args.dbPath = a.split("=")[1];
      continue;
    }
    if (a === "--help" || a === "-h") {
      console.log(`
Usage:
  node dev/pruneUsers.js [--execute]
    [--db=./data/liquidity-sentinel.sqlite]
    [--keep-discord-id=567425551229386758]
    [--firelight-message-id=1465197144343449611]
    [--firelight-channel-id=<channelId>]

Behavior:
  - Keeps only one user (by discord_id).
  - Removes all other users and all user-linked rows.
  - Keeps alert state/log only for kept user and their remaining wallets.
  - Updates firelight_config.message_id to provided value.
  - Dry-run unless --execute is provided.
      `.trim());
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${a}`);
  }

  return args;
}

function resolveDbPath(raw) {
  if (path.isAbsolute(raw)) return raw;
  return path.join(ROOT, raw);
}

function tableExists(db, name) {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return !!row?.ok;
}

function count(db, table, where = "", params = []) {
  if (!tableExists(db, table)) return null;
  const sql = `SELECT COUNT(*) AS c FROM ${table} ${where}`;
  return db.prepare(sql).get(...params).c;
}

function main() {
  const args = parseArgs(process.argv);
  const dbPath = resolveDbPath(args.dbPath);
  const db = new Database(dbPath);

  try {
    db.pragma("foreign_keys = ON");

    const keepUser = db
      .prepare("SELECT id, discord_id, discord_name FROM users WHERE discord_id = ?")
      .get(args.keepDiscordId);

    if (!keepUser) {
      throw new Error(`keep user not found for discord_id=${args.keepDiscordId}`);
    }

    const keepUserId = keepUser.id;
    const keepWalletIds = db
      .prepare("SELECT id FROM user_wallets WHERE user_id = ?")
      .all(keepUserId)
      .map((r) => r.id);

    const before = {
      users: count(db, "users"),
      user_wallets: count(db, "user_wallets"),
      position_ignores: count(db, "position_ignores"),
      firelight_subscriptions: count(db, "firelight_subscriptions"),
      alert_state: count(db, "alert_state"),
      alert_log: count(db, "alert_log"),
      loan_position_snapshots: count(db, "loan_position_snapshots"),
      lp_position_snapshots: count(db, "lp_position_snapshots"),
    };

    console.log("Prune users for sandbox");
    console.log(`DB: ${dbPath}`);
    console.log(`keep user: id=${keepUser.id} discord_id=${keepUser.discord_id} name=${keepUser.discord_name || "(null)"}`);
    console.log(`keep wallets: ${keepWalletIds.length}`);
    console.log(`firelight message id -> ${args.firelightMessageId}`);
    if (args.firelightChannelId) {
      console.log(`firelight channel id override -> ${args.firelightChannelId}`);
    }
    console.log(`mode: ${args.execute ? "EXECUTE" : "DRY-RUN"}`);
    console.log("\nBefore counts:");
    console.table(before);

    if (!args.execute) {
      console.log("\nDry run only. No changes applied.");
      return;
    }

    const tx = db.transaction(() => {
      // Delete user-linked rows for other users first (safe even with FK cascade enabled).
      if (tableExists(db, "position_ignores")) {
        db.prepare("DELETE FROM position_ignores WHERE user_id <> ?").run(keepUserId);
      }
      if (tableExists(db, "loan_position_snapshots")) {
        db.prepare("DELETE FROM loan_position_snapshots WHERE user_id <> ?").run(keepUserId);
      }
      if (tableExists(db, "lp_position_snapshots")) {
        db.prepare("DELETE FROM lp_position_snapshots WHERE user_id <> ?").run(keepUserId);
      }
      if (tableExists(db, "firelight_subscriptions")) {
        db.prepare("DELETE FROM firelight_subscriptions WHERE user_id <> ?").run(keepUserId);
      }

      // Alert tables may accumulate orphans; keep only rows tied to kept user + kept wallets.
      if (tableExists(db, "alert_state")) {
        db.prepare("DELETE FROM alert_state WHERE user_id <> ?").run(keepUserId);
        db.prepare(
          `DELETE FROM alert_state
           WHERE user_id = ?
             AND wallet_id NOT IN (SELECT id FROM user_wallets WHERE user_id = ?)`
        ).run(keepUserId, keepUserId);
      }
      if (tableExists(db, "alert_log")) {
        db.prepare("DELETE FROM alert_log WHERE user_id <> ?").run(keepUserId);
        db.prepare(
          `DELETE FROM alert_log
           WHERE user_id = ?
             AND wallet_id NOT IN (SELECT id FROM user_wallets WHERE user_id = ?)`
        ).run(keepUserId, keepUserId);
      }

      // Delete non-kept users (cascades user_wallets and any remaining dependent rows).
      db.prepare("DELETE FROM users WHERE id <> ?").run(keepUserId);

      // Ensure firelight config message id is the sandbox one.
      const fireCfg = tableExists(db, "firelight_config")
        ? db.prepare("SELECT id, channel_id FROM firelight_config WHERE id = 1").get()
        : null;

      if (!tableExists(db, "firelight_config")) return;

      if (fireCfg) {
        const channelId = args.firelightChannelId || fireCfg.channel_id;
        db.prepare(
          `UPDATE firelight_config
             SET channel_id = ?, message_id = ?, updated_at = datetime('now')
           WHERE id = 1`
        ).run(String(channelId), String(args.firelightMessageId));
      } else {
        const channelId = args.firelightChannelId;
        if (!channelId) {
          throw new Error(
            "firelight_config row missing and no --firelight-channel-id provided (or FIRELIGHT_CHANNEL_ID env)"
          );
        }
        db.prepare(
          `INSERT INTO firelight_config (id, channel_id, message_id)
           VALUES (1, ?, ?)`
        ).run(String(channelId), String(args.firelightMessageId));
      }
    });

    tx();

    const after = {
      users: count(db, "users"),
      user_wallets: count(db, "user_wallets"),
      position_ignores: count(db, "position_ignores"),
      firelight_subscriptions: count(db, "firelight_subscriptions"),
      alert_state: count(db, "alert_state"),
      alert_log: count(db, "alert_log"),
      loan_position_snapshots: count(db, "loan_position_snapshots"),
      lp_position_snapshots: count(db, "lp_position_snapshots"),
      firelight_config: tableExists(db, "firelight_config")
        ? db.prepare("SELECT id, channel_id, message_id FROM firelight_config WHERE id = 1").get()
        : null,
    };

    console.log("\nAfter counts:");
    console.table({
      users: after.users,
      user_wallets: after.user_wallets,
      position_ignores: after.position_ignores,
      firelight_subscriptions: after.firelight_subscriptions,
      alert_state: after.alert_state,
      alert_log: after.alert_log,
      loan_position_snapshots: after.loan_position_snapshots,
      lp_position_snapshots: after.lp_position_snapshots,
    });

    console.log("\nFirelight config:");
    console.table(after.firelight_config ? [after.firelight_config] : []);

    console.log("\nDone.");
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err?.message || err}`);
  process.exit(1);
}
