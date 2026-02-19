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

const BURN_ADDRS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

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

function decodeTransfer(topics) {
  if (!Array.isArray(topics) || topics.length < 4) return null;
  try {
    const from = ethers.getAddress(`0x${topics[1].slice(26)}`);
    const to = ethers.getAddress(`0x${topics[2].slice(26)}`);
    const tokenId = BigInt(topics[3]).toString();
    return {
      fromLower: from.toLowerCase(),
      fromEip55: from,
      toLower: to.toLowerCase(),
      toEip55: to,
      tokenId,
      isBurned: BURN_ADDRS.has(to.toLowerCase()) ? 1 : 0,
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

  const db = new Database(DB_PATH);
  initSchema(db);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  const where = ["e.topic0 = ?", "e.removed = 0"];
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
      e.contract_id,
      e.block_number,
      e.tx_hash,
      e.log_index,
      e.topics_json
    FROM chain_events e
    WHERE ${where.join(" AND ")}
      AND e.id > ?
    ORDER BY e.id
    LIMIT ?
  `);

  const insTransfer = db.prepare(`
    INSERT INTO nft_transfers (
      contract_id, block_number, tx_hash, log_index,
      from_lower, from_eip55, to_lower, to_eip55, token_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contract_id, tx_hash, log_index) DO NOTHING
  `);

  const upsertToken = db.prepare(`
    INSERT INTO nft_tokens (
      contract_id, token_id,
      owner_lower, owner_eip55,
      is_burned,
      last_block, last_tx_hash, last_log_index,
      first_seen_block, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(contract_id, token_id) DO UPDATE SET
      owner_lower = excluded.owner_lower,
      owner_eip55 = excluded.owner_eip55,
      is_burned = excluded.is_burned,
      last_block = excluded.last_block,
      last_tx_hash = excluded.last_tx_hash,
      last_log_index = excluded.last_log_index,
      updated_at = datetime('now')
    WHERE
      nft_tokens.last_block IS NULL
      OR excluded.last_block > nft_tokens.last_block
      OR (
        excluded.last_block = nft_tokens.last_block
        AND excluded.last_log_index > nft_tokens.last_log_index
      )
  `);

  const applyBatch = db.transaction((rows) => {
    let transfersWritten = 0;
    let tokensWritten = 0;

    for (const r of rows) {
      let topics;
      try {
        topics = JSON.parse(r.topics_json || "[]");
      } catch {
        continue;
      }

      const d = decodeTransfer(topics);
      if (!d) continue;

      const tRes = insTransfer.run(
        r.contract_id,
        r.block_number,
        r.tx_hash,
        r.log_index,
        d.fromLower,
        d.fromEip55,
        d.toLower,
        d.toEip55,
        d.tokenId
      );
      transfersWritten += Number(tRes?.changes || 0);

      const nRes = upsertToken.run(
        r.contract_id,
        d.tokenId,
        d.toLower,
        d.toEip55,
        d.isBurned,
        r.block_number,
        r.tx_hash,
        r.log_index,
        r.block_number
      );
      tokensWritten += Number(nRes?.changes || 0);
    }

    return { transfersWritten, tokensWritten };
  });

  let lastId = 0;
  let scanned = 0;
  let totalTransfersWritten = 0;
  let totalTokensWritten = 0;

  try {
    logger.info(
      `[deriveNftStateFromEvents] start chain=${chain || "ALL"} contractId=${contractId ?? "ALL"} streamId=${streamId ?? "ALL"} batch=${batchSize}`
    );
    for (;;) {
      const rows = selBatch.all(...argsBase, lastId, batchSize);
      if (!rows.length) break;

      const { transfersWritten, tokensWritten } = applyBatch(rows);

      scanned += rows.length;
      totalTransfersWritten += transfersWritten;
      totalTokensWritten += tokensWritten;
      lastId = rows[rows.length - 1].id;

      logger.info(
        `[deriveNftStateFromEvents] batch size=${rows.length} scanned=${scanned} transfers_written=${totalTransfersWritten} tokens_written=${totalTokensWritten} last_event_id=${lastId}`
      );
    }

    logger.info(
      `[deriveNftStateFromEvents] DONE scanned=${scanned} transfers_written=${totalTransfersWritten} tokens_written=${totalTokensWritten}`
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  logger.error("[deriveNftStateFromEvents] FATAL:", err);
  process.exitCode = 1;
});
