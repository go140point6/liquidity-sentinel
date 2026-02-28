// dev/mergeProdUserDataIntoIndexedDb.js
// Merge user-facing production data into an indexed target DB.
// Intended cutover use:
// - target DB: indexed/backfilled DB you want to run in production
// - source DB: old production DB with current users/wallets/ignores/config

const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

function parseArgs(argv) {
  const out = {
    targetDb: null,
    sourceDb: null,
    execute: false,
    keepAlerts: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--target-db" && argv[i + 1]) {
      out.targetDb = argv[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith("--target-db=")) {
      out.targetDb = a.slice("--target-db=".length);
      continue;
    }
    if (a === "--source-db" && argv[i + 1]) {
      out.sourceDb = argv[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith("--source-db=")) {
      out.sourceDb = a.slice("--source-db=".length);
      continue;
    }
    if (a === "--execute") {
      out.execute = true;
      continue;
    }
    if (a === "--keep-alerts") {
      out.keepAlerts = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!out.targetDb || !out.sourceDb) {
    printHelp();
    throw new Error("Missing required args: --target-db and --source-db");
  }

  out.targetDb = resolvePath(out.targetDb);
  out.sourceDb = resolvePath(out.sourceDb);
  return out;
}

function resolvePath(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function printHelp() {
  console.log(`
Usage:
  node dev/mergeProdUserDataIntoIndexedDb.js --target-db <indexed.db> --source-db <prod.db> [--execute] [--keep-alerts]

Behavior:
  - Dry-run by default (no writes unless --execute is set).
  - Replaces target user/config data with source:
    users, user_wallets, position_ignores, firelight_config, firelight_subscriptions, sp_apr_config, sp_apr_subscriptions
  - Clears runtime state in target:
    loan_position_snapshots, lp_position_snapshots
  - Clears alert_state/log by default (use --keep-alerts to preserve).
`);
}

function mustExist(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function tableExists(db, tableName, prefix = "main") {
  const row = db.prepare(`SELECT 1 AS ok FROM ${prefix}.sqlite_master WHERE type = 'table' AND name = ?`).get(tableName);
  return !!row?.ok;
}

function countTable(db, tableName, prefix = "main") {
  if (!tableExists(db, tableName, prefix)) return 0;
  return db.prepare(`SELECT COUNT(*) AS c FROM ${prefix}.${tableName}`).get().c;
}

function getCounts(db, prefix = "main") {
  return {
    users: countTable(db, "users", prefix),
    user_wallets: countTable(db, "user_wallets", prefix),
    position_ignores: countTable(db, "position_ignores", prefix),
    firelight_config: countTable(db, "firelight_config", prefix),
    firelight_subscriptions: countTable(db, "firelight_subscriptions", prefix),
    sp_apr_config: countTable(db, "sp_apr_config", prefix),
    sp_apr_subscriptions: countTable(db, "sp_apr_subscriptions", prefix),
    loan_position_snapshots: countTable(db, "loan_position_snapshots", prefix),
    lp_position_snapshots: countTable(db, "lp_position_snapshots", prefix),
    alert_state: countTable(db, "alert_state", prefix),
    alert_log: countTable(db, "alert_log", prefix),
  };
}

function printCounts(label, counts) {
  console.log(`[merge] ${label}`);
  Object.entries(counts).forEach(([k, v]) => {
    console.log(`  - ${k}: ${v}`);
  });
}

function main() {
  const args = parseArgs(process.argv);
  mustExist(args.targetDb, "target DB");
  mustExist(args.sourceDb, "source DB");

  if (args.targetDb === args.sourceDb) {
    throw new Error("target DB and source DB must be different files");
  }

  console.log(`[merge] target=${args.targetDb}`);
  console.log(`[merge] source=${args.sourceDb}`);
  console.log(`[merge] mode=${args.execute ? "EXECUTE" : "DRY_RUN"}`);
  console.log(`[merge] keep_alerts=${args.keepAlerts ? "1" : "0"}`);

  const db = new Database(args.targetDb);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  // Attach source DB for joins/mapping.
  db.prepare("ATTACH DATABASE ? AS src").run(args.sourceDb);

  try {
    const srcCounts = getCounts(db, "src");
    const targetBefore = getCounts(db, "main");
    printCounts("source counts", srcCounts);
    printCounts("target BEFORE", targetBefore);

    const run = db.transaction(() => {
      db.exec("DELETE FROM loan_position_snapshots");
      db.exec("DELETE FROM lp_position_snapshots");
      if (!args.keepAlerts) {
        db.exec("DELETE FROM alert_state");
        db.exec("DELETE FROM alert_log");
      }

      db.exec("DELETE FROM position_ignores");
      db.exec("DELETE FROM user_wallets");
      db.exec("DELETE FROM firelight_subscriptions");
      db.exec("DELETE FROM firelight_config");
      db.exec("DELETE FROM sp_apr_subscriptions");
      db.exec("DELETE FROM sp_apr_config");
      db.exec("DELETE FROM users");

      db.exec(`
        INSERT INTO users (
          discord_id, discord_name, accepts_dm, heartbeat_hour, heartbeat_enabled, heartbeat_tz, created_at, updated_at
        )
        SELECT
          discord_id, discord_name, accepts_dm, heartbeat_hour, heartbeat_enabled, heartbeat_tz, created_at, updated_at
        FROM src.users
      `);

      db.exec(`
        INSERT INTO user_wallets (
          user_id, chain_id, address_lower, address_eip55, label, lp_alerts_status_only, is_enabled, created_at, updated_at
        )
        SELECT
          u_new.id, w.chain_id, w.address_lower, w.address_eip55, w.label, w.lp_alerts_status_only, w.is_enabled, w.created_at, w.updated_at
        FROM src.user_wallets w
        JOIN src.users u_src ON u_src.id = w.user_id
        JOIN users u_new ON u_new.discord_id = u_src.discord_id
      `);

      db.exec(`
        INSERT INTO position_ignores (
          user_id, position_kind, wallet_id, contract_id, token_id, reason, created_at
        )
        SELECT
          u_new.id,
          pi.position_kind,
          w_new.id,
          c_new.id,
          pi.token_id,
          pi.reason,
          pi.created_at
        FROM src.position_ignores pi
        JOIN src.users u_src ON u_src.id = pi.user_id
        JOIN users u_new ON u_new.discord_id = u_src.discord_id
        JOIN src.user_wallets w_src ON w_src.id = pi.wallet_id
        JOIN user_wallets w_new
          ON w_new.user_id = u_new.id
         AND w_new.chain_id = w_src.chain_id
         AND w_new.address_lower = w_src.address_lower
        JOIN src.contracts c_src ON c_src.id = pi.contract_id
        JOIN contracts c_new
          ON c_new.chain_id = c_src.chain_id
         AND c_new.contract_key = c_src.contract_key
      `);

      db.exec(`
        INSERT INTO firelight_config (
          id, channel_id, message_id, last_state, last_assets, last_capacity, last_checked_at, created_at, updated_at
        )
        SELECT
          id, channel_id, message_id, last_state, last_assets, last_capacity, last_checked_at, created_at, updated_at
        FROM src.firelight_config
      `);

      db.exec(`
        INSERT INTO firelight_subscriptions (user_id, created_at)
        SELECT
          u_new.id, fs.created_at
        FROM src.firelight_subscriptions fs
        JOIN src.users u_src ON u_src.id = fs.user_id
        JOIN users u_new ON u_new.discord_id = u_src.discord_id
      `);

      if (tableExists(db, "sp_apr_config", "src")) {
        db.exec(`
          INSERT INTO sp_apr_config (
            id, channel_id, message_id, last_top_pool_key, last_checked_at, created_at, updated_at
          )
          SELECT
            id, channel_id, message_id, last_top_pool_key, last_checked_at, created_at, updated_at
          FROM src.sp_apr_config
        `);
      }

      if (tableExists(db, "sp_apr_subscriptions", "src")) {
        db.exec(`
          INSERT INTO sp_apr_subscriptions (user_id, created_at)
          SELECT
            u_new.id, ss.created_at
          FROM src.sp_apr_subscriptions ss
          JOIN src.users u_src ON u_src.id = ss.user_id
          JOIN users u_new ON u_new.discord_id = u_src.discord_id
        `);
      }

    });

    if (args.execute) {
      run();
    } else {
      console.log("[merge] DRY_RUN: no changes applied.");
    }

    const targetAfter = getCounts(db, "main");
    printCounts(`target ${args.execute ? "AFTER" : "CURRENT"}`, targetAfter);

    if (args.execute) {
      const fkIssues = db.prepare("PRAGMA foreign_key_check").all();
      if (fkIssues.length) {
        console.log(`[merge] WARN foreign_key_check issues=${fkIssues.length}`);
      } else {
        console.log("[merge] foreign_key_check OK");
      }
      console.log("[merge] DONE");
    }
  } finally {
    try {
      db.exec("DETACH DATABASE src");
    } catch (_) {
      // ignore detach failures during teardown
    }
    db.close();
  }
}

main();
