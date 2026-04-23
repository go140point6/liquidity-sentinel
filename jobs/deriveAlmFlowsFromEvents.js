const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const Database = require("better-sqlite3");
const { ethers } = require("ethers");

const baseLogger = require("../utils/logger");
const logger = baseLogger.forEnv("SCAN_DEBUG");
const { initSchema } = require("../db");
const { TRANSFER_TOPIC } = require("../utils/indexer/streamRegistry");

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const BURN_ADDRS = new Set([ZERO_ADDR, "0x000000000000000000000000000000000000dead"]);

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var ${name}`);
  return String(v).trim();
}

function intArg(name) {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

function strArg(name) {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  return raw == null ? null : String(raw);
}

function boolArg(name) {
  if (process.argv.includes(`--${name}`)) return 1;
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  if (raw == null) return 0;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return 1;
  if (["0", "false", "no", "n", "off"].includes(v)) return 0;
  throw new Error(`--${name} must be boolean-like (1/0, true/false, yes/no)`);
}

function decodeTransfer(topics, dataHex) {
  if (!Array.isArray(topics) || topics.length < 3) return null;
  try {
    const from = ethers.getAddress(`0x${topics[1].slice(26)}`);
    const to = ethers.getAddress(`0x${topics[2].slice(26)}`);
    const rawHex = String(dataHex || "0x");
    const amountRaw = BigInt(rawHex).toString();
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();
    const flowKind = BURN_ADDRS.has(fromLower)
      ? "MINT"
      : BURN_ADDRS.has(toLower)
        ? "BURN"
        : "TRANSFER";
    return {
      fromLower,
      fromEip55: from,
      toLower,
      toEip55: to,
      amountRaw,
      flowKind,
    };
  } catch {
    return null;
  }
}

async function main() {
  const DB_PATH = requireEnv("DB_PATH");

  const chain = strArg("chain")?.toUpperCase() || null;
  const contractId = intArg("contract-id");
  const streamId = intArg("stream-id");
  const batchSizeArg = intArg("batch");
  const batchSize = Number.isInteger(batchSizeArg) && batchSizeArg > 0 ? batchSizeArg : 1000;
  const fullReplay = boolArg("full-replay") === 1;
  const resetCursor = boolArg("reset-cursor") === 1;

  const deriveKey = [
    "derive_alm_share_flows",
    chain || "ALL",
    contractId == null ? "ALL" : String(contractId),
    streamId == null ? "ALL" : String(streamId),
  ].join(":");

  const db = new Database(DB_PATH);
  initSchema(db);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  const where = ["e.topic0 = ?", "e.removed = 0", "c.kind = 'LP_ALM'"];
  const argsBase = [TRANSFER_TOPIC];

  if (chain) {
    where.push("e.chain_id = ?");
    argsBase.push(chain);
  }
  if (contractId != null) {
    where.push("e.contract_id = ?");
    argsBase.push(contractId);
  }
  if (streamId != null) {
    where.push("e.stream_id = ?");
    argsBase.push(streamId);
  }

  const selBatch = db.prepare(`
    SELECT
      e.id,
      e.chain_id,
      e.contract_id,
      e.stream_id,
      e.block_number,
      e.tx_hash,
      e.log_index,
      e.topics_json,
      e.data_hex
    FROM chain_events e
    JOIN contracts c
      ON c.id = e.contract_id
    WHERE ${where.join(" AND ")}
      AND e.id > ?
    ORDER BY e.id
    LIMIT ?
  `);

  const selCursor = db.prepare(`
    SELECT last_event_id
    FROM derive_cursors
    WHERE derive_key = ?
    LIMIT 1
  `);

  const upsertCursor = db.prepare(`
    INSERT INTO derive_cursors (derive_key, last_event_id, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(derive_key) DO UPDATE SET
      last_event_id = excluded.last_event_id,
      updated_at = datetime('now')
  `);

  const upsertFlow = db.prepare(`
    INSERT INTO alm_share_flows (
      event_id, chain_id, contract_id, stream_id, block_number, tx_hash, log_index,
      from_lower, from_eip55, to_lower, to_eip55, amount_raw, flow_kind, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, datetime('now')
    )
    ON CONFLICT(event_id) DO UPDATE SET
      chain_id = excluded.chain_id,
      contract_id = excluded.contract_id,
      stream_id = excluded.stream_id,
      block_number = excluded.block_number,
      tx_hash = excluded.tx_hash,
      log_index = excluded.log_index,
      from_lower = excluded.from_lower,
      from_eip55 = excluded.from_eip55,
      to_lower = excluded.to_lower,
      to_eip55 = excluded.to_eip55,
      amount_raw = excluded.amount_raw,
      flow_kind = excluded.flow_kind
  `);

  const applyBatch = db.transaction((rows) => {
    let flowsWritten = 0;
    for (const r of rows) {
      let topics;
      try {
        topics = JSON.parse(r.topics_json || "[]");
      } catch {
        continue;
      }

      const d = decodeTransfer(topics, r.data_hex);
      if (!d) continue;

      const res = upsertFlow.run(
        r.id,
        r.chain_id,
        r.contract_id,
        r.stream_id,
        r.block_number,
        r.tx_hash,
        r.log_index,
        d.fromLower,
        d.fromEip55,
        d.toLower,
        d.toEip55,
        d.amountRaw,
        d.flowKind
      );
      flowsWritten += Number(res?.changes || 0);
    }
    return { flowsWritten };
  });

  if (resetCursor) {
    upsertCursor.run(deriveKey, 0);
    logger.info(`[deriveAlmFlowsFromEvents] cursor reset derive_key=${deriveKey}`);
  }

  const cursorRow = selCursor.get(deriveKey);
  let lastId = fullReplay ? 0 : Math.max(0, Number(cursorRow?.last_event_id) || 0);
  let scanned = 0;
  let totalFlowsWritten = 0;

  try {
    logger.info(
      `[deriveAlmFlowsFromEvents] start chain=${chain || "ALL"} contractId=${contractId ?? "ALL"} streamId=${streamId ?? "ALL"} batch=${batchSize} derive_key=${deriveKey} from_event_id=${lastId} full_replay=${fullReplay ? 1 : 0}`
    );
    for (;;) {
      const rows = selBatch.all(...argsBase, lastId, batchSize);
      if (!rows.length) break;

      const { flowsWritten } = applyBatch(rows);

      scanned += rows.length;
      totalFlowsWritten += flowsWritten;
      lastId = rows[rows.length - 1].id;
      upsertCursor.run(deriveKey, lastId);

      logger.info(
        `[deriveAlmFlowsFromEvents] batch size=${rows.length} scanned=${scanned} flows_written=${totalFlowsWritten} last_event_id=${lastId}`
      );
    }

    logger.info(
      `[deriveAlmFlowsFromEvents] DONE scanned=${scanned} flows_written=${totalFlowsWritten} cursor_event_id=${lastId}`
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  logger.error("[deriveAlmFlowsFromEvents] FATAL:", err);
  process.exitCode = 1;
});
