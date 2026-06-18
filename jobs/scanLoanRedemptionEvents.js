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
const troveNftAbi = require("../abi/troveNFT.json");
const troveManagerAbi = require("../abi/troveManager.json");
const erc20MetadataAbi = require("../abi/erc20Metadata.json");
const {
  sleep,
  getLogsWithRetry,
  getBlockNumberWithRetry,
} = require("../utils/indexer/windowRunner");

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var ${name}`);
  return String(v).trim();
}

function requireIntEnv(name, { min = 0 } = {}) {
  const raw = requireEnv(name);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`Env var ${name} must be an integer >= ${min} (got "${raw}")`);
  }
  return n;
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

const DB_PATH = requireEnv("DB_PATH");
const OVERLAP_BLOCKS = requireIntEnv("SCAN_OVERLAP_BLOCKS", { min: 0 });
const BOOTSTRAP_LOOKBACK_BLOCKS = requireIntEnv(
  "LOAN_REDEMPTION_EVENT_BOOTSTRAP_LOOKBACK_BLOCKS",
  { min: 0 }
);

function rpcUrlForChain(chainId) {
  return requireEnv(`${String(chainId || "").toUpperCase()}_MAINNET_SCAN`);
}

function windowSizeForChain(chainId) {
  return requireIntEnv(`${String(chainId || "").toUpperCase()}_MAINNET_SCAN_BLOCKS`, { min: 1 });
}

function pauseMsForChain(chainId) {
  return requireIntEnv(`${String(chainId || "").toUpperCase()}_MAINNET_SCAN_PAUSE_MS`, { min: 0 });
}

function selectLoanContracts(db, { chainId = null, contractKey = null, limit = null } = {}) {
  const where = ["c.is_enabled = 1", "c.kind = 'LOAN_NFT'"];
  const args = [];

  if (chainId) {
    where.push("c.chain_id = ?");
    args.push(String(chainId).toUpperCase());
  }
  if (contractKey) {
    where.push("c.contract_key = ?");
    args.push(String(contractKey));
  }

  let sql = `
    SELECT
      c.id AS contract_id,
      c.chain_id,
      c.contract_key,
      c.protocol,
      c.address_eip55,
      c.default_start_block
    FROM contracts c
    WHERE ${where.join(" AND ")}
    ORDER BY c.chain_id, c.contract_key
  `;

  if (Number.isInteger(limit) && limit > 0) {
    sql += ` LIMIT ${limit}`;
  }

  return db.prepare(sql).all(...args);
}

function getStableLogIndex(lg) {
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

function normalizeAddress(addr) {
  const eip55 = ethers.getAddress(addr);
  return { eip55, lower: eip55.toLowerCase() };
}

function amountNum(raw, decimals) {
  if (raw == null) return null;
  const n = Number(ethers.formatUnits(raw, decimals));
  return Number.isFinite(n) ? n : null;
}

function pickClosestByLogIndex(rows, targetLogIndex) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let best = rows[0];
  let bestDist = Math.abs(Number(rows[0].logIndex) - Number(targetLogIndex));
  for (const row of rows.slice(1)) {
    const dist = Math.abs(Number(row.logIndex) - Number(targetLogIndex));
    if (dist < bestDist) {
      best = row;
      bestDist = dist;
    }
  }
  return best;
}

async function getBlockTimestampCached(provider, cache, blockNumber) {
  const key = Number(blockNumber);
  if (cache.has(key)) return cache.get(key);

  let attempt = 0;
  let backoffMs = 750;
  while (attempt < 6) {
    attempt += 1;
    try {
      const block = await provider.getBlock(key);
      const ts = block?.timestamp == null ? null : Number(block.timestamp);
      cache.set(key, Number.isFinite(ts) ? ts : null);
      return cache.get(key);
    } catch (err) {
      const msg = String(err?.message || "");
      const retryAfterMatch = msg.match(/retry in\s+(\d+)\s*s/i);
      const retryAfterMs = retryAfterMatch ? Number(retryAfterMatch[1]) * 1000 : null;
      const rateLimited =
        /rate limit|too many requests/i.test(msg) || msg.includes("-32090");
      if ((!rateLimited && retryAfterMs == null) || attempt >= 6) throw err;
      await sleep(retryAfterMs ?? backoffMs);
      backoffMs = Math.min(backoffMs * 2, 10000);
    }
  }

  return null;
}

function getCursor(db, contractId) {
  return db
    .prepare(
      `
      SELECT
        contract_id,
        trove_manager_lower,
        trove_manager_eip55,
        start_block,
        last_scanned_block,
        last_scanned_at
      FROM loan_redemption_event_cursors
      WHERE contract_id = ?
      LIMIT 1
    `
    )
    .get(contractId);
}

function ensureCursor(db, { contractId, troveManager, startBlock }) {
  db.prepare(
    `
    INSERT INTO loan_redemption_event_cursors (
      contract_id,
      trove_manager_lower,
      trove_manager_eip55,
      start_block,
      last_scanned_block,
      last_scanned_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, datetime('now'), datetime('now'))
    ON CONFLICT(contract_id) DO UPDATE SET
      trove_manager_lower = excluded.trove_manager_lower,
      trove_manager_eip55 = excluded.trove_manager_eip55,
      start_block = MIN(loan_redemption_event_cursors.start_block, excluded.start_block),
      updated_at = datetime('now')
  `
  ).run(
    contractId,
    troveManager.lower,
    troveManager.eip55,
    startBlock,
    Math.max(0, startBlock - 1)
  );
}

function updateCursor(db, contractId, lastScannedBlock) {
  db.prepare(
    `
    UPDATE loan_redemption_event_cursors
    SET last_scanned_block = ?, last_scanned_at = datetime('now'), updated_at = datetime('now')
    WHERE contract_id = ?
  `
  ).run(lastScannedBlock, contractId);
}

function insertEvents(db, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const stmt = db.prepare(
    `
    INSERT INTO loan_redemption_events (
      chain_id,
      contract_id,
      protocol,
      trove_manager_lower,
      trove_manager_eip55,
      trove_id,
      coll_symbol,
      block_number,
      block_timestamp,
      tx_hash,
      fee_log_index,
      trove_operation_log_index,
      trove_updated_log_index,
      interest_rate_pct,
      pre_debt,
      post_debt,
      redeemed_debt,
      pre_coll,
      post_coll,
      redeemed_coll,
      fee_coll,
      event_json,
      created_at
    ) VALUES (
      @chain_id,
      @contract_id,
      @protocol,
      @trove_manager_lower,
      @trove_manager_eip55,
      @trove_id,
      @coll_symbol,
      @block_number,
      @block_timestamp,
      @tx_hash,
      @fee_log_index,
      @trove_operation_log_index,
      @trove_updated_log_index,
      @interest_rate_pct,
      @pre_debt,
      @post_debt,
      @redeemed_debt,
      @pre_coll,
      @post_coll,
      @redeemed_coll,
      @fee_coll,
      @event_json,
      datetime('now')
    )
    ON CONFLICT(contract_id, tx_hash, fee_log_index) DO UPDATE SET
      protocol = excluded.protocol,
      trove_manager_lower = excluded.trove_manager_lower,
      trove_manager_eip55 = excluded.trove_manager_eip55,
      trove_id = excluded.trove_id,
      coll_symbol = excluded.coll_symbol,
      block_number = excluded.block_number,
      block_timestamp = excluded.block_timestamp,
      trove_operation_log_index = excluded.trove_operation_log_index,
      trove_updated_log_index = excluded.trove_updated_log_index,
      interest_rate_pct = excluded.interest_rate_pct,
      pre_debt = excluded.pre_debt,
      post_debt = excluded.post_debt,
      redeemed_debt = excluded.redeemed_debt,
      pre_coll = excluded.pre_coll,
      post_coll = excluded.post_coll,
      redeemed_coll = excluded.redeemed_coll,
      fee_coll = excluded.fee_coll,
      event_json = excluded.event_json
  `
  );

  const tx = db.transaction((items) => {
    let writes = 0;
    for (const row of items) {
      const res = stmt.run(row);
      writes += Number(res?.changes || 0);
    }
    return writes;
  });

  return tx(rows);
}

async function resolveLoanContext(provider, contractAddress) {
  const troveNft = new ethers.Contract(contractAddress, troveNftAbi, provider);
  const [troveManagerAddr, collTokenAddr] = await Promise.all([
    troveNft.troveManager(),
    troveNft.collToken(),
  ]);
  const collToken = new ethers.Contract(collTokenAddr, erc20MetadataAbi, provider);
  const [collDecimals, collSymbol] = await Promise.all([collToken.decimals(), collToken.symbol()]);
  return {
    troveManager: normalizeAddress(troveManagerAddr),
    collDecimals: Number(collDecimals),
    collSymbol: String(collSymbol || ""),
  };
}

async function scanContract(db, provider, contractRow) {
  const { contract_id: contractId, chain_id: chainId, contract_key: contractKey, protocol } = contractRow;
  const ctx = await resolveLoanContext(provider, contractRow.address_eip55);
  const headRes = await getBlockNumberWithRetry(provider);
  if (!headRes.ok) {
    throw new Error(
      `${contractKey} head block fetch failed after ${headRes.attempt} attempts: ${headRes.error?.message || headRes.error}`
    );
  }
  const latestBlock = Number(headRes.blockNumber);
  const bootstrapStart = Math.max(
    Number(contractRow.default_start_block) || 0,
    latestBlock - BOOTSTRAP_LOOKBACK_BLOCKS
  );

  if (!getCursor(db, contractId)) {
    ensureCursor(db, {
      contractId,
      troveManager: ctx.troveManager,
      startBlock: bootstrapStart,
    });
  }

  const cursor = getCursor(db, contractId);
  const startBlock = Math.max(0, Number(cursor?.start_block) || bootstrapStart);
  const fromBlock =
    Number(cursor?.last_scanned_block) > 0
      ? Math.max(startBlock, Number(cursor.last_scanned_block) - OVERLAP_BLOCKS)
      : startBlock;

  if (fromBlock > latestBlock) {
    logger.info(`[scanLoanRedemptionEvents] ${contractKey} nothing to scan`);
    return;
  }

  const iface = new ethers.Interface(troveManagerAbi);
  const feeTopic = iface.getEvent("RedemptionFeePaidToTrove").topicHash;
  const opTopic = iface.getEvent("TroveOperation").topicHash;
  const updTopic = iface.getEvent("TroveUpdated").topicHash;
  const topicFilter = [[feeTopic, opTopic, updTopic]];
  const windowSize = windowSizeForChain(chainId);
  const pauseMs = pauseMsForChain(chainId);
  const totalWindows = Math.ceil((latestBlock - fromBlock + 1) / (windowSize + 1));
  const blockTimestampCache = new Map();
  let windowIndex = 0;
  let totalEvents = 0;

  logger.info(
    `[scanLoanRedemptionEvents] ${contractKey} scanning ${fromBlock}-${latestBlock} windows=${totalWindows} window=${windowSize} overlap=${OVERLAP_BLOCKS}`
  );

  for (let start = fromBlock; start <= latestBlock; start += windowSize + 1) {
    const end = Math.min(latestBlock, start + windowSize);
    windowIndex += 1;
    logger.info(
      `[scanLoanRedemptionEvents] ${contractKey} window ${windowIndex}/${totalWindows}: ${start}-${end} (requesting logs...)`
    );

    const res = await getLogsWithRetry(
      provider,
      {
        address: ctx.troveManager.eip55,
        fromBlock: start,
        toBlock: end,
        topics: topicFilter,
      },
      { maxAttempts: 6 }
    );

    if (!res.ok) {
      logger.warn(
        `[scanLoanRedemptionEvents] ${contractKey} window ${windowIndex}/${totalWindows} FAILED attempts=${res.attempt} err=${res.error?.message || res.error}`
      );
      break;
    }

    const buckets = new Map();
    for (const lg of res.logs || []) {
      const logIndex = getStableLogIndex(lg);
      if (logIndex == null || !lg?.transactionHash) continue;

      let parsed;
      try {
        parsed = iface.parseLog({ topics: lg.topics, data: lg.data });
      } catch {
        continue;
      }

      const troveIdRaw = parsed?.args?._troveId;
      const troveId = troveIdRaw == null ? null : BigInt(troveIdRaw).toString();
      if (!troveId) continue;

      const key = `${String(lg.transactionHash).toLowerCase()}:${troveId}`;
      if (!buckets.has(key)) {
        buckets.set(key, { troveId, txHash: String(lg.transactionHash), fees: [], ops: [], updates: [] });
      }
      const bucket = buckets.get(key);
      const item = {
        blockNumber: Number(lg.blockNumber),
        logIndex,
        txHash: String(lg.transactionHash),
        parsed,
      };

      if (parsed.name === "RedemptionFeePaidToTrove") bucket.fees.push(item);
      if (parsed.name === "TroveOperation") bucket.ops.push(item);
      if (parsed.name === "TroveUpdated") bucket.updates.push(item);
    }

    const rows = [];
    for (const bucket of buckets.values()) {
      if (!bucket.fees.length) continue;
      bucket.fees.sort((a, b) => a.logIndex - b.logIndex);
      bucket.ops.sort((a, b) => a.logIndex - b.logIndex);
      bucket.updates.sort((a, b) => a.logIndex - b.logIndex);

      for (const fee of bucket.fees) {
        const op = pickClosestByLogIndex(bucket.ops, fee.logIndex);
        const upd = pickClosestByLogIndex(bucket.updates, fee.logIndex);
        if (!op) {
          logger.warn(
            `[scanLoanRedemptionEvents] ${contractKey} tx=${fee.txHash} trove=${bucket.troveId} skipped: missing TroveOperation`
          );
          continue;
        }

        const opArgs = op.parsed.args;
        const updArgs = upd?.parsed?.args || null;
        const debtChange = amountNum(opArgs?._debtChangeFromOperation, 18);
        const collChange = amountNum(opArgs?._collChangeFromOperation, ctx.collDecimals);
        const debtIncreaseFromRedist = amountNum(opArgs?._debtIncreaseFromRedist, 18);
        const debtIncreaseFromUpfrontFee = amountNum(opArgs?._debtIncreaseFromUpfrontFee, 18);
        const collIncreaseFromRedist = amountNum(opArgs?._collIncreaseFromRedist, ctx.collDecimals);
        const interestRatePctRaw = amountNum(opArgs?._annualInterestRate, 18);
        const interestRatePct =
          interestRatePctRaw == null ? null : interestRatePctRaw * 100;
        const redeemedDebt =
          debtChange != null && debtChange < 0 ? Math.abs(debtChange) : 0;
        const redeemedColl =
          collChange != null && collChange < 0 ? Math.abs(collChange) : 0;
        const postDebt = amountNum(updArgs?._debt, 18);
        const postColl = amountNum(updArgs?._coll, ctx.collDecimals);
        const feeColl = amountNum(fee.parsed.args?._ETHFee, ctx.collDecimals);
        const preDebt =
          postDebt == null ||
          debtChange == null ||
          debtIncreaseFromRedist == null ||
          debtIncreaseFromUpfrontFee == null
            ? null
            : postDebt - debtIncreaseFromRedist - debtIncreaseFromUpfrontFee - debtChange;
        const preColl =
          postColl == null || collChange == null || collIncreaseFromRedist == null
            ? null
            : postColl - collIncreaseFromRedist - collChange;

        if (!(redeemedDebt > 0 || redeemedColl > 0)) {
          logger.debug(
            `[scanLoanRedemptionEvents] ${contractKey} tx=${fee.txHash} trove=${bucket.troveId} skipped: non-redemptive deltas`
          );
          continue;
        }

        const blockTimestamp = await getBlockTimestampCached(provider, blockTimestampCache, fee.blockNumber);
        rows.push({
          chain_id: chainId,
          contract_id: contractId,
          protocol,
          trove_manager_lower: ctx.troveManager.lower,
          trove_manager_eip55: ctx.troveManager.eip55,
          trove_id: bucket.troveId,
          coll_symbol: ctx.collSymbol || null,
          block_number: fee.blockNumber,
          block_timestamp: blockTimestamp,
          tx_hash: fee.txHash,
          fee_log_index: fee.logIndex,
          trove_operation_log_index: op.logIndex,
          trove_updated_log_index: upd?.logIndex ?? null,
          interest_rate_pct: interestRatePct,
          pre_debt: preDebt,
          post_debt: postDebt,
          redeemed_debt: redeemedDebt,
          pre_coll: preColl,
          post_coll: postColl,
          redeemed_coll: redeemedColl,
          fee_coll: feeColl,
          event_json: JSON.stringify({
            txHash: fee.txHash,
            troveId: bucket.troveId,
            blockNumber: fee.blockNumber,
            blockTimestamp,
            feeLogIndex: fee.logIndex,
            troveOperationLogIndex: op.logIndex,
            troveUpdatedLogIndex: upd?.logIndex ?? null,
            interestRatePct,
            debtChangeFromOperation: debtChange,
            collChangeFromOperation: collChange,
            debtIncreaseFromRedist,
            debtIncreaseFromUpfrontFee,
            collIncreaseFromRedist,
            redeemedDebt,
            redeemedColl,
            feeColl,
            preDebt,
            postDebt,
            preColl,
            postColl,
            collSymbol: ctx.collSymbol || null,
          }),
        });
      }
    }

    const writes = insertEvents(db, rows);
    totalEvents += rows.length;
    updateCursor(db, contractId, end);
    logger.debug(
      `[scanLoanRedemptionEvents] ${contractKey} window ${windowIndex}/${totalWindows} OK logs=${res.logs.length} events=${rows.length} writes=${writes}`
    );

    if (pauseMs > 0) {
      await sleep(pauseMs);
    }
  }

  const cursorAfter = getCursor(db, contractId);
  logger.info(
    `[scanLoanRedemptionEvents] ${contractKey} DONE cursor=${cursorAfter?.last_scanned_block ?? "-"} events=${totalEvents}`
  );
}

async function main() {
  const t0 = Date.now();
  const chain = strArg("chain")?.toUpperCase() || null;
  const contractKey = strArg("contract-key") || null;
  const limit = intArg("limit");

  const db = new Database(DB_PATH);
  initSchema(db);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  try {
    const rows = selectLoanContracts(db, { chainId: chain, contractKey, limit });
    if (!rows.length) {
      logger.info("[scanLoanRedemptionEvents] no loan contracts selected");
      return;
    }

    const providers = {};
    for (const row of rows) {
      const chainId = String(row.chain_id || "").toUpperCase();
      const provider =
        providers[chainId] || (providers[chainId] = new ethers.JsonRpcProvider(rpcUrlForChain(chainId)));
      await scanContract(db, provider, row);
    }
  } finally {
    db.close();
    const elapsed = Date.now() - t0;
    logger.info(`[scanLoanRedemptionEvents] done (elapsed ${elapsed} ms)`);
  }
}

main().catch((err) => {
  logger.error("[scanLoanRedemptionEvents] FATAL:", err);
  process.exitCode = 1;
});
