const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const Database = require("better-sqlite3");
const { initSchema } = require("../db");

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var ${name}`);
  return String(v).trim();
}

const db = new Database(requireEnv("DB_PATH"));
initSchema(db);

try {
  console.log("[duplicates] start");
  const dupEvents = db
    .prepare(`
      SELECT chain_id, tx_hash, log_index, COUNT(*) AS c
      FROM chain_events
      GROUP BY chain_id, tx_hash, log_index
      HAVING COUNT(*) > 1
      LIMIT 50
    `)
    .all();

  const dupTransfers = db
    .prepare(`
      SELECT contract_id, tx_hash, log_index, COUNT(*) AS c
      FROM nft_transfers
      GROUP BY contract_id, tx_hash, log_index
      HAVING COUNT(*) > 1
      LIMIT 50
    `)
    .all();

  if (!dupEvents.length && !dupTransfers.length) {
    console.log("[duplicates] OK no duplicate keys found");
    return;
  }

  if (dupEvents.length) {
    console.log(`[duplicates] chain_events duplicates=${dupEvents.length}`);
    for (const r of dupEvents) {
      console.log(`  chain=${r.chain_id} tx=${r.tx_hash} logIndex=${r.log_index} count=${r.c}`);
    }
  }

  if (dupTransfers.length) {
    console.log(`[duplicates] nft_transfers duplicates=${dupTransfers.length}`);
    for (const r of dupTransfers) {
      console.log(`  contractId=${r.contract_id} tx=${r.tx_hash} logIndex=${r.log_index} count=${r.c}`);
    }
  }

  process.exitCode = 1;
} finally {
  db.close();
}
