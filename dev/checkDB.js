// dev/checkDB.js
// Quick inspection tool: prints up to N rows per table (prefers newest).
// Uses the unified DB entrypoint to avoid path drift.
// Load .env before requiring logger (logger reads env at import time)
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const logger = require("../utils/logger");
const { openDb, dbFile } = require("../db"); // unified import

const LIMIT = parseInt(process.env.CHECKDB_LIMIT || "25", 10);
const LARGE_TABLE_ROWS = parseInt(process.env.CHECKDB_LARGE || "50", 10);

function pickOrderColumn(colNames) {
  const recencyCols = [
    "id",
    "window_end",
    "ended_at",
    "timestamp",
    "started_at",
    "created_at",
    "updated_at",
    "last_seen_at",
  ];
  return recencyCols.find((c) => colNames.includes(c)) || null;
}

const db = openDb({ fileMustExist: true }); // don't create if missing
db.pragma("foreign_keys = ON");

logger.info("🔍 Reading table contents from database:", dbFile);
logger.info(`   LIMIT=${LIMIT}, CHECKDB_LARGE=${LARGE_TABLE_ROWS}\n`);

try {
  // 1) Discover user tables (skip SQLite internals)
  const tables = db
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all()
    .map((r) => r.name);

  if (tables.length === 0) {
    logger.info("⚠️  No user tables found.");
  }

  for (const table of tables) {
    try {
      // 2) Inspect columns to decide ordering
      const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
      const colNames = columns.map((c) => c.name);

      const orderCol = pickOrderColumn(colNames);

      // Count total rows for context
      const { cnt } = db
        .prepare(`SELECT COUNT(*) AS cnt FROM "${table}"`)
        .get();

      // Decide whether to dump this table
      const shouldDump = cnt <= LIMIT || cnt >= LARGE_TABLE_ROWS;

      logger.info(`\n📄 Table: ${table} — total rows: ${cnt}`);

      if (!shouldDump) {
        logger.info(
          `ℹ️  Skipping row dump (set CHECKDB_LARGE lower or CHECKDB_LIMIT higher to print).`
        );
        continue;
      }

      // 3) Build query
      let query;
      let params;

      if (orderCol) {
        // Grab newest LIMIT rows by orderCol, then display ascending for readability
        query = `
          SELECT * FROM (
            SELECT * FROM "${table}"
            ORDER BY "${orderCol}" DESC
            LIMIT ?
          ) sub
          ORDER BY "${orderCol}" ASC
        `;
        params = [LIMIT];
        logger.info(`   Showing newest ${LIMIT} by "${orderCol}"`);
      } else {
        query = `SELECT * FROM "${table}" LIMIT ?`;
        params = [LIMIT];
        logger.info(`   Showing first ${LIMIT} rows (no obvious recency column)`);
      }

      const rows = db.prepare(query).all(...params);

      // 4) Print
      if (rows.length === 0) {
        logger.info("⚠️  No data found.");
      } else {
        console.table(rows);
      }
    } catch (err) {
      logger.error(`❌ Error reading table ${table}:`, err.message);
    }
  }

  logger.info("\n✅ Done printing all tables.");
} catch (err) {
  logger.error("❌ Failed to enumerate tables:", err.message);
} finally {
  db.close();
  logger.info("🔒 Database connection closed.");
}
