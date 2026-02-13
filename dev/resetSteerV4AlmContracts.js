#!/usr/bin/env node
"use strict";

const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH;
const TARGET_PROTOCOL = "SPARKDEX_STEER_ALM_V4";
const TARGET_KIND = "LP_ALM";
const DISCOVERY_CURSOR_KEYS = [
  "alm_discovery_cursor_sparkdex_steer_alm_v4",
  "steer_spark_vault_created_cursor",
];
const DRY_RUN = process.argv.includes("--dry-run");

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(v).trim();
}

function main() {
  mustEnv("DB_PATH");
  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  try {
    const contracts = db
      .prepare(
        `
        SELECT id, contract_key, address_eip55, default_start_block
        FROM contracts
        WHERE kind = ? AND protocol = ?
        ORDER BY default_start_block, id
      `
      )
      .all(TARGET_KIND, TARGET_PROTOCOL);

    console.log(`DB: ${DB_PATH}`);
    console.log(`Target: kind=${TARGET_KIND} protocol=${TARGET_PROTOCOL}`);
    console.log(`Found contracts: ${contracts.length}`);
    for (const c of contracts) {
      console.log(
        `  - id=${c.id} key=${c.contract_key} addr=${c.address_eip55} start=${c.default_start_block}`
      );
    }

    const cursorRows = db
      .prepare(
        `
        SELECT param_key, value_text, fetched_at
        FROM global_params
        WHERE chain_id = 'FLR' AND param_key IN (${DISCOVERY_CURSOR_KEYS.map(() => "?").join(",")})
      `
      )
      .all(...DISCOVERY_CURSOR_KEYS);
    if (cursorRows.length) {
      console.log("Discovery cursor(s):");
      for (const r of cursorRows) {
        console.log(`  - ${r.param_key} value=${r.value_text} fetched_at=${r.fetched_at}`);
      }
    } else {
      console.log("Discovery cursor(s): none");
    }

    if (DRY_RUN) {
      console.log("Dry run only. No changes made.");
      return;
    }

    const tx = db.transaction(() => {
      if (contracts.length) {
        const del = db.prepare(`DELETE FROM contracts WHERE id = ?`);
        for (const c of contracts) del.run(c.id);
      }
      db.prepare(
        `
        DELETE FROM global_params
        WHERE chain_id = 'FLR' AND param_key IN (${DISCOVERY_CURSOR_KEYS.map(() => "?").join(",")})
      `
      ).run(...DISCOVERY_CURSOR_KEYS);
    });

    tx();
    console.log("Done:");
    console.log(`  - deleted contracts: ${contracts.length}`);
    console.log(`  - reset cursor keys: ${DISCOVERY_CURSOR_KEYS.join(", ")}`);
  } finally {
    db.close();
  }
}

main();
