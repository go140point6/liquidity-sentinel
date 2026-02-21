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
const { syncTransferStreams, listStreams } = require("../utils/indexer/streamRegistry");
const { prepareEventStore } = require("../utils/indexer/eventStore");
const { runWindowedScan } = require("../utils/indexer/windowRunner");

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

function stableLogIndex(lg) {
  if (Number.isInteger(lg?.index) && lg.index >= 0) return lg.index;
  if (Number.isInteger(lg?.logIndex) && lg.logIndex >= 0) return lg.logIndex;
  if (typeof lg?.logIndex === "string") {
    const n = lg.logIndex.startsWith("0x")
      ? Number.parseInt(lg.logIndex, 16)
      : Number.parseInt(lg.logIndex, 10);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}

function decodeTransfer(topics) {
  if (!Array.isArray(topics) || topics.length < 4) return null;
  try {
    const from = ethers.getAddress(`0x${topics[1].slice(26)}`);
    const to = ethers.getAddress(`0x${topics[2].slice(26)}`);
    const tokenId = BigInt(topics[3]).toString();
    return { from, to, tokenId };
  } catch {
    return null;
  }
}

function getRpcUrl(chainId) {
  const cid = String(chainId || "").toUpperCase();
  return requireEnv(`${cid}_MAINNET_SCAN`);
}

function getWindowSize(chainId) {
  const cid = String(chainId || "").toUpperCase();
  const raw = requireEnv(`${cid}_MAINNET_SCAN_BLOCKS`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${cid}_MAINNET_SCAN_BLOCKS must be a positive integer`);
  }
  return n;
}

function getPauseMs(chainId) {
  const cid = String(chainId || "").toUpperCase();
  const raw = requireEnv(`${cid}_MAINNET_SCAN_PAUSE_MS`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${cid}_MAINNET_SCAN_PAUSE_MS must be a non-negative integer`);
  }
  return n;
}

async function main() {
  const DB_PATH = requireEnv("DB_PATH");

  const chain = strArg("chain")?.toUpperCase() || null;
  const kind = strArg("kind")?.toUpperCase() || null;
  const contractKey = strArg("contract-key") || null;
  const streamKey = strArg("stream-key") || null;
  const limit = intArg("limit");
  const overlapRaw = requireEnv("SCAN_OVERLAP_BLOCKS");
  const overlap = Number(overlapRaw);
  if (!Number.isInteger(overlap) || overlap < 0) {
    throw new Error("SCAN_OVERLAP_BLOCKS must be a non-negative integer");
  }
  const overlapBlocks = overlap;

  const db = new Database(DB_PATH);
  initSchema(db);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  try {
    syncTransferStreams(db, { chainId: chain, kind, contractKey });

    let streams = listStreams(db, { chainId: chain, streamKey, isEnabled: 1 }).filter(
      (s) => s.event_name === "Transfer"
    );

    if (contractKey) {
      streams = streams.filter((s) => s.contract_key === contractKey);
    }

    if (Number.isInteger(limit) && limit > 0) {
      streams = streams.slice(0, limit);
    }

    if (!streams.length) {
      logger.info("[indexTail] no streams selected");
      return;
    }

    const providers = {};

    for (const stream of streams) {
      const rpcUrl = getRpcUrl(stream.chain_id);
      const provider = providers[stream.chain_id] || (providers[stream.chain_id] = new ethers.JsonRpcProvider(rpcUrl));
      const store = prepareEventStore(db);

      const streamStart = Number(stream.start_block) || 0;
      const lastScanned = Number(stream.last_scanned_block) || 0;
      const fromBlock = lastScanned > 0
        ? Math.max(streamStart, lastScanned - overlapBlocks)
        : streamStart;
      const toBlock = await provider.getBlockNumber();

      if (fromBlock > toBlock) {
        logger.info(`[indexTail] ${stream.stream_key} nothing to scan`);
        continue;
      }

      const windowSize = getWindowSize(stream.chain_id);
      const pauseMs = getPauseMs(stream.chain_id);
      const totalWindows = Math.ceil((toBlock - fromBlock + 1) / (windowSize + 1));

      logger.info(
        `[indexTail] ${stream.stream_key} scanning ${fromBlock}-${toBlock} windows=${totalWindows} window=${windowSize} overlap=${overlapBlocks}`
      );

      const jobId = store.createJob(stream.id, {
        mode: "TAIL",
        fromBlock,
        toBlock,
      });

      let failed = null;
      let windowIndex = 0;

      await runWindowedScan({
        provider,
        address: ethers.getAddress(stream.address_eip55),
        topic0: stream.topic0,
        fromBlock,
        toBlock,
        windowSize,
        pauseMs,
        onWindowStart: async ({ fromBlock: wb, toBlock: we }) => {
          windowIndex += 1;
          logger.info(
            `[indexTail] ${stream.stream_key} window ${windowIndex}/${totalWindows}: ${wb}-${we} (requesting logs...)`
          );
        },
        onWindow: async ({ ok, logs, error, attempt, elapsedMs, fromBlock: wb, toBlock: we }) => {
          if (!ok) {
            store.recordWindow({
              jobId,
              fromBlock: wb,
              toBlock: we,
              attemptNo: attempt,
              logsFound: 0,
              status: "FAILED",
              errorText: String(error?.message || error || "unknown error"),
              elapsedMs,
            });
            logger.warn(
              `[indexTail] ${stream.stream_key} window ${windowIndex}/${totalWindows} FAILED attempts=${attempt} elapsedMs=${elapsedMs} err=${error?.message || error}`
            );
            failed = error || new Error("window scan failed");
            return;
          }

          const events = [];
          let lastCursor = null;

          for (const lg of logs) {
            const logIndex = stableLogIndex(lg);
            if (logIndex == null || !lg?.transactionHash) continue;

            const decoded = decodeTransfer(lg.topics);
            const decodedJson = decoded ? JSON.stringify(decoded) : null;
            const topic0 = lg?.topics?.[0] || stream.topic0;

            events.push({
              chain_id: stream.chain_id,
              contract_id: stream.contract_id,
              stream_id: stream.id,
              block_number: Number(lg.blockNumber),
              block_hash: lg.blockHash || null,
              tx_hash: String(lg.transactionHash),
              tx_index: lg.transactionIndex == null ? null : Number(lg.transactionIndex),
              log_index: logIndex,
              topic0,
              topics_json: JSON.stringify(lg.topics || []),
              data_hex: lg.data || "0x",
              event_name: stream.event_name,
              decoded_json: decodedJson,
              removed: lg.removed ? 1 : 0,
            });

            if (
              !lastCursor ||
              Number(lg.blockNumber) > lastCursor.blockNumber ||
              (Number(lg.blockNumber) === lastCursor.blockNumber && logIndex > lastCursor.logIndex)
            ) {
              lastCursor = {
                blockNumber: Number(lg.blockNumber),
                logIndex,
                txHash: String(lg.transactionHash),
              };
            }
          }

          store.upsertEvents(events);

          if (lastCursor) {
            store.updateCursor(stream.id, lastCursor);
          } else {
            store.updateCursor(stream.id, {
              blockNumber: we,
              logIndex: null,
              txHash: null,
            });
          }

          store.recordWindow({
            jobId,
            fromBlock: wb,
            toBlock: we,
            attemptNo: attempt,
            logsFound: logs.length,
            status: "OK",
            errorText: null,
            elapsedMs,
          });
          logger.debug(
            `[indexTail] ${stream.stream_key} window ${windowIndex}/${totalWindows} OK logs=${logs.length} attempts=${attempt} elapsedMs=${elapsedMs}`
          );
        },
      });

      if (failed) {
        store.markJobFailed(jobId, String(failed?.message || failed));
        logger.warn(`[indexTail] ${stream.stream_key} FAILED: ${failed?.message || failed}`);
      } else {
        store.markJobDone(jobId);
        const cursor = store.getCursor(stream.id);
        logger.info(
          `[indexTail] ${stream.stream_key} DONE cursor=${cursor?.last_scanned_block}:${cursor?.last_scanned_log_index ?? "-"}`
        );
      }
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  logger.error("[indexTail] FATAL:", err);
  process.exitCode = 1;
});
