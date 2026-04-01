const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const { ethers } = require("ethers");

const stabilityPoolAbi = require("../abi/stabilityPool.json");
const { getDb } = require("../db");
const { getProviderForChain } = require("../utils/ethers/providers");
const baseLogger = require("../utils/logger");
const logger = baseLogger.forEnv("SCAN_DEBUG");
const { getStabilityPoolsForChain } = require("../utils/stabilityPoolConfig");
const {
  fetchJsonWithTimeout,
  getAprRowsFromJson,
  getPoolShortLabel,
} = require("../utils/stabilityPoolSignals");

const CHAINS_CONFIG = {
  FLR: { rpcEnvKey: "FLR_MAINNET" },
};

function requireEnv(name) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) throw new Error(`Missing env var ${name}`);
  return String(raw).trim();
}

function requireNumberEnv(name) {
  const raw = requireEnv(name);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive number (got "${raw}")`);
  }
  return Math.floor(n);
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function computeIndexValue(scaleBValue, pValue) {
  if (pValue <= 0n) return null;
  const scaled = (scaleBValue * 1000000n) / pValue;
  return Number(scaled) / 1000000;
}

async function collectForChain(chainId) {
  const cid = String(chainId || "").toUpperCase();
  const pools = getStabilityPoolsForChain(cid);
  if (!pools.length) {
    logger.info(`[sp-snapshot] No configured pools for ${cid}; nothing to do.`);
    return { saved: 0, failed: 0 };
  }

  const rpcTimeoutMs = requireNumberEnv("SP_SNAPSHOT_RPC_TIMEOUT_MS");
  const jsonTimeoutMs = requireNumberEnv("SP_SNAPSHOT_JSON_TIMEOUT_MS");
  const globalIrUrl = requireEnv("GLOBAL_IR_URL");

  const provider = getProviderForChain(cid, CHAINS_CONFIG);
  const aprJson = await fetchJsonWithTimeout(globalIrUrl, jsonTimeoutMs);
  const aprRows = getAprRowsFromJson(cid, aprJson);
  const aprByKey = new Map(aprRows.map((row) => [row.key, row]));

  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO sp_apr_snapshots (
      chain_id,
      pool_key,
      pool_address,
      pool_label,
      coll_symbol,
      total_bold_deposits,
      total_bold_deposits_num,
      current_scale,
      p_value,
      scale_b_value,
      index_value,
      apr_24h_pct,
      fee_24h_pct,
      aps_24h_pct,
      rflr_24h_pct
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let saved = 0;
  let failed = 0;

  for (const pool of pools) {
    const contract = new ethers.Contract(pool.address, stabilityPoolAbi, provider);
    try {
      const totalBoldDeposits = await withTimeout(
        contract.getTotalBoldDeposits(),
        rpcTimeoutMs,
        `${pool.key}.getTotalBoldDeposits`
      );
      const currentScale = await withTimeout(
        contract.currentScale(),
        rpcTimeoutMs,
        `${pool.key}.currentScale`
      );
      const pValue = await withTimeout(contract.P(), rpcTimeoutMs, `${pool.key}.P`);
      const scaleBValue = await withTimeout(
        contract.scaleToB(currentScale),
        rpcTimeoutMs,
        `${pool.key}.scaleToB`
      );

      const apr = aprByKey.get(pool.key) || null;
      const totalBoldDepositsNum = Number(ethers.formatUnits(totalBoldDeposits, 18));
      const indexValue = computeIndexValue(scaleBValue, pValue);

      insert.run(
        cid,
        pool.key,
        pool.address,
        pool.label,
        pool.collSymbol || getPoolShortLabel(pool),
        totalBoldDeposits.toString(),
        totalBoldDepositsNum,
        currentScale.toString(),
        pValue.toString(),
        scaleBValue.toString(),
        Number.isFinite(indexValue) ? indexValue : null,
        Number.isFinite(apr?.apr24hPct) ? apr.apr24hPct : null,
        Number.isFinite(apr?.fee24hPct) ? apr.fee24hPct : null,
        Number.isFinite(apr?.aps24hPct) ? apr.aps24hPct : null,
        Number.isFinite(apr?.rflr24hPct) ? apr.rflr24hPct : null
      );

      saved += 1;
      logger.info(
        `[sp-snapshot] saved ${cid} ${pool.key} size=${totalBoldDepositsNum.toFixed(2)} apr=${
          Number.isFinite(apr?.apr24hPct) ? apr.apr24hPct.toFixed(2) : "n/a"
        }`
      );
    } catch (err) {
      failed += 1;
      logger.error(`[sp-snapshot] failed ${cid} ${pool.key}: ${err?.message || err}`);
    }
  }

  return { saved, failed };
}

async function main() {
  logger.info("[sp-snapshot] Starting stability-pool snapshot collection...");
  const started = Date.now();
  const result = await collectForChain("FLR");
  const elapsed = Date.now() - started;
  logger.info(
    `[sp-snapshot] Done saved=${result.saved} failed=${result.failed} elapsedMs=${elapsed}`
  );
  if (!result.saved) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error(`[sp-snapshot] FATAL: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
