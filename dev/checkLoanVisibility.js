#!/usr/bin/env node
"use strict";

const path = require("path");
const Database = require("better-sqlite3");
const dotenv = require("dotenv");

const ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const discordId = process.argv[2] || process.env.CHECK_DISCORD_ID || "567425551229386758";
const dbPathRaw = process.env.DB_PATH || "./data/liquidity-sentinel.sqlite";
const dbPath = path.isAbsolute(dbPathRaw) ? dbPathRaw : path.join(ROOT, dbPathRaw);

const db = new Database(dbPath, { readonly: true });

function printHeader(title) {
  console.log(`\n=== ${title} ===`);
}

function runQuery(title, sql, params = []) {
  printHeader(title);
  try {
    const rows = db.prepare(sql).all(...params);
    if (!rows.length) {
      console.log("(no rows)");
      return;
    }
    console.table(rows);
  } catch (err) {
    console.log(`Query failed: ${err.message || err}`);
    console.log(sql);
  }
}

console.log("Loan visibility diagnostics");
console.log(`DB: ${dbPath}`);
console.log(`discord_id: ${discordId}`);

runQuery(
  "1) loan_position_snapshots count",
  "SELECT COUNT(*) AS count FROM loan_position_snapshots"
);

runQuery(
  "2) user loan snapshots",
  `
  SELECT user_id, wallet_id, contract_id, token_id, snapshot_at
  FROM loan_position_snapshots
  WHERE user_id = (SELECT id FROM users WHERE discord_id = ?)
  ORDER BY snapshot_at DESC
  `,
  [discordId]
);

runQuery(
  "3) enabled loan contracts",
  `
  SELECT id, chain_id, protocol, is_enabled, address_eip55
  FROM contracts
  WHERE kind = 'LOAN_NFT'
  ORDER BY id
  `
);

runQuery(
  "4) active loan NFT ownership rows",
  `
  SELECT c.protocol, nt.token_id, nt.owner_lower, nt.owner_eip55, nt.is_burned, nt.updated_at
  FROM nft_tokens nt
  JOIN contracts c ON c.id = nt.contract_id
  WHERE c.kind = 'LOAN_NFT' AND nt.is_burned = 0
  ORDER BY nt.updated_at DESC
  LIMIT 200
  `
);

runQuery(
  "5) LOAN ignore rules",
  `
  SELECT id, user_id, wallet_id, contract_id, position_kind, token_id, reason, created_at
  FROM position_ignores
  WHERE position_kind = 'LOAN'
  ORDER BY created_at DESC
  `
);

db.close();

