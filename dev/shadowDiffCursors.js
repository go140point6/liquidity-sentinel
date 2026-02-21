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

function strArg(name) {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  return raw == null ? null : String(raw);
}

function intArg(name) {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

function main() {
  const DB_PATH = requireEnv("DB_PATH");

  const chain = strArg("chain")?.toUpperCase() || null;
  const kind = strArg("kind")?.toUpperCase() || null;
  const contractKey = strArg("contract-key") || null;
  const warnLag = intArg("warn-lag") ?? 5000;

  const db = new Database(DB_PATH);
  initSchema(db);

  try {
    const where = ["c.kind IN ('LP_NFT','LOAN_NFT')"];
    const args = [];

    if (chain) {
      where.push("c.chain_id = ?");
      args.push(chain);
    }
    if (kind) {
      where.push("c.kind = ?");
      args.push(kind);
    }
    if (contractKey) {
      where.push("c.contract_key = ?");
      args.push(contractKey);
    }

    const rows = db
      .prepare(
        `
        SELECT
          c.id AS contract_id,
          c.chain_id,
          c.kind,
          c.contract_key,
          c.default_start_block,
          cc.last_scanned_block AS legacy_cursor,
          s.id AS stream_id,
          ic.last_scanned_block AS index_cursor,
          (
            SELECT MAX(e.block_number)
            FROM chain_events e
            WHERE e.stream_id = s.id
          ) AS max_event_block
        FROM contracts c
        LEFT JOIN contract_scan_cursors cc
          ON cc.contract_id = c.id
        LEFT JOIN index_streams s
          ON s.contract_id = c.id
         AND s.event_name = 'Transfer'
        LEFT JOIN index_cursors ic
          ON ic.stream_id = s.id
        WHERE ${where.join(" AND ")}
        ORDER BY c.chain_id, c.contract_key
      `
      )
      .all(...args);

    if (!rows.length) {
      console.log("[shadow:cursors] no contracts selected");
      return;
    }

    console.log(
      `[shadow:cursors] start contracts=${rows.length} warn_lag=${warnLag} chain=${chain || "ALL"} kind=${kind || "ALL"} contractKey=${contractKey || "ALL"}`
    );

    let issues = 0;

    for (const r of rows) {
      const legacyCursor = Number.isInteger(r.legacy_cursor) ? r.legacy_cursor : null;
      const indexCursor = Number.isInteger(r.index_cursor) ? r.index_cursor : null;
      const maxEvent = Number.isInteger(r.max_event_block) ? r.max_event_block : null;

      const lagLegacyVsIndex =
        legacyCursor != null && indexCursor != null ? legacyCursor - indexCursor : null;
      const lagEventsAheadOfCursor =
        indexCursor != null && maxEvent != null ? maxEvent - indexCursor : null;

      const warn =
        r.stream_id == null ||
        indexCursor == null ||
        (lagEventsAheadOfCursor != null && lagEventsAheadOfCursor > 0) ||
        (lagLegacyVsIndex != null && Math.abs(lagLegacyVsIndex) > warnLag);

      if (warn) issues += 1;

      console.log(
        `[shadow:cursors] contract=${r.contract_key} chain=${r.chain_id} legacy_cursor=${legacyCursor ?? "-"} index_cursor=${indexCursor ?? "-"} max_event=${maxEvent ?? "-"} legacy_minus_index=${lagLegacyVsIndex ?? "-"} events_ahead_of_cursor=${lagEventsAheadOfCursor ?? "-"} status=${warn ? "WARN" : "OK"}`
      );
    }

    if (issues > 0) {
      console.log(`[shadow:cursors] WARN issues=${issues}`);
      process.exitCode = 1;
    } else {
      console.log("[shadow:cursors] OK");
    }
  } finally {
    db.close();
  }
}

main();
