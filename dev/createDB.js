// dev/createDB.js
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// Load .env before requiring logger (logger reads env at import time)
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const logger = require("../utils/logger");

function initDb({
  dbPath = path.join(__dirname, "..", "data", "monitor.db"),
  schemaPath = path.join(__dirname, "../db/schema.sql"),
} = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const schema = fs.readFileSync(schemaPath, "utf8");

  // better-sqlite3: constructor is Database(file, options?)
  const db = new Database(dbPath);

  try {
    // PRAGMAs (better-sqlite3 uses db.pragma)
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    // Execute schema (sync)
    db.exec(schema);

    logger.info(`[DB] Initialized OK: ${dbPath}`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    initDb();
  } catch (err) {
    logger.error("[DB] Init failed:", err);
    process.exit(1);
  }
}

module.exports = { initDb };
